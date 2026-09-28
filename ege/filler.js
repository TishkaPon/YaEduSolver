/*
 * filler.js — заполнение полей ответа на страницах ЕГЭ.
 *
 * DOM (из реальных страниц):
 *   одна строка:  form[data-testid="TaskTextinputAnswerForm"] input.Textinput-Control
 *   таблица:      table[data-testid="TableAnswer"] input[data-testid="TableAnswer-cell-N"]
 *
 * Значения берутся из correct_answers задания и раскладываются по полям
 * построчно (row-major). Для React используется нативный setter + события.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.EGEFiller = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function isObject(value) {
    return value !== null && typeof value === 'object';
  }

  /* ---------- значения ответа ---------- */

  function flattenRaw(value, out) {
    if (value === null || value === undefined) return out;
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) flattenRaw(value[i], out);
      return out;
    }
    if (typeof value === 'string') {
      var text = value.trim();
      if (text !== '') out.push(text);
      return out;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      out.push(String(value));
      return out;
    }
    if (isObject(value) && typeof value.text === 'string') {
      var t = value.text.trim();
      if (t !== '') out.push(t);
    }
    return out;
  }

  /** Плоский список значений для полей ввода (построчно). */
  function flattenAnswers(task) {
    var out = [];
    var answers = (task && task.answers) || [];
    answers.forEach(function (entry) { flattenRaw(entry && entry.raw, out); });
    if (!out.length) {
      answers.forEach(function (entry) {
        if (entry && typeof entry.text === 'string' && entry.text.trim() !== '') out.push(entry.text.trim());
      });
    }
    return out;
  }

  /* ---------- поиск полей ---------- */

  function findPanel(doc) {
    var d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d) return null;
    return d.querySelector('section[aria-label="Панель ответа"]') ||
      d.querySelector('[aria-label="Панель ответа"]');
  }

  function cellNumber(el) {
    var attr = (el && el.getAttribute) ? (el.getAttribute('data-testid') || '') : '';
    var match = attr.match(/TableAnswer-cell-(\d+)/);
    return match ? Number(match[1]) : null;
  }

  function isEditable(el) {
    if (!el || !el.tagName) return false;
    if (el.disabled || el.readOnly) return false;
    if (typeof el.closest === 'function' && el.closest('[class*="A11yHidden"]')) return false;
    var tag = String(el.tagName).toLowerCase();
    if (tag === 'input') {
      var type = String(el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden' || type === 'checkbox' || type === 'radio' ||
        type === 'submit' || type === 'button' || type === 'file') return false;
      var style = null;
      try {
        var win = el.ownerDocument && el.ownerDocument.defaultView;
        style = win ? win.getComputedStyle(el) : null;
      } catch (e) {}
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
      return true;
    }
    if (tag === 'textarea') return true;
    if (el.getAttribute('contenteditable') === 'true') return true;
    return false;
  }

  function collectInputs(panel) {
    if (!panel || !panel.querySelectorAll) return [];
    var cells = Array.prototype.slice.call(panel.querySelectorAll('input[data-testid^="TableAnswer-cell-"]'));
    if (cells.length) {
      cells.sort(function (a, b) { return cellNumber(a) - cellNumber(b); });
      return cells;
    }
    return Array.prototype.slice
      .call(panel.querySelectorAll('input, textarea, [contenteditable="true"]'))
      .filter(isEditable);
  }

  /* ---------- установка значения ---------- */

  function fireEvents(el) {
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
    try { el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' })); } catch (e) {}
  }

  function setNativeValue(el, value) {
    if (!el) return false;
    var tag = String(el.tagName).toLowerCase();
    var richEditable = el.getAttribute('contenteditable') === 'true' && tag !== 'input' && tag !== 'textarea';
    if (richEditable) {
      el.textContent = value;
      fireEvents(el);
      return true;
    }
    var proto = null;
    try {
      if (typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement) {
        proto = HTMLTextAreaElement.prototype;
      } else if (typeof HTMLInputElement !== 'undefined') {
        proto = HTMLInputElement.prototype;
      }
    } catch (e) { proto = null; }
    if (proto) {
      try {
        var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, value);
      } catch (e) {
        try { el.value = value; } catch (e2) { return false; }
      }
    } else {
      try { el.value = value; } catch (e3) { return false; }
    }
    fireEvents(el);
    return true;
  }

  /* ---------- заполнение ---------- */

  function fillAnswerPanel(values, doc) {
    var panel = findPanel(doc);
    if (!panel) return { ok: false, error: 'панель ответа не найдена', filled: 0, total: 0 };
    var inputs = collectInputs(panel);
    if (!inputs.length) return { ok: false, error: 'поля ответа не найдены', filled: 0, total: 0 };
    var filled = 0;
    for (var i = 0; i < inputs.length && i < values.length; i++) {
      if (setNativeValue(inputs[i], values[i])) filled++;
    }
    return { ok: true, filled: filled, total: inputs.length, values: values.length };
  }

  function fillTask(task, doc) {
    return fillAnswerPanel(flattenAnswers(task), doc);
  }

  /* ---------- кнопки сохранения и перехода ---------- */

  function textOf(el) {
    return String((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
  }

  function isHidden(el) {
    if (!el) return true;
    try {
      if (typeof el.closest === 'function') {
        if (el.closest('[aria-hidden="true"]')) return true;
        if (el.closest('[class*="next_button_hidden"]')) return true;
      }
    } catch (e) {}
    var style = null;
    try {
      var win = el.ownerDocument && el.ownerDocument.defaultView;
      style = win ? win.getComputedStyle(el) : null;
    } catch (e) {}
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return true;
    try {
      if (el.getClientRects && el.getClientRects().length === 0) return true;
    } catch (e) {}
    return false;
  }

  /** Кнопка «Сохранить ответ» на панели ответа. */
  function findSaveButton(doc) {
    var scope = findPanel(doc) || doc || (typeof document !== 'undefined' ? document : null);
    if (!scope || !scope.querySelectorAll) return null;
    var buttons = Array.prototype.slice.call(scope.querySelectorAll('button'));
    for (var i = 0; i < buttons.length; i++) {
      var label = textOf(buttons[i]).toLowerCase();
      if (label.indexOf('сохранить') !== -1 && label.indexOf('очист') === -1) return buttons[i];
    }
    return null;
  }

  /** Большая кнопка «Следующее задание» (появляется после проверки ответа). */
  function findBigNextButton(doc) {
    var d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.querySelectorAll) return null;
    var buttons = Array.prototype.slice.call(d.querySelectorAll('button'));
    for (var i = 0; i < buttons.length; i++) {
      if (textOf(buttons[i]).toLowerCase() === 'следующее задание' && !isHidden(buttons[i])) return buttons[i];
    }
    return null;
  }

  /** Кнопка «вперёд» в пагинаторе заданий. */
  function findPaginatorNext(doc) {
    var d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.querySelector) return null;
    var button = d.querySelector('button[data-testid="GpttrPaginatorButtonNext"]');
    if (!button || button.disabled || isHidden(button)) return null;
    return button;
  }

  function nextButton(doc) {
    return findBigNextButton(doc) || findPaginatorNext(doc);
  }

  function clickElement(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    try { el.click(); } catch (e) { return false; }
    return true;
  }

  /** Признак того, что ответ сохранён/проверен. */
  function isSaveSettled(doc) {
    var d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d) return true;
    if (findBigNextButton(d)) return true;
    var panel = findPanel(d);
    if (panel) {
      var text = textOf(panel).toLowerCase();
      if (text.indexOf('верно') !== -1 || text.indexOf('неверн') !== -1 || text.indexOf('ответ сохран') !== -1) return true;
    }
    var button = findSaveButton(d);
    if (!button) return true;
    var label = textOf(button).toLowerCase();
    if (label.indexOf('сохран') !== -1 && label.indexOf('сохранить') === -1) return true;
    return false;
  }

  return {
    flattenRaw: flattenRaw,
    flattenAnswers: flattenAnswers,
    findPanel: findPanel,
    collectInputs: collectInputs,
    isEditable: isEditable,
    setNativeValue: setNativeValue,
    fillAnswerPanel: fillAnswerPanel,
    fillTask: fillTask,
    textOf: textOf,
    isHidden: isHidden,
    findSaveButton: findSaveButton,
    findBigNextButton: findBigNextButton,
    findPaginatorNext: findPaginatorNext,
    nextButton: nextButton,
    clickElement: clickElement,
    isSaveSettled: isSaveSettled
  };
});

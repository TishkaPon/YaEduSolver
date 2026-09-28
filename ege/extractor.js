/*
 * extractor.js — чистые функции разбора данных Яндекс Учебника.
 *
 * Работает и в браузере (window.EGEAnswers), и в Node (module.exports),
 * поэтому его можно прогонять тестом на реальном HAR.
 *
 * Формат ответа POST /api/v5/gpttr (public_get_variant_request_item):
 *   { title, id, exam_type, tasks: [ { number, id, markup: {
 *       layout: [...],
 *       answer_control_layout: [ { kind: "marker", content: {
 *           type: "text_match" | "table_match" | "ege_two_inputs_match" | "ege_four_inputs_match",
 *           correct_answers: ... } } ] } } ] }
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.EGEAnswers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var hasOwn = Object.prototype.hasOwnProperty;

  function isObject(value) {
    return value !== null && typeof value === 'object';
  }

  /* ---------- рекурсивный обход дерева ---------- */

  function walk(node, visit, depth) {
    if (depth > 16) return;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) walk(node[i], visit, depth + 1);
      return;
    }
    if (!isObject(node)) return;
    visit(node);
    for (var key in node) {
      if (!hasOwn.call(node, key)) continue;
      var value = node[key];
      if (isObject(value) || Array.isArray(value)) walk(value, visit, depth + 1);
    }
  }

  /* ---------- приведение ответа к читаемому тексту ---------- */

  function scalar(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
      return value.map(scalar).filter(function (part) { return part !== ''; }).join(' ');
    }
    if (isObject(value)) {
      if (typeof value.text === 'string') return value.text.trim();
      if (typeof value.value === 'string') return value.value.trim();
    }
    return '';
  }

  /**
   * correct_answers может быть:
   *   "17"                                 -> "17"
   *   ["1806992450", "984"]                -> "1806992450 984"
   *   [["6", "189930 "]]                   -> "6 189930"
   *   [["11593","66776"],["398","278"]]    -> "11593 66776\n398 278"
   */
  function formatCorrectAnswers(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
      if (!value.length) return '';
      var isTable = value.every(function (item) { return Array.isArray(item); });
      if (isTable) {
        // Несколько частей ответа — каждая с новой строки.
        return value
          .map(function (row) { return row.map(scalar).filter(Boolean).join(' '); })
          .filter(function (row) { return row !== ''; })
          .join('\n');
      }
      return value.map(scalar).filter(Boolean).join(' ');
    }
    if (isObject(value) && typeof value.text === 'string') return value.text.trim();
    return '';
  }

  /* ---------- разбор одного задания ---------- */

  function answerEntries(task) {
    var entries = [];
    var markup = task.markup;
    if (isObject(markup) && Array.isArray(markup.answer_control_layout)) {
      markup.answer_control_layout.forEach(function (control) {
        var content = control && control.content;
        if (isObject(content) && hasOwn.call(content, 'correct_answers')) {
          entries.push({
            type: content.type || '',
            raw: content.correct_answers,
            text: formatCorrectAnswers(content.correct_answers)
          });
        }
      });
    }
    if (!entries.length && hasOwn.call(task, 'correct_answers')) {
      entries.push({
        type: task.type || '',
        raw: task.correct_answers,
        text: formatCorrectAnswers(task.correct_answers)
      });
    }
    return entries.filter(function (entry) { return entry.raw !== undefined && entry.raw !== null; });
  }

  function stripHtml(text) {
    return String(text || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;|&#160;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  function taskPreview(task) {
    var parts = [];
    var layout = isObject(task.markup) ? task.markup.layout : null;
    walk(layout, function (node) {
      if (typeof node.text === 'string' && node.text) parts.push(node.text);
    }, 0);
    var text = stripHtml(parts.join(' '));
    return text.length > 180 ? text.slice(0, 177) + '…' : text;
  }

  function collectTasks(payload) {
    var seenIds = {};
    var found = [];
    walk(payload, function (node) {
      // Заданием считается только объект с markup; иначе служебный
      // content маркера (correct_answers) тоже попал бы в список.
      if (!isObject(node.markup)) return;
      var entries = answerEntries(node);
      if (!entries.length) return;
      var number = node.number;
      if (number === undefined || number === null || number === '') number = null;
      var id = node.id || (number !== null ? 'n:' + number : null);
      if (!id) return;
      var key = String(id);
      if (seenIds[key]) return;
      seenIds[key] = true;
      found.push({
        id: key,
        number: number,
        usrNumber: node.number === undefined ? null : node.number,
        categoryId: node.category_id || '',
        categoryTitle: node.category_title || '',
        type: entries[0].type,
        answers: entries,
        preview: taskPreview(node)
      });
    }, 0);
    return found;
  }

  function sortByNumber(tasks) {
    return tasks.slice().sort(function (a, b) {
      var an = Number(a.number);
      var bn = Number(b.number);
      var aok = a.number !== null && isFinite(an);
      var bok = b.number !== null && isFinite(bn);
      if (aok && bok && an !== bn) return an - bn;
      if (aok && !bok) return -1;
      if (!aok && bok) return 1;
      return 0;
    });
  }

  /**
   * Порядок заданий = порядок элементов в массиве tasks. Именно так их
   * показывает страница: элемент tasks[N-1] открывается по адресу /task/N.
   * Поле number — это метаданные (номер/тип на бланке ЕГЭ), оно может
   * повторяться или идти не по порядку, поэтому для позиции не используется.
   */
  function buildReport(payload, url) {
    var pageUrl = url || '';
    var tasks = collectTasks(payload);
    if (!tasks.length) return null;

    tasks.forEach(function (task, index) {
      task.position = index + 1;
      task.label = String(index + 1);
      task.order = 'array';
    });

    return {
      title: isObject(payload) && typeof payload.title === 'string' ? payload.title : '',
      variantId: isObject(payload) && payload.id ? String(payload.id) : '',
      examType: isObject(payload) && payload.exam_type ? payload.exam_type : '',
      mode: 'list',
      tasks: tasks,
      count: tasks.length,
      url: pageUrl,
      ts: Date.now()
    };
  }

  function looksLikeAnswerPayload(text) {
    if (typeof text !== 'string' || text.length < 20) return false;
    return text.indexOf('answer_control_layout') !== -1 ||
      (text.indexOf('correct_answers') !== -1 && text.indexOf('tasks') !== -1);
  }

  function currentTaskNumberFromUrl(url) {
    var match = String(url || '').match(/\/task\/(\d+)(?:[/?#]|$)/);
    return match ? Number(match[1]) : null;
  }

  function variantIdFromUrl(url) {
    var match = String(url || '').match(/\/variants\/([0-9a-f-]{8,})/i);
    return match ? match[1] : null;
  }

  return {
    isObject: isObject,
    formatCorrectAnswers: formatCorrectAnswers,
    collectTasks: collectTasks,
    buildReport: buildReport,
    sortByNumber: sortByNumber,
    looksLikeAnswerPayload: looksLikeAnswerPayload,
    currentTaskNumberFromUrl: currentTaskNumberFromUrl,
    variantIdFromUrl: variantIdFromUrl
  };
});

/*
 * content.js — изолированный мир.
 * Принимает перехваченные JSON-ответы, разбирает их через extractor.js,
 * складывает по вкладке в background и отдаёт попапу по запросу.
 */
(function () {
  'use strict';

  var EX = globalThis.EGEAnswers;
  if (!EX) {
    console.warn('[YaEduSolver] extractor.js не загружен');
    return;
  }

  var FILL = globalThis.EGEFiller;

  var state = {
    url: location.href,
    title: '',
    variantId: EX.variantIdFromUrl(location.href),
    tasks: [],
    receivedAt: 0
  };

  function keyOf(task) {
    return task.id || ('n:' + task.number);
  }

  function persist() {
    var report = {
      url: state.url,
      title: state.title,
      variantId: state.variantId,
      tasks: state.tasks,
      count: state.tasks.length,
      ts: state.receivedAt
    };
    try {
      chrome.runtime.sendMessage({ type: 'ege:report', report: report });
    } catch (e) {}
  }

  function nextVariantFromUrl() {
    return EX.variantIdFromUrl(location.href);
  }

  function acceptPayload(payload) {
    var incoming;
    // location.href важен: по нему определяется режим (вариант или коллекция).
    try { incoming = EX.buildReport(payload, location.href); } catch (e) { return; }
    if (!incoming || !incoming.tasks || !incoming.tasks.length) return;

    var incomingVariant = incoming.variantId || nextVariantFromUrl();
    if (state.variantId && incomingVariant && state.variantId !== incomingVariant) {
      state.tasks = [];
    }

    var byKey = {};
    var order = [];
    state.tasks.forEach(function (task) {
      var key = keyOf(task);
      byKey[key] = task;
      order.push(key);
    });
    incoming.tasks.forEach(function (task) {
      var key = keyOf(task);
      if (!byKey[key]) order.push(key);
      byKey[key] = task;
    });

    var merged = order.map(function (key) { return byKey[key]; });
    merged.sort(function (a, b) {
      var ap = Number(a.position);
      var bp = Number(b.position);
      var aok = a.position !== undefined && isFinite(ap);
      var bok = b.position !== undefined && isFinite(bp);
      if (aok && bok && ap !== bp) return ap - bp;
      if (aok && !bok) return -1;
      if (!aok && bok) return 1;
      return 0;
    });
    state.tasks = merged;
    state.title = incoming.title || state.title;
    state.variantId = incomingVariant || state.variantId;
    state.url = location.href;
    state.receivedAt = Date.now();
    persist();
  }

  function announce() {
    try { window.postMessage({ __ege: true, type: 'ready' }, '*'); } catch (e) {}
  }

  function refetch() {
    try { window.postMessage({ __ege: true, type: 'refetch', url: location.href }, '*'); } catch (e) {}
  }

  function resetVariant() {
    state.tasks = [];
    state.receivedAt = 0;
    try { window.postMessage({ __ege: true, type: 'reset' }, '*'); } catch (e) {}
    persist();
    announce();
  }

  /* ---------- заполнение, сохранение, переход ---------- */

  function findTaskByPosition(position) {
    for (var i = 0; i < state.tasks.length; i++) {
      if (Number(state.tasks[i].position) === Number(position)) return state.tasks[i];
    }
    return null;
  }

  function waitFor(predicate, timeout, interval) {
    var start = Date.now();
    return new Promise(function (resolve) {
      (function loop() {
        var value = null;
        try { value = predicate(); } catch (e) { value = null; }
        if (value) { resolve(value); return; }
        if (Date.now() - start > timeout) { resolve(null); return; }
        setTimeout(loop, interval || 200);
      })();
    });
  }

  function respond(sendResponse, data) {
    try { sendResponse(data); } catch (e) {}
  }

  function mergeResult(base, extra) {
    var out = {};
    var key;
    for (key in base) if (Object.prototype.hasOwnProperty.call(base, key)) out[key] = base[key];
    for (key in extra) if (Object.prototype.hasOwnProperty.call(extra, key)) out[key] = extra[key];
    return out;
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var message = event.data;
    if (!message || message.__ege !== true) return;
    if (message.type === 'data') acceptPayload(message.data);
  });

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) return false;

    if (message.type === 'ege:get') {
      sendResponse({
        ok: true,
        hasReport: state.tasks.length > 0,
        title: state.title,
        variantId: state.variantId,
        url: state.url,
        tasks: state.tasks,
        current: EX.currentTaskNumberFromUrl(location.href),
        ts: state.receivedAt
      });
      return true;
    }

    if (message.type === 'ege:refetch') {
      refetch();
      announce();
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'ege:fill') {
      var task = findTaskByPosition(message.position);
      if (!task) { respond(sendResponse, { ok: false, error: 'задание не найдено' }); return true; }
      if (!FILL) { respond(sendResponse, { ok: false, error: 'модуль заполнения не загружен' }); return true; }

      var startHref = location.href;

      // Ждём появления полей ответа (важно сразу после SPA-перехода).
      waitFor(function () {
        var panel = FILL.findPanel(document);
        return panel && FILL.collectInputs(panel).length ? true : null;
      }, 4000, 100).then(function (ready) {
        if (!ready) { respond(sendResponse, { ok: false, error: 'поля ответа не найдены' }); return; }

        var fillResult;
        try { fillResult = FILL.fillTask(task, document); } catch (e) { fillResult = { ok: false, error: String((e && e.message) || e) }; }
        if (!fillResult.ok || !fillResult.filled) { respond(sendResponse, fillResult); return; }

        // Ждём, пока React включит кнопку «Сохранить ответ».
        waitFor(function () {
          var button = FILL.findSaveButton(document);
          return button && !button.disabled ? button : null;
        }, 4000, 100).then(function (saveButton) {
          if (!saveButton) {
            respond(sendResponse, mergeResult(fillResult, { saved: false, advanced: false, error: 'кнопка «Сохранить ответ» недоступна' }));
            return;
          }
          FILL.clickElement(saveButton);

          // Ждём подтверждения сохранения (или автоперехода).
          waitFor(function () {
            if (location.href !== startHref) return 'url';
            if (FILL.isSaveSettled(document)) return 'settled';
            return null;
          }, 12000, 200).then(function (signal) {
            if (!signal) {
              respond(sendResponse, mergeResult(fillResult, { saved: false, advanced: false, error: 'сохранение не подтвердилось' }));
              return;
            }
            if (signal === 'url') {
              respond(sendResponse, mergeResult(fillResult, { saved: true, advanced: true }));
              return;
            }
            var next = FILL.nextButton(document);
            if (!next) {
              respond(sendResponse, mergeResult(fillResult, { saved: true, advanced: false, error: 'следующего задания нет' }));
              return;
            }
            FILL.clickElement(next);
            waitFor(function () { return location.href !== startHref ? true : null; }, 5000, 150).then(function () {
              respond(sendResponse, mergeResult(fillResult, { saved: true, advanced: location.href !== startHref }));
            });
          });
        });
      });
      return true;
    }

    return false;
  });

  // SPA-навигация между заданиями/вариантами.
  var lastHref = location.href;
  setInterval(function () {
    if (location.href === lastHref) return;
    lastHref = location.href;
    var next = nextVariantFromUrl();
    if (state.variantId && next && next !== state.variantId) {
      resetVariant();
    } else {
      state.url = location.href;
      announce();
    }
  }, 800);

  announce();
  setTimeout(announce, 500);
  setTimeout(announce, 1500);
})();

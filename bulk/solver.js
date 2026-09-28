/*
 * solver.js — чистая логика (браузер и Node).
 *
 * Контракт отправки (из HAR):
 *   POST /classroom/api/patch-clesson-results/
 *   headers: content-type: application/json, x-csrf-token: <sk>
 *   body: { clessonId, isEvaluable:null, problemLinkId, resultId,
 *           answered:true, completed:true, dateUpdated, answer, sk }
 *   answer = JSON-строка вида { "<markerId>": { "user_answer": <value> } }
 *
 * Источник данных — window._data на странице .../assignments/<clessonId>/run/N/:
 *   config.sk                       -> sk и x-csrf-token
 *   data.getLatestCLessonResult.id  -> resultId
 *   data.getCLessonRun.problems[]   -> id (problemLinkId), problem.markup.answers
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.YBS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MARKER = 'window._data=';

  function parseWindowData(html) {
    if (typeof html !== 'string') return null;
    var index = html.indexOf(MARKER);
    if (index === -1) return null;
    var start = index + MARKER.length;
    var end = html.indexOf('</script>', start);
    if (end === -1) return null;
    var raw = html.slice(start, end).trim().replace(/;+$/, '');
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  /**
   * Приводит correct_answers к формату user_answer.
   *   inline-поля:  {"1":["76"],"2":["26"]} -> {"1":"76","2":"26"}
   *   выбор:        [2,3,5]                 -> [2,3,5]
   *   matching:     [[[1,0],[6,1]]]         -> [[1,0],[6,1]]
   *   chooseimage:  [["i7"]]                -> ["i7"]
   *
   * У «списковых» маркеров (matching/macaroni/chooseimage) правильный ответ
   * хранится на один уровень вложенности глубже, чем ждёт сервер, поэтому
   * единственную массив-обёртку разворачиваем. А выбор — это множество индексов:
   * в данных бывает [3,3,5], но сам сайт отправляет [3,5] (проверено по HAR).
   */
  function normalize(value) {
    if (Array.isArray(value)) {
      var arr = value;
      if (arr.length === 1 && Array.isArray(arr[0])) arr = arr[0]; // снять обёртку
      if (arr.length) {
        var numeric = true;
        for (var i = 0; i < arr.length; i++) {
          if (typeof arr[i] !== 'number') { numeric = false; break; }
        }
        if (numeric) {
          var uniq = [];
          for (var j = 0; j < arr.length; j++) {
            if (uniq.indexOf(arr[j]) === -1) uniq.push(arr[j]);
          }
          return uniq; // выбор: без дублей
        }
      }
      return arr;
    }
    if (isPlainObject(value)) {
      var out = {};
      var key;
      for (key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        var item = value[key];
        out[key] = (Array.isArray(item) && item.length === 1) ? item[0] : item;
      }
      return out;
    }
    return value;
  }

  /**
   * Считается ли попытка реально зачтённой. Просто `answered` недостаточно:
   * сервер может принять ответ, но не зачесть его — тогда `status:0`,
   * `points:0`, а у маркера `mistakes:-1`. Такие задания нужно решать заново,
   * а не пропускать как готовые.
   */
  // Все маркеры без ошибок: ответ совпал с эталоном (даже если сервер не начислил балл).
  function markersAllMatch(state) {
    var markers = state && state.markers;
    if (!markers || typeof markers !== 'object' || Array.isArray(markers)) return false;
    var keys = Object.keys(markers);
    if (!keys.length) return false;
    for (var i = 0; i < keys.length; i++) {
      var marker = markers[keys[i]] || {};
      if (typeof marker.mistakes === 'number' && marker.mistakes > 0) return false;
      if (marker.answer_status === false) return false;
      var a = marker.answer_status;
      var vals = Array.isArray(a) ? a
               : (a && typeof a === 'object' ? Object.keys(a).map(function (k) { return a[k]; }) : null);
      if (vals) {
        for (var j = 0; j < vals.length; j++) if (vals[j] === false) return false;
      }
    }
    return true;
  }

  function isSolvedState(state) {
    if (!state || !(state.answered || state.completed)) return false;
    // status:0 — сервер балл не начислил. Если ответ при этом совпал с эталоном
    // (бывает у заданий без серверных checks) — считаем решённым.
    if (state.status === 0) return markersAllMatch(state);
    var markers = state.markers;
    if (markers && typeof markers === 'object' && !Array.isArray(markers)) {
      var keys = Object.keys(markers);
      for (var i = 0; i < keys.length; i++) {
        var marker = markers[keys[i]] || {};
        if (typeof marker.mistakes === 'number' && marker.mistakes > 0) return false;
        if (marker.answer_status === false) return false;
      }
    }
    return true;
  }

  // Задание, где ответ верный, но сервер не выставил балл (status:0, points:0).
  function isUngraded(data, step) {
    if (!data || !step || step.kind !== 'practice') return false;
    var states = (data.answers && data.answers[step.problemLinkId]) || [];
    if (!states.length) return false;
    var state = states[states.length - 1] || {};
    if (!(state.answered || state.completed)) return false;
    if (state.status !== 0) return false;
    return markersAllMatch(state);
  }

  function buildAnswer(answers) {
    var out = {};
    var key;
    for (key in answers) {
      if (!Object.prototype.hasOwnProperty.call(answers, key)) continue;
      out[key] = { user_answer: normalize(answers[key]) };
    }
    return out;
  }

  /**
   * Вердикт по ответу сервера: true — верно, false — неверно, null — не смогли
   * определить (тогда не блокируем сдачу).
   */
  function readVerdict(data, step) {
    if (!data || !step) return null;
    if (step.kind === 'theory') return true; // у теории нет ответа — всегда ок
    try {
      if (step.kind === 'web') {
        var attempt = data.attempt;
        if (!attempt) return null;
        if (attempt.answered === false) return false;
        var markers = attempt.markers || {};
        var verdict = markers.user_answer && markers.user_answer.verdict;
        if (verdict && verdict.status === false) return false;
        var result = markers.result || {};
        var keys = Object.keys(result);
        for (var i = 0; i < keys.length; i++) {
          if (result[keys[i]] && result[keys[i]].answer_status === false) return false;
        }
        return true;
      }
      var states = (data.answers && data.answers[step.problemLinkId]) || [];
      if (!states.length) return null;
      var state = states[states.length - 1] || {};
      if (state.answered === false) return false;
      // status:0 бывает у заданий без серверных checks (например, выбор с дублем
      // [3,3,5]): ответ принят, answer_status у всех элементов 1, но points не
      // начислены. Это НЕ неверный ответ — иначе блокировали бы сдачу занятия.
      var markerMap = state.markers || {};
      var markerIds = Object.keys(markerMap);
      for (var j = 0; j < markerIds.length; j++) {
        var marker = markerMap[markerIds[j]] || {};
        if (typeof marker.mistakes === 'number' && marker.mistakes > 0) return false;
        if (marker.answer_status === false) return false;
        if (marker.answer_status && typeof marker.answer_status === 'object') {
          var values = Array.isArray(marker.answer_status)
            ? marker.answer_status
            : Object.keys(marker.answer_status).map(function (k) { return marker.answer_status[k]; });
          for (var v = 0; v < values.length; v++) {
            if (values[v] === false) return false;
          }
        }
      }
      return true;
    } catch (e) {
      return null;
    }
  }

  /** Страница «Сдано» — там кнопки «Решить» не нужны. */
  function isFinishedPath(pathname) {
    return /\/finished(\/|$)/.test(String(pathname || ''));
  }

  /** Смещение дуги кружка прогресса: dasharray * (1 - answered/total). */
  function progressOffset(dasharray, answered, total) {
    if (!dasharray || !total) return 0;
    var ratio = Math.max(0, Math.min(1, answered / total));
    return dasharray * (1 - ratio);
  }

  /** Тело запроса для web-задания (POST /classroom/api/v2/post-attempts/). */
  function buildWebAttempt(step, resultId) {
    return {
      lpl_id: step.problemLinkId,
      clr_id: resultId,
      attempt: {
        answered: true,
        completed: true,
        markers: {
          user_answer: {
            panes: (step.panes || []).map(function (pane) {
              return { name: pane.name, content: pane.content, language: pane.language };
            }),
            verdict: { status: true, errors: [] }
          }
        }
      }
    };
  }

  function clessonIdFromHref(href) {
    var match = String(href || '').match(/\/assignments\/(\d+)\//);
    return match ? Number(match[1]) : null;
  }

  /** План: что и куда отправлять. */
  function buildPlan(data, clessonId) {
    var config = (data && data.config) || {};
    var payload = (data && data.data) || {};
    var run = payload.getCLessonRun || {};
    var latest = payload.getLatestCLessonResult || {};
    var latestAnswers = (latest && latest.answers) || {};
    var lessonCompleted = !!(latest && latest.completed);
    var problems = Array.isArray(run.problems) ? run.problems : [];
    var steps = [];

    problems.forEach(function (wrapper) {
      var answers = (wrapper && wrapper.problem && wrapper.problem.markup && wrapper.problem.markup.answers) || {};
      var keys = Object.keys(answers);
      var problemType = (wrapper && wrapper.problem && wrapper.problem.type) || '';
      // Теорию (нечего заполнять) тоже проходим — как это делает сайт.
      var isWeb = problemType === 'web';
      var states = latestAnswers[wrapper.id] || [];
      // Для web проверка мягче (у него своя форма ответа), для остальных —
      // только реально зачтённые попытки.
      var answered = states.some(function (state) {
        return isWeb ? !!(state && (state.answered || state.completed)) : isSolvedState(state);
      });

      // practice — есть готовый ответ; theory — пустой патч; web — свой эндпоинт;
      // всё остальное без ответов (editable/diskurl и т.п.) — ручное, пропускаем.
      var kind;
      if (isWeb) kind = 'web';
      else if (keys.length > 0) kind = 'practice';
      else if (problemType === 'theory') kind = 'theory';
      else kind = 'skip';

      // Теория считается пройденной, если её открывали; остальные — если сданы.
      var alreadyDone = kind === 'theory' ? states.length > 0 : answered;
      steps.push({
        problemLinkId: wrapper.id,
        kind: kind,
        type: problemType,
        done: lessonCompleted || alreadyDone,
        markers: keys,
        answer: kind === 'practice' ? buildAnswer(answers) : null,
        panes: kind === 'web' ? ((wrapper.problem.markup && wrapper.problem.markup.answer_panes) || []) : null
      });
    });

    return {
      sk: config.sk || '',
      resultId: latest.id || null,
      clessonId: clessonId || (run.clesson && run.clesson.id) || null,
      lessonName: (run.clesson && run.clesson.name) || run.name || '',
      totalProblems: problems.length,
      spentTime: Number(latest && latest.spent_time) || 0,
      steps: steps
    };
  }

  return {
    parseWindowData: parseWindowData,
    normalize: normalize,
    isSolvedState: isSolvedState,
    isUngraded: isUngraded,
    buildAnswer: buildAnswer,
    buildWebAttempt: buildWebAttempt,
    readVerdict: readVerdict,
    progressOffset: progressOffset,
    isFinishedPath: isFinishedPath,
    buildPlan: buildPlan,
    clessonIdFromHref: clessonIdFromHref
  };
});

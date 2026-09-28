/*
 * content.js — управление решением занятий из окна расширения.
 * Кнопок на странице нет: окно запрашивает список занятий, запускает решение
 * одного или всех по очереди, может остановить и получает живой статус.
 */
(function () {
  'use strict';

  var YBS = globalThis.YBS;
  if (!YBS) {
    console.warn('[YBS] solver.js не загружен');
    return;
  }

  var API_START = '/classroom/api/post-clesson-results/';
  var API_PATCH = '/classroom/api/patch-clesson-results/';
  var API_LAST = '/classroom/api/patch-lesson-last-active-problem/';
  var API_COMPLETE = '/classroom/api/post-clesson-results-complete/';
  var API_STATIC = '/classroom/api/post-static/';
  var API_ATTEMPTS = '/classroom/api/v2/post-attempts/';
  var API_SPENT = '/classroom/api/post-clesson-results-update-spent-time/';

  // По HAR: сервер обрабатывает patch 0.34-1.0 c (в среднем ~0.63 c) и на это
  // время блокирует результат. Поэтому шлём по одному запросу с паузой.
  var REQUEST_TIMEOUT = 20000; // таймаут одного запроса
  var SLOT_DELAY = 50;           // пауза между заданиями
  var MAX_PARALLEL = 0;          // 0 — без лимита (все занятия сразу); число — потолок
  var MAX_STARTS = 3;            // одновременно создаём не больше N занятий (иначе 429 «limited»)
  var MAX_FETCH = 6;             // одновременно грузим не больше N run-страниц (бэкенд тоже режет)
  var TRACK_LAST_ACTIVE = false; // слать patch-lesson-last-active (держит лок результата)
  var CONFLICT_DELAY = 900;    // пауза при 409 result is locked
  var timeFrom = 7;            // мин — нижняя граница времени решения
  var timeTo = 13;             // мин — верхняя граница времени решения

  // Очередь живёт в контент-скрипте, поэтому решение продолжается,
  // даже когда окно расширения закрыто.
  var queue = { running: false, stop: false, mode: 'all', completed: 0, total: 0, jobs: [], text: '' };

  var LESSON_SELECTOR = 'a.student-lessons-view__lesson[href*="/assignments/"][href*="/run/"]';

  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  // Семафор для создания занятий: сервер отвечает 429 «limited», если стартовать
  // всё сразу, поэтому POST /post-clesson-results/ пропускаем порциями.
  var startsActive = 0;
  var startsQueue = [];
  function acquireStart() {
    if (startsActive < MAX_STARTS) { startsActive++; return Promise.resolve(); }
    return new Promise(function (resolve) { startsQueue.push(resolve); });
  }
  function releaseStart() {
    startsActive--;
    var next = startsQueue.shift();
    if (next) { startsActive++; next(); }
  }

  // Такой же семафор для загрузки run-страниц: их 24 сразу — и schoolbook-api
  // отдаёт «limited», а страница приходит с ошибкой вместо данных.
  var fetchActive = 0;
  var fetchQueue = [];
  function acquireFetch() {
    if (fetchActive < MAX_FETCH) { fetchActive++; return Promise.resolve(); }
    return new Promise(function (resolve) { fetchQueue.push(resolve); });
  }
  function releaseFetch() {
    fetchActive--;
    var next = fetchQueue.shift();
    if (next) { fetchActive++; next(); }
  }

  // Раньше рисовали всплывашку на странице; теперь ничего не вставляем в DOM,
  // сообщение уходит в окно расширения (его статус).
  function toast(text) {
    if (!text) return;
    queue.text = String(text);
    broadcast();
  }

  function fetchWithTimeout(url, options, ms) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, ms || REQUEST_TIMEOUT);
    var opts = Object.assign({}, options, { signal: controller.signal });
    return fetch(url, opts).then(function (response) {
      clearTimeout(timer);
      return response;
    }, function (error) {
      clearTimeout(timer);
      throw error;
    });
  }

  // Загружаем run-данные с проверкой ошибок бэкенда. Страница может ответить
  // HTTP 200, но внутри window._data лежат errors ("limited") и нет
  // getCLessonRun — это не «пустое занятие», а сорванная загрузка: повторяем.
  async function fetchLessonData(url) {
    var lastErr = 'не удалось загрузить занятие';
    for (var i = 0; i < 5; i++) {
      await acquireFetch();
      var res = null;
      try {
        res = await fetchRunPage(url);
        if (res && res.ok) {
          var data = YBS.parseWindowData(await res.text());
          if (data) {
            var payload = data.data || {};
            var errors = payload.errors || {};
            var run = payload.getCLessonRun;
            if (run && !errors.getCLessonRun && !errors.getLatestCLessonResult) {
              return { data: data, url: res.url || url };
            }
            lastErr = 'бэкенд ограничил загрузку занятия (429)';
          } else {
            lastErr = 'не нашёл данные занятия';
          }
        } else {
          lastErr = 'не удалось открыть занятие (' + (res ? res.status : 'сеть') + ')';
        }
      } finally {
        releaseFetch();
      }
      await sleep(700 * (i + 1) + Math.floor(Math.random() * 400));
    }
    throw new Error(lastErr);
  }

  // Загрузка run-страницы с повторами: при 429/5xx/сети пробуем ещё.
  async function fetchRunPage(url) {
    var last = null;
    for (var i = 0; i < 4; i++) {
      try {
        last = await fetchWithTimeout(url, { credentials: 'include' }, REQUEST_TIMEOUT);
        if (last.ok || (last.status !== 429 && last.status < 500)) return last;
      } catch (e) { last = null; }
      await sleep(1000 * (i + 1) + Math.floor(Math.random() * 400));
    }
    return last;
  }

  function postJson(url, body, sk, options) {
    var init = {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': sk || '' },
      body: JSON.stringify(body)
    };
    if (options) {
      if (options.referrer) init.referrer = options.referrer;
      if (options.referrerPolicy) init.referrerPolicy = options.referrerPolicy;
    }
    return fetchWithTimeout(url, init, REQUEST_TIMEOUT);
  }

  // 409 — «result is locked» (отпускает быстро), 429 «limited» — сервер просит
  // сбавить темп (ждём заметно дольше и уважаем Retry-After).
  async function postJsonRetry(url, body, sk, tries, baseDelay, options) {
    var attempt = 0;
    var response = null;
    while (attempt < (tries || 1)) {
      attempt++;
      response = await postJson(url, body, sk, options);
      if (response.status !== 409 && response.status !== 429) return response;
      var delay = (baseDelay || 500) * attempt + Math.floor(Math.random() * 200);
      if (response.status === 429) {
        delay = Math.max(delay, 1500 * attempt) + Math.floor(Math.random() * 500);
        try {
          var ra = response.headers && response.headers.get && response.headers.get('retry-after');
          var sec = parseInt(ra, 10);
          if (isFinite(sec) && sec >= 0) delay = sec * 1000;
        } catch (e) {}
      }
      await sleep(delay);
    }
    return response;
  }

  function patchBody(step, plan) {
    var isTheory = step.kind === 'theory';
    return {
      clessonId: plan.clessonId,
      isEvaluable: null,
      problemLinkId: step.problemLinkId,
      resultId: plan.resultId,
      answered: !isTheory,
      completed: !isTheory,
      dateUpdated: new Date().toISOString(),
      answer: isTheory ? '{}' : JSON.stringify(step.answer),
      sk: plan.sk
    };
  }

  // Отправка одного задания. Возвращает 'ok' | 'wrong' | 'fail'.
  async function runStep(step, plan) {
    try {
      // «Где остановился» держит лок результата и гоняется с ответом — именно
      // это давало редкие 409. По умолчанию не шлём; поставить true, чтобы вернуть.
      if (TRACK_LAST_ACTIVE) {
        await postJsonRetry(API_LAST, { problemLinkId: step.problemLinkId, resultId: plan.resultId, sk: plan.sk }, plan.sk, 4, CONFLICT_DELAY);
      }
      var response;
      if (step.kind === 'web') {
        var panes = step.panes || [];
        if (!panes.length) return 'fail';
        try {
          await postJsonRetry(API_STATIC, { panes: panes, sk: plan.sk }, plan.sk, 3, CONFLICT_DELAY);
        } catch (e) {}
        var body = YBS.buildWebAttempt(step, plan.resultId);
        body.sk = plan.sk;
        response = await postJsonRetry(API_ATTEMPTS, body, plan.sk, 6, CONFLICT_DELAY);
      } else {
        response = await postJsonRetry(API_PATCH, patchBody(step, plan), plan.sk, 6, CONFLICT_DELAY);
      }
      if (!response.ok) return 'fail';
      if (step.kind === 'theory') return 'ok'; // у теории нет ответа — нечего проверять
      var data = null;
      try { data = await response.json(); } catch (e) { data = null; }
      var verdict = data ? YBS.readVerdict(data, step) : null;
      if (verdict === false) return 'wrong';
      if (data && YBS.isUngraded(data, step)) return 'ungraded'; // сайт не начислил балл
      return 'ok';
    } catch (e) {
      return 'fail';
    }
  }

  // Кружок прогресса может лежать и внутри ссылки, и рядом с ней.
  function findCircle(anchor) {
    if (!anchor) return null;
    if (anchor.querySelector) {
      var circle = anchor.querySelector('.progress-circle');
      if (circle) return circle;
    }
    var wrapper = null;
    try { wrapper = anchor.closest('.student-lessons-view__lesson-wrapper'); } catch (e) {}
    if (wrapper && wrapper.querySelector) {
      circle = wrapper.querySelector('.progress-circle');
      if (circle) return circle;
    }
    if (anchor.parentNode && anchor.parentNode.querySelector) {
      circle = anchor.parentNode.querySelector('.progress-circle');
      if (circle) return circle;
    }
    return null;
  }

  function applyProgress(anchor, next, total) {
    var circle = findCircle(anchor);
    if (!circle) return false;
    var title = circle.querySelector('.progress-circle__title');
    if (title) {
      title.innerHTML = next + '<div class="progress-circle__title-separator">/</div>' + total;
    }
    var bar = circle.querySelector('.progress-circle__bar');
    if (bar) {
      var dasharray = Number(bar.getAttribute('stroke-dasharray'));
      if (!isFinite(dasharray) || !dasharray) dasharray = 2 * Math.PI * Number(bar.getAttribute('r') || 26);
      bar.setAttribute('stroke-dashoffset', String(YBS.progressOffset(dasharray, next, total)));
    }
    return true;
  }

  // Обновляем кружок прогресса занятия (числа + дуга), как это делает сайт.
  function updateProgress(anchor, delta) {
    if (!anchor || !delta) return;
    var circle = findCircle(anchor);
    if (!circle) return;
    var title = circle.querySelector('.progress-circle__title');
    var numbers = title ? (String(title.textContent).match(/\d+/g) || []) : [];
    var current = numbers.length ? Number(numbers[0]) : 0;
    var total = numbers.length > 1 ? Number(numbers[1]) : null;
    if (total === null) return;
    var next = Math.min(total, current + delta);
    anchor.__ybsProgress = { next: next, total: total };
    applyProgress(anchor, next, total);
  }

  // Плавно сворачиваем карточку, остальные занятия поднимаются на её место.
  function animateRemove(anchor) {
    var wrapper = anchor;
    try { wrapper = anchor.closest('.student-lessons-view__lesson-wrapper') || anchor.parentNode; } catch (e) { wrapper = anchor.parentNode; }
    if (!wrapper || !wrapper.parentNode) return;
    var height = wrapper.getBoundingClientRect().height;
    wrapper.style.setProperty('overflow', 'hidden', 'important');
    wrapper.style.setProperty('box-sizing', 'border-box', 'important');
    wrapper.style.setProperty('height', height + 'px', 'important');
    wrapper.style.setProperty('margin-top', '0', 'important');
    wrapper.style.setProperty('margin-bottom', '0', 'important');
    wrapper.style.setProperty('transition', 'height .45s ease, opacity .45s ease, margin .45s ease, transform .45s ease', 'important');
    wrapper.style.setProperty('transform-origin', 'top center', 'important');
    void wrapper.offsetHeight; // заставляем браузер применить стартовое состояние
    wrapper.style.setProperty('opacity', '0', 'important');
    wrapper.style.setProperty('transform', 'translateX(24px) scale(.98)', 'important');
    wrapper.style.setProperty('height', '0px', 'important');
    setTimeout(function () {
      if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
    }, 500);
  }

  function uuid() {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch (e) {}
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      var v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // Живое распределение времени по заданиям: не поровну, а «как в жизни» —
  // короткие решения часты, длинные редки, иногда залипаешь на задании.
  // Возвращает массив секунд длиной count, сумма ровно totalSeconds.
  function distributeTime(totalSeconds, count, minSeconds) {
    var out = [];
    if (count <= 0) return out;
    var total = Math.max(0, Math.floor(totalSeconds));
    if (!total) { for (var z = 0; z < count; z++) out.push(0); return out; }
    var min = Math.min(minSeconds == null ? 8 : minSeconds, Math.floor(total / count));
    var rest = total - min * count;
    var weights = [];
    var sum = 0;
    for (var i = 0; i < count; i++) {
      // экспоненциально-подобные веса: большинство задач быстрые, немногие долгие
      var w = -Math.log(1 - Math.random() * 0.999);
      if (Math.random() < 0.15) w *= 2.5 + Math.random() * 2; // «залип» на задании
      weights.push(w);
      sum += w;
    }
    var acc = 0;
    for (var j = 0; j < count; j++) {
      var v = min + Math.floor(rest * (weights[j] / sum));
      out.push(v);
      acc += v;
    }
    // Секунды, потерянные на округлении, раскидываем по случайным заданиям.
    var leftover = total - acc;
    var order = [];
    for (var k = 0; k < count; k++) order.push(k);
    for (var m = count - 1; m > 0; m--) {
      var t = Math.floor(Math.random() * (m + 1));
      var tmp = order[m]; order[m] = order[t]; order[t] = tmp;
    }
    for (var n = 0; n < leftover; n++) out[order[n % count]] += 1;
    return out;
  }

  // Отправляем время ОДНОГО задания (вызывается сразу после его решения).
  // referer — страница занятия: без него сервер отвечает 404 Result not found.
  async function sendSpentSlice(plan, step, seconds) {
    if (!step || !plan.resultId || !(seconds > 0)) return;
    var options = plan.runUrl ? { referrer: plan.runUrl, referrerPolicy: 'same-origin' } : null;
    await postJsonRetry(API_SPENT + plan.resultId + '/', {
      link_id: step.problemLinkId,
      time_delta: seconds,
      id: uuid(),
      sk: plan.sk
    }, plan.sk, 4, CONFLICT_DELAY, options);
  }

  // План времени: доводим общее spent_time занятия до случайной цели из интервала
  // настроек и раскладываем разницу по заданиям (живой разброс). Отправлять это
  // будем по кусочку сразу после решения каждого задания.
  function buildTimePlan(plan, steps) {
    if (!plan.resultId) return null;
    var anchors = (steps || []).filter(function (s) { return s.kind !== 'skip'; });
    if (!anchors.length) return null;
    var lo = Math.max(1, Number(timeFrom) || 1);
    var hi = Math.max(lo, Number(timeTo) || lo);
    var target = Math.round((lo + Math.random() * (hi - lo)) * 60);
    var delta = target - (Number(plan.spentTime) || 0);
    if (delta <= 0) return null;
    return { anchors: anchors, slices: distributeTime(delta, anchors.length, 8) };
  }

  // Повторный запуск: решать нечего, но время всё равно доводим до цели.
  async function flushSpentTime(plan) {
    var timePlan = buildTimePlan(plan, plan.steps);
    if (!timePlan) return;
    for (var i = 0; i < timePlan.anchors.length; i++) {
      try { await sendSpentSlice(plan, timePlan.anchors[i], timePlan.slices[i]); } catch (e) {}
    }
  }

  // ---------------- список занятий ----------------

  function isVisible(node) {
    try { return !!(node.getClientRects && node.getClientRects().length); } catch (e) { return true; }
  }

  function lightLesson(lesson) {
    return { id: lesson.id, href: lesson.href, name: lesson.name, done: lesson.done, total: lesson.total };
  }

  function scanLessons() {
    var finished = false;
    try {
      var fin = document.querySelector('input[type="radio"][value="finished"]');
      finished = !!(fin && fin.checked);
    } catch (e) {}
    var anchors = document.querySelectorAll(LESSON_SELECTOR);
    var lessons = [];
    Array.prototype.forEach.call(anchors, function (anchor) {
      if (!isVisible(anchor)) return; // невидимый список другой вкладки пропускаем
      var wrapper = null;
      try { wrapper = anchor.closest('.student-lessons-view__lesson-wrapper'); } catch (e) {}
      var scope = wrapper || anchor;
      var nameEl = scope.querySelector('.student-lessons-view__lesson-name-text');
      var name = nameEl ? String(nameEl.textContent || '').trim() : '';
      if (!name) name = String(anchor.textContent || '').replace(/\s+/g, ' ').trim();
      var title = scope.querySelector('.progress-circle__title');
      var numbers = title ? (String(title.textContent || '').match(/\d+/g) || []) : [];
      var href = anchor.getAttribute('href') || '';
      var id = YBS.clessonIdFromHref(href);
      lessons.push({
        id: id == null ? href : String(id),
        href: href,
        name: name || href,
        done: numbers.length ? Number(numbers[0]) : 0,
        total: numbers.length > 1 ? Number(numbers[1]) : null,
        anchor: anchor
      });
    });
    return { tab: finished ? 'finished' : 'active', lessons: lessons };
  }

  // ---------------- список занятий: API + фолбэк на DOM ----------------

  var lessonCache = { at: 0, list: null };

  function courseIdFromPath() {
    var m = String(location.pathname).match(/\/classroom\/courses\/(\d+)/);
    return m ? m[1] : null;
  }

  function domAnchors() {
    var scan = scanLessons();
    var map = {};
    scan.lessons.forEach(function (l) { map[String(l.id)] = l.anchor; });
    return map;
  }

  // Полный список активных незакрытых занятий курса. Страница грузит занятия
  // постранично (по 12), поэтому DOM неполон — берём список из API и листаем
  // через sortKey, пока он есть.
  async function fetchLessonsFromApi() {
    var courseId = courseIdFromPath();
    if (!courseId) return null;
    var base = '/classroom/api/get-course-student-lessons/' + courseId + '/?list_type=active&page_size=50';
    var url = base;
    var seen = {};
    var out = [];
    for (var page = 0; page < 30; page++) {
      var res = await fetchWithTimeout(url, { credentials: 'include' }, REQUEST_TIMEOUT);
      if (!res.ok) return out.length ? out : null;
      var data = null;
      try { data = await res.json(); } catch (e) { return out.length ? out : null; }
      var clessons = (data && data.clessons) || [];
      for (var i = 0; i < clessons.length; i++) {
        var c = clessons[i] || {};
        if (c.id == null || seen[c.id]) continue;
        seen[c.id] = true;
        if (c.is_closed) continue; // закрытые не решаем
        var lesson = c.lesson || {};
        var total = (lesson.problems_count != null) ? Number(lesson.problems_count)
                  : (c.assigned_problems != null ? Number(c.assigned_problems) : null);
        if (total === 0) continue; // пустое занятие (нет заданий)
        out.push({
          id: String(c.id),
          href: '/classroom/courses/' + courseId + '/assignments/' + c.id + '/run/?latest',
          name: lesson.name || String(c.id),
          done: (c.finished_problems != null) ? Number(c.finished_problems) : 0,
          total: total
        });
      }
      var sortKey = data && data.sortKey;
      if (!sortKey || !clessons.length) break;
      url = base + '&sort_key=' + encodeURIComponent(sortKey);
    }
    return out;
  }

  async function refreshLessonCache() {
    try {
      var list = await fetchLessonsFromApi();
      if (list && list.length) lessonCache = { at: Date.now(), list: list };
    } catch (e) {}
    return lessonCache.list;
  }

  function cachedLessons() {
    return (lessonCache.list && lessonCache.list.length) ? lessonCache.list : null;
  }

  // Занятие для запуска: данные — из API, узел карточки — из DOM (если отрисован).
  function resolveLesson(id) {
    var key = String(id);
    var anchors = domAnchors();
    var anchor = anchors[key] || null;
    var cached = cachedLessons();
    if (cached) {
      for (var i = 0; i < cached.length; i++) {
        if (String(cached[i].id) === key) {
          var l = cached[i];
          return { id: key, href: l.href, name: l.name, done: l.done, total: l.total, anchor: anchor };
        }
      }
    }
    var dom = scanLessons();
    for (var j = 0; j < dom.lessons.length; j++) {
      if (String(dom.lessons[j].id) === key) {
        var d = dom.lessons[j];
        return { id: key, href: d.href, name: d.name, done: d.done, total: d.total, anchor: anchor };
      }
    }
    return null;
  }

  function findLesson(id) { return resolveLesson(id); }

  function currentLessonList() {
    var cached = cachedLessons();
    if (cached) return cached.map(lightLesson);
    return scanLessons().lessons.map(lightLesson);
  }

  function status() {
    var dom = scanLessons();
    var cached = cachedLessons();
    var jobs = queue.jobs || [];
    var active = [];
    for (var i = 0; i < jobs.length; i++) if (jobs[i].status === 'running') active.push(jobs[i]);
    var first = active[0] || null;
    return {
      running: queue.running,
      stopping: queue.stop,
      mode: queue.mode,
      index: queue.completed || 0,   // сколько занятий уже решено
      total: queue.total || 0,
      active: active.length,        // сколько решается прямо сейчас (параллельно)
      taskIndex: first ? first.taskIndex : 0,
      taskTotal: first ? first.taskTotal : 0,
      currentId: first ? first.id : null,
      activeIds: active.map(function (j) { return j.id; }),
      text: queue.text,
      tab: dom.tab,
      lessons: (cached || dom.lessons).map(lightLesson)
    };
  }

  function broadcast() {
    try {
      chrome.runtime.sendMessage({ type: 'bulk:state', state: status() }, function () {
        void chrome.runtime.lastError;
      });
    } catch (e) {}
  }

  function setStatus(text) {
    queue.text = text || '';
    broadcast();
  }

  // Отдельный «репорт» на занятие: при параллельном решении у каждого свой текст.
  function makeReport(job) {
    return function (text) {
      job.text = text || '';
      setStatus(job.name + ' · ' + job.text);
    };
  }

  // ---------------- решение ----------------

  async function solveLesson(job, report) {
    var href = job.href;
    var anchor = job.anchor;
    report('Загружаю занятие…');
    var url = new URL(href, location.origin).href;
    var loaded = await fetchLessonData(url);
    var data = loaded.data;

    var plan = YBS.buildPlan(data, YBS.clessonIdFromHref(url));
    plan.runUrl = loaded.url; // нужен как referer при отправке времени
    if (!plan.sk) throw new Error('нет sk');
    if (!plan.steps.length) {
      // Пустое занятие (бывает у презентаций) — это не ошибка, просто нечего решать.
      job.taskIndex = 0;
      job.taskTotal = 0;
      return { ok: true, done: 0, total: 0, empty: true };
    }

    // Занятие может быть ещё не начато — тогда создаём результат.
    if (!plan.resultId) {
      report('Начинаю занятие…');
      await acquireStart();
      try {
        // лёгкий разброс, чтобы старты не уходили одним залпом (сервер отвечает 429)
        await sleep(60 + Math.floor(Math.random() * 120));
        var started = await postJsonRetry(API_START, { clessonId: plan.clessonId, sk: plan.sk }, plan.sk, 5, CONFLICT_DELAY);
        if (!started.ok) throw new Error('не удалось начать занятие (' + started.status + ')');
        var startedData = await started.json();
        plan.resultId = startedData && startedData.id;
        if (!plan.resultId) throw new Error('сервер не вернул resultId');
      } finally {
        releaseStart();
      }
    }

    // Ручные задания (editable/diskurl и т.п.) не отправляем — просто пропускаем.
    var skipped = plan.steps.filter(function (step) { return !step.done && step.kind === 'skip'; });
    var pending = plan.steps.filter(function (step) { return !step.done && step.kind !== 'skip'; });
    var alreadyDone = plan.steps.length - pending.length - skipped.length;
    var skippedNote = skipped.length ? (', пропущено (ручные): ' + skipped.length) : '';

    if (!pending.length) {
      // Решать нечего — но время всё равно доводим до цели (повторный запуск).
      job.taskIndex = 0;
      job.taskTotal = 0;
      try { await flushSpentTime(plan); } catch (e) {}
      toast('Занятие решено: ' + alreadyDone + ' из ' + plan.steps.length + skippedNote + '.');
      if (!skipped.length && anchor) setTimeout(function () { animateRemove(anchor); }, 800);
      return { ok: true, done: alreadyDone, total: plan.steps.length, wrong: 0, failed: 0 };
    }

    // Время раскладываем по заданиям заранее, но начисляем по ходу решения.
    var timePlan = buildTimePlan(plan, pending);

    // Уже выполненные пропускаем; остальные отправляем строго по одному:
    // сервер блокирует результат, пока обрабатывает запрос.
    var results = [];
    var pendingTime = []; // время шлём «в фоне», чтобы не тормозить следующее задание
    for (var i = 0; i < pending.length; i++) {
      if (queue.stop) break;
      job.taskIndex = i + 1;
      job.taskTotal = pending.length;
      report('Решаю ' + (i + 1) + '/' + pending.length + '…');
      results.push(await runStep(pending[i], plan));
      // Начисляем время сразу после решения задания, но не ждём ответа: запрос
      // уходит параллельно со следующим заданием. Перед сдачей дождёмся всех.
      if (timePlan && timePlan.slices[i] > 0) {
        pendingTime.push(sendSpentSlice(plan, pending[i], timePlan.slices[i]).catch(function () {}));
      }
      if (i < pending.length - 1) await sleep(SLOT_DELAY);
    }

    var sent = results.filter(function (r) { return r === 'ok'; }).length;
    var wrong = results.filter(function (r) { return r === 'wrong'; }).length;
    var ungraded = results.filter(function (r) { return r === 'ungraded'; }).length;
    var failed = results.filter(function (r) { return r === 'fail'; }).length;
    var done = alreadyDone + sent + ungraded;
    var newlyAnswered = sent + wrong + ungraded; // кружок считает все задания, получившие ответ
    var stopped = queue.stop;

    // Дожидаемся фоновых запросов времени: иначе сдача обгонит их и время не зачтётся.
    if (pendingTime.length) { try { await Promise.all(pendingTime); } catch (e) {} }

    // Не сдаём, если остановили, остались ручные задания, что-то неверно или не отправилось.
    var willComplete = !stopped && !skipped.length && !wrong && !failed;
    if (willComplete) {
      await postJsonRetry(API_COMPLETE + plan.resultId + '/', { resultId: plan.resultId, sk: plan.sk }, plan.sk, 3, CONFLICT_DELAY);
    } else if (anchor) {
      // Если не сдаём — хотя бы показываем решённое в кружке.
      updateProgress(anchor, newlyAnswered);
    }

    toast('Занятие решено: ' + done + ' из ' + plan.steps.length +
      (alreadyDone ? (', уже было готово: ' + alreadyDone) : '') +
      skippedNote +
      (ungraded ? (', сайт не оценил: ' + ungraded) : '') +
      (wrong ? (', неверных: ' + wrong) : '') +
      (failed ? (', ошибок: ' + failed) : '') +
      (willComplete ? '.' : ' — не сдавал.'));
    if (anchor && willComplete) setTimeout(function () { animateRemove(anchor); }, 900);
    return { ok: true, done: done, total: plan.steps.length, wrong: wrong, failed: failed };
  }

  async function solveOne(lesson) {
    if (queue.running) return;
    var job = { id: lesson.id, name: lesson.name, href: lesson.href, anchor: lesson.anchor,
      status: 'running', taskIndex: 0, taskTotal: 0, text: '' };
    queue.running = true;
    queue.stop = false;
    queue.mode = 'one';
    queue.completed = 0;
    queue.total = 1;
    queue.jobs = [job];
    setStatus('Решаю: ' + lesson.name);
    try {
      await solveLesson(job, makeReport(job));
    } catch (e) {
      toast('Ошибка: ' + ((e && e.message) || e), true);
    } finally {
      queue.running = false;
      queue.completed = 1;
      job.status = 'done';
      job.taskIndex = 0;
      job.taskTotal = 0;
      setStatus(queue.stop ? 'Остановлено' : 'Готово');
    }
  }

  async function solveAll() {
    if (queue.running) return;
    queue.running = true; // сразу, чтобы окно и иконка показали «идёт решение»
    queue.stop = false;
    queue.mode = 'all';
    queue.completed = 0; // сколько занятий уже решено
    queue.total = 0;
    queue.jobs = [];
    setStatus('Загружаю список занятий…');

    var solved = 0;
    var failed = 0;
    var jobs = [];
    var next = 0;

    await refreshLessonCache(); // полный список занятий, включая не отрисованные
    var list = currentLessonList();
    if (!list.length) {
      toast('Не нашёл незакрытых занятий.', true);
      queue.running = false;
      setStatus('Готово');
      return;
    }
    jobs = list.map(function (lesson) {
      return { id: lesson.id, name: lesson.name, href: lesson.href, anchor: null,
        status: 'pending', taskIndex: 0, taskTotal: 0, text: '' };
    });
    queue.total = jobs.length;
    queue.jobs = jobs;
    setStatus('Начинаю…');

    function prepare(job) {
      var fresh = resolveLesson(job.id); // свежие данные + узел карточки, если отрисован
      if (fresh) { job.href = fresh.href; job.anchor = fresh.anchor; job.name = fresh.name; }
    }

    async function runJob(job) {
      prepare(job);
      job.status = 'running';
      await solveLesson(job, makeReport(job));
      solved++;
      job.status = 'done';
      queue.completed++;
      job.taskIndex = 0;
      job.taskTotal = 0;
      refreshLessonCache(); // обновим прогресс в списке
      broadcast();
    }

    // Занятия независимы (у каждого свой resultId), поэтому запускаем все сразу.
    async function worker() {
      while (!queue.stop) {
        var i = next++;
        if (i >= jobs.length) return;
        var job = jobs[i];
        try {
          await runJob(job);
        } catch (e) {
          failed++;
          job.status = 'error';
          job.taskIndex = 0;
          job.taskTotal = 0;
          toast('Ошибка на «' + job.name + '»: ' + ((e && e.message) || e), true);
          broadcast();
        }
      }
    }
    var workers = [];
    // Разные занятия пишут в разные resultId, поэтому лимит не нужен: запускаем
    // все сразу. MAX_PARALLEL > 0 остаётся как страховка от троттлинга сервера.
    var count = (MAX_PARALLEL > 0) ? Math.min(MAX_PARALLEL, jobs.length) : jobs.length;
    for (var w = 0; w < count; w++) workers.push(worker());
    await Promise.all(workers);

    // Повтор упавших занятий: обычно это транзиентные 429/сеть.
    var failedJobs = jobs.filter(function (j) { return j.status === 'error'; });
    if (failedJobs.length && !queue.stop) {
      setStatus('Повтор упавших занятий (' + failedJobs.length + ')…');
      await sleep(1500);
      failed = 0;
      for (var f = 0; f < failedJobs.length; f++) {
        if (queue.stop) break;
        try {
          await runJob(failedJobs[f]);
        } catch (e) {
          failed++;
          failedJobs[f].status = 'error';
          failedJobs[f].taskIndex = 0;
          failedJobs[f].taskTotal = 0;
          toast('Повтор не удался на «' + failedJobs[f].name + '»: ' + ((e && e.message) || e), true);
        }
      }
    }

    queue.running = false;
    setStatus((queue.stop ? 'Остановлено' : 'Готово') +
      ' — решено ' + solved + ' из ' + jobs.length + (failed ? (', ошибок: ' + failed) : ''));
  }

  function stopSolving() {
    if (!queue.running) return;
    queue.stop = true;
    setStatus('Останавливаю…');
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) return;
    if (message.type === 'bulk:getState') { sendResponse(status()); return true; }
    if (message.type === 'bulk:solveAll') { solveAll(); sendResponse({ ok: true }); return true; }
    if (message.type === 'bulk:solveOne') {
      if (queue.running) { sendResponse({ ok: false, reason: 'busy' }); return true; }
      var lesson = findLesson(message.id);
      if (!lesson) { sendResponse({ ok: false, reason: 'notfound' }); return true; }
      solveOne(lesson);
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'bulk:stop') { stopSolving(); sendResponse({ ok: true }); return true; }
    return false;
  });

  try {
    chrome.storage.local.get({ ybsTimeFrom: 7, ybsTimeTo: 13 }, function (values) {
      timeFrom = Number(values.ybsTimeFrom) || 7;
      timeTo = Number(values.ybsTimeTo) || 13;
      broadcast();
    });
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (changes.ybsTimeFrom) timeFrom = Number(changes.ybsTimeFrom.newValue) || timeFrom;
      if (changes.ybsTimeTo) timeTo = Number(changes.ybsTimeTo.newValue) || timeTo;
    });
  } catch (e) {}

  refreshLessonCache();
  var cacheTimer = setInterval(function () { if (!queue.running) refreshLessonCache(); }, 15000);
  if (cacheTimer && cacheTimer.unref) cacheTimer.unref();
})();

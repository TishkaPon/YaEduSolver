/* bulk.js — окно управления: «Решить все», стоп, список занятий и примерное время. */
'use strict';

var DEFAULT_SLOW = true;
var DEFAULT_FROM = 7;
var DEFAULT_TO = 13;

// Флаг сборки из config.js: показывать ли ручной ввод времени.
var CFG = (typeof globalThis !== 'undefined' && globalThis.YBSConfig) || {};
var ADVANCED = CFG.advanced === true;

// Приводим промежуток к виду «левое не больше правого», 0—0 допустимо.
function normalizeRange(from, to) {
  if (typeof CFG.normalizeRange === 'function') return CFG.normalizeRange(from, to);
  return { from: DEFAULT_FROM, to: DEFAULT_TO };
}

// Быстрый режим (реального ожидания нет): ~0.8 с на задание (ответ + пауза +
// нагрузка), ~1.5 с на занятие (загрузка/старт/сдача) и ~0.13 с на каждое
// занятие очереди (порционные старты, редкие повторы).
var SECONDS_PER_TASK = 0.8;
var SECONDS_PER_LESSON = 1.5;
var PER_QUEUE_ITEM = 0.13;
var PARALLEL_EST = 0; // 0 — все занятия сразу

// Медленный режим (по умолчанию): реально выжидаем время решения. Теория 2–5 с,
// страница с практикой 27–48 с; занятия идут строго по очереди.
var SLOW_SECONDS_PER_TASK = 37.5;
var SLOW_THEORY_SECONDS = 3.5;
var SLOW_SECONDS_PER_LESSON = 2;

var state = null;
var courseTabId = null;
var lastListKey = null; // подпись списка — чтобы не пересобирать DOM без изменений

function el(id) { return document.getElementById(id); }

function formatDuration(seconds) {
  var sec = Math.max(0, Math.round(seconds));
  if (sec < 60) return sec + ' сек';
  var min = Math.floor(sec / 60);
  var rest = sec % 60;
  return rest ? (min + ' мин ' + rest + ' сек') : (min + ' мин');
}

function plural(n, one, few, many) {
  var mod10 = n % 10;
  var mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

// Сколько займёт оставшаяся часть занятия в медленном режиме. Теория проходится
// быстро и обычно идёт в начале, поэтому остаток считаем практикой: если осталось
// 7 слайдов при 7 практических — это 7 × 37,5 с, а не средняя цена слайда.
function slowLessonSeconds(left, composition) {
  if (!left) return 0;
  if (!composition || !composition.total) return left * SLOW_SECONDS_PER_TASK;
  var practice = composition.practice || 0;
  var practiceLeft = Math.min(left, practice);
  var theoryLeft = left - practiceLeft;
  return practiceLeft * SLOW_SECONDS_PER_TASK + theoryLeft * SLOW_THEORY_SECONDS;
}

// Сколько времени «в зачёт» уйдёт на занятие. С ручным промежутком — среднее из
// промежутка (пропорционально остатку), иначе — по составу занятия.
function emulatedLessonSeconds(lesson, custom) {
  var left = lessonLeft(lesson);
  if (!left) return 0;
  if (custom && custom.on && Number(custom.to) > 0) {
    var avg = ((Number(custom.from) || 0) + (Number(custom.to) || 0)) / 2 * 60;
    return lesson.total ? avg * (left / lesson.total) : avg;
  }
  return SLOW_SECONDS_PER_LESSON + slowLessonSeconds(left, lesson.composition);
}

// Оценка длительности очереди. В медленном режиме это реальное (и оно же
// записанное) время, в быстром — сколько реально займёт отправка.
function estimate(lessons, slow, custom) {
  var tasks = 0;
  var count = 0;
  var maxLeft = 0;
  var totalFast = 0; // быстрый: сумма, потом делим на параллельность
  var totalSlow = 0; // медленный: занятия идут строго по очереди
  (lessons || []).forEach(function (lesson) {
    if (lesson.total == null) return;
    var left = Math.max(0, lesson.total - (lesson.done || 0));
    count++;
    tasks += left;
    if (left > maxLeft) maxLeft = left;
    totalFast += SECONDS_PER_LESSON + left * SECONDS_PER_TASK;
    totalSlow += emulatedLessonSeconds(lesson, custom);
  });
  var overhead = count * PER_QUEUE_ITEM;
  // totalSlow — это и есть время, которое уйдёт «в зачёт» (его эмулирует решатель).
  if (slow) return { tasks: tasks, count: count, seconds: totalSlow + overhead, emulated: totalSlow, slow: true };
  var parallel = PARALLEL_EST > 0 ? Math.max(1, Math.min(PARALLEL_EST, count || 1)) : (count || 1);
  // Все занятия сразу — время ≈ самое длинное; иначе делим объём на воркеры.
  var seconds = (count <= parallel)
    ? (maxLeft * SECONDS_PER_TASK + SECONDS_PER_LESSON + overhead)
    : (totalFast / parallel + overhead);
  return { tasks: tasks, count: count, seconds: seconds, emulated: totalSlow, slow: false };
}

// В быстром режиме в скобках — сколько времени решатель проставит в зачёт.
function emulateSuffix(est, slow) {
  if (slow || !est.emulated) return '';
  return ' (' + formatDuration(est.emulated) + ')';
}

function lessonLeft(lesson) {
  if (lesson.total == null) return 0;
  return Math.max(0, lesson.total - (lesson.done || 0));
}

function queryActiveTab() {
  return new Promise(function (resolve) {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        void chrome.runtime.lastError;
        resolve(tabs && tabs[0] ? tabs[0] : null);
      });
    } catch (e) { resolve(null); }
  });
}

function sendToTab(tabId, message) {
  return new Promise(function (resolve) {
    try {
      chrome.tabs.sendMessage(tabId, message, function (response) {
        void chrome.runtime.lastError;
        resolve(response || null);
      });
    } catch (e) { resolve(null); }
  });
}

function isCoursePage(url) {
  return /^https:\/\/education\.yandex\.ru\/classroom\/courses\//.test(String(url || ''));
}

function render() {
  var s = state || { running: false, stopping: false, slow: DEFAULT_SLOW, index: 0, total: 0, active: 0, activeIds: [], currentId: null, text: '', tab: 'active', lessons: [] };
  var slow = s.slow !== false;
  var custom = s.customTime || null;
  var runBtn = el('runAll');
  runBtn.textContent = s.running ? (s.stopping ? 'Останавливаю…' : 'Остановить') : 'Решить все';
  runBtn.classList.toggle('stop', !!s.running);
  runBtn.disabled = !!(s.running && s.stopping);

  var box = el('statusBox');
  var showStatus = !!s.running || (!!s.text && s.text !== 'Готово');
  box.hidden = !showStatus;
  if (showStatus) {
    var prefix = (s.running && s.active > 1) ? (s.active + ' занятия · ') : '';
    el('statusText').textContent = prefix + (s.text || 'Работаю…');
    var pct = (s.running && s.total) ? Math.round((s.index / s.total) * 100) : 100;
    el('barFill').style.width = Math.max(0, Math.min(100, pct)) + '%';
  }

  var est = estimate(s.lessons, slow, custom);
  el('est').textContent = est.tasks
    ? ('≈ ' + formatDuration(est.seconds) + emulateSuffix(est, slow) + ' · ' + est.tasks + ' ' + plural(est.tasks, 'задача', 'задачи', 'задач'))
    : '';

  if (s.tab === 'finished') {
    el('hint').textContent = 'Открыта вкладка «Сдано». Переключитесь на «Задано».';
  } else if (!s.lessons.length) {
    el('hint').textContent = 'Незакрытых занятий нет.';
  } else {
    el('hint').textContent = 'Занятий: ' + s.lessons.length + '.';
  }

  // Пересобираем список только когда данные реально изменились: иначе кнопка
  // под курсором пересоздаётся, и hover («Решить» → синяя) мигает каждые 1.5 с.
  var activeIds = s.activeIds || (s.currentId == null ? [] : [s.currentId]);
  var listKey = JSON.stringify({
    running: !!s.running,
    slow: slow,
    active: activeIds.map(String),
    items: s.lessons.map(function (lesson) {
      var c = lesson.composition;
      return [lesson.id, lesson.name, lesson.done, lesson.total, c ? c.theory : -1, c ? c.practice : -1];
    })
  });
  if (listKey === lastListKey) return;
  lastListKey = listKey;

  var list = el('lessonList');
  list.textContent = '';
  s.lessons.forEach(function (lesson) {
    var row = document.createElement('div');
    row.className = 'lesson';

    var info = document.createElement('div');
    info.className = 'lesson-info';
    var name = document.createElement('div');
    name.className = 'lesson-name';
    name.textContent = lesson.name;
    name.title = lesson.name;
    var sub = document.createElement('div');
    sub.className = 'lesson-sub';
    var left = lessonLeft(lesson);
    var text = (lesson.total == null) ? '—' : (lesson.done + ' / ' + lesson.total);
    if (left) {
      var emulated = emulatedLessonSeconds(lesson, custom);
      if (slow) {
        text += ' · ≈ ' + formatDuration(emulated);
      } else {
        text += ' · ≈ ' + formatDuration(SECONDS_PER_LESSON + left * SECONDS_PER_TASK) +
          ' (' + formatDuration(emulated) + ')';
      }
    }
    sub.textContent = text;
    info.appendChild(name);
    info.appendChild(sub);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lesson-btn';
    var current = activeIds.some(function (id) { return String(id) === String(lesson.id); });
    btn.textContent = (current && s.running) ? '…' : 'Решить';
    btn.disabled = !!s.running;
    btn.addEventListener('click', function () { solveOne(lesson.id); });

    row.appendChild(info);
    row.appendChild(btn);
    list.appendChild(row);
  });
}

function showNoCourse() {
  lastListKey = null;
  el('runAll').disabled = true;
  el('runAll').classList.remove('stop');
  el('est').textContent = '';
  el('lessonList').textContent = '';
  el('statusBox').hidden = true;
  el('hint').textContent = 'Откройте страницу курса.';
}

async function refresh() {
  var tab = await queryActiveTab();
  courseTabId = (tab && isCoursePage(tab.url)) ? tab.id : null;
  if (!courseTabId) { showNoCourse(); return; }
  var s = await sendToTab(courseTabId, { type: 'bulk:getState' });
  if (s) { state = s; render(); }
  else {
    lastListKey = null;
    el('runAll').disabled = false;
    el('est').textContent = '';
    el('lessonList').textContent = '';
    el('statusBox').hidden = true;
    el('hint').textContent = 'Обновите страницу (F5) и откройте окно снова.';
  }
}

function startAll() {
  if (!courseTabId) return;
  el('runAll').disabled = true;
  sendToTab(courseTabId, { type: 'bulk:solveAll' }).then(refresh);
}

function stopAll() {
  if (!courseTabId) return;
  sendToTab(courseTabId, { type: 'bulk:stop' });
}

function solveOne(id) {
  if (!courseTabId || !state || state.running) return;
  sendToTab(courseTabId, { type: 'bulk:solveOne', id: id }).then(function (r) {
    if (!r || r.ok === false) refresh();
  });
}

function showMenu() {
  el('menuView').hidden = false;
  el('settingsView').hidden = true;
  el('settingsBtn').hidden = false;
  el('backBtn').hidden = true;
  el('title').textContent = 'Яндекс Учебник';
}

function showSettings() {
  el('menuView').hidden = true;
  el('settingsView').hidden = false;
  el('settingsBtn').hidden = true;
  el('backBtn').hidden = false;
  el('title').textContent = 'Настройки';
  el('timeBox').hidden = !ADVANCED;
}

// Тумблер называется «Быстрый режим»: выключен (по умолчанию) — медленный.
// В хранилище по-прежнему флаг ybsSlowMode, чтобы не ломать уже сохранённое.
function loadFast() {
  chrome.storage.local.get({ ybsSlowMode: DEFAULT_SLOW }, function (values) {
    el('fastMode').checked = values.ybsSlowMode === false;
  });
}

function saveFast() {
  var fast = !!el('fastMode').checked;
  chrome.storage.local.set({ ybsSlowMode: !fast }, function () {
    flash(fast ? 'Быстрый режим включён' : 'Медленный режим включён');
  });
}

function flash(text) {
  el('saved').textContent = text;
  setTimeout(function () { el('saved').textContent = ''; }, 1600);
}

function loadTime() {
  chrome.storage.local.get({ ybsTimeFrom: DEFAULT_FROM, ybsTimeTo: DEFAULT_TO, ybsUseTime: false }, function (values) {
    var range = normalizeRange(values.ybsTimeFrom, values.ybsTimeTo);
    el('timeFrom').value = range.from;
    el('timeTo').value = range.to;
    el('useTime').checked = values.ybsUseTime === true;
  });
}

// Пишем как есть (0—0 допустимо), «наоборот» разворачиваем прямо в поле.
function saveTime() {
  var range = normalizeRange(el('timeFrom').value, el('timeTo').value);
  el('timeFrom').value = range.from;
  el('timeTo').value = range.to;
  chrome.storage.local.set({ ybsTimeFrom: range.from, ybsTimeTo: range.to }, function () {
    flash('Промежуток: ' + range.from + '–' + range.to + ' мин');
  });
}

function saveUseTime() {
  var use = !!el('useTime').checked;
  chrome.storage.local.set({ ybsUseTime: use }, function () {
    flash(use ? 'Время берём из промежутка' : 'Время считаем автоматически');
  });
}

function init() {
  loadFast();
  el('settingsBtn').addEventListener('click', showSettings);
  el('backBtn').addEventListener('click', showMenu);
  el('runAll').addEventListener('click', function () {
    if (state && state.running) stopAll(); else startAll();
  });
  el('fastMode').addEventListener('change', saveFast);
  el('timeBox').hidden = !ADVANCED;
  if (ADVANCED) {
    loadTime();
    el('useTime').addEventListener('change', saveUseTime);
    el('timeFrom').addEventListener('change', saveTime);
    el('timeTo').addEventListener('change', saveTime);
  }

  chrome.runtime.onMessage.addListener(function (message, sender) {
    if (!message || message.type !== 'bulk:state') return;
    if (courseTabId != null && sender && sender.tab && sender.tab.id !== courseTabId) return;
    state = message.state;
    render();
  });

  refresh();
  setInterval(refresh, 1500);
}

document.addEventListener('DOMContentLoaded', init);

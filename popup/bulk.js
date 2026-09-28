/* bulk.js — окно управления: «Решить все», стоп, список занятий и примерное время. */
'use strict';

var DEFAULT_FROM = 7;
var DEFAULT_TO = 13;

// Оценка по замерам реального прогона: ~0.8 с на задание (ответ + пауза + нагрузка),
// ~1.5 с на занятие (загрузка/старт/сдача) и ~0.13 с на каждое занятие очереди
// (порционные старты, редкие повторы). Пример: 26 задач + 24 занятия ≈ 25 с.
var SECONDS_PER_TASK = 0.8;
var SECONDS_PER_LESSON = 1.5;
var PER_QUEUE_ITEM = 0.13;
var PARALLEL_EST = 0; // 0 — все занятия сразу

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

function estimate(lessons) {
  var tasks = 0;
  var count = 0;
  var maxLeft = 0;
  (lessons || []).forEach(function (lesson) {
    if (lesson.total == null) return;
    var left = Math.max(0, lesson.total - (lesson.done || 0));
    count++;
    tasks += left;
    if (left > maxLeft) maxLeft = left;
  });
  var parallel = PARALLEL_EST > 0 ? Math.max(1, Math.min(PARALLEL_EST, count || 1)) : (count || 1);
  // Если занятий не больше лимита — они идут одновременно, время ≈ самое
  // длинное занятие. Иначе — делим общий объём на число воркеров.
  var overhead = count * PER_QUEUE_ITEM;
  var seconds = (count <= parallel)
    ? (maxLeft * SECONDS_PER_TASK + SECONDS_PER_LESSON + overhead)
    : ((count * SECONDS_PER_LESSON + tasks * SECONDS_PER_TASK) / parallel + overhead);
  return { tasks: tasks, count: count, parallel: parallel, seconds: seconds };
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
  var s = state || { running: false, stopping: false, index: 0, total: 0, active: 0, activeIds: [], currentId: null, text: '', tab: 'active', lessons: [] };
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

  var est = estimate(s.lessons);
  el('est').textContent = est.tasks
    ? ('≈ ' + formatDuration(est.seconds) + ' · ' + est.tasks + ' ' + plural(est.tasks, 'задача', 'задачи', 'задач'))
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
    active: activeIds.map(String),
    items: s.lessons.map(function (lesson) {
      return [lesson.id, lesson.name, lesson.done, lesson.total];
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
    if (left) text += ' · ≈ ' + formatDuration(SECONDS_PER_LESSON + left * SECONDS_PER_TASK);
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
}

function loadTime() {
  chrome.storage.local.get({ ybsTimeFrom: DEFAULT_FROM, ybsTimeTo: DEFAULT_TO }, function (values) {
    el('timeFrom').value = values.ybsTimeFrom;
    el('timeTo').value = values.ybsTimeTo;
  });
}

function saveTime() {
  var from = parseInt(el('timeFrom').value, 10);
  var to = parseInt(el('timeTo').value, 10);
  if (!isFinite(from) || from < 1) from = DEFAULT_FROM;
  if (!isFinite(to) || to < from) to = from;
  el('timeFrom').value = from;
  el('timeTo').value = to;
  chrome.storage.local.set({ ybsTimeFrom: from, ybsTimeTo: to }, function () {
    el('saved').textContent = 'Сохранено: ' + from + '–' + to + ' мин';
    setTimeout(function () { el('saved').textContent = ''; }, 1600);
  });
}

function init() {
  loadTime();
  el('settingsBtn').addEventListener('click', showSettings);
  el('backBtn').addEventListener('click', showMenu);
  el('runAll').addEventListener('click', function () {
    if (state && state.running) stopAll(); else startAll();
  });
  el('timeFrom').addEventListener('change', saveTime);
  el('timeTo').addEventListener('change', saveTime);

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

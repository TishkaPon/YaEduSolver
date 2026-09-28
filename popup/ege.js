/*
 * ege.js — при открытии сразу показывает ответ задания, на котором
 * сейчас находится пользователь (позиция берётся из адреса /task/N).
 * Кнопка «Заполнить и сохранить» заполняет поля, жмёт «Сохранить ответ»
 * и переходит к следующему заданию.
 */
'use strict';

var tabId = null;
var tabUrl = '';
var retried = false;
var currentTask = null;

function el(id) { return document.getElementById(id); }

function isYandex(url) {
  return /^https:\/\/education\.yandex\.ru\//.test(String(url || ''));
}

function currentFromUrl(url) {
  var match = String(url || '').match(/\/task\/(\d+)(?:[/?#]|$)/);
  return match ? Number(match[1]) : null;
}

function sendTab(message, timeout) {
  timeout = timeout || 2500;
  return new Promise(function (resolve) {
    if (tabId === null) { resolve(null); return; }
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; resolve(null); } }, timeout);
    try {
      chrome.tabs.sendMessage(tabId, message, function (response) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(response || null);
      });
    } catch (e) {
      if (!done) { done = true; clearTimeout(timer); resolve(null); }
    }
  });
}

function getStored() {
  return new Promise(function (resolve) {
    if (tabId === null) { resolve(null); return; }
    try {
      chrome.runtime.sendMessage({ type: 'ege:getStored', tabId: tabId }, function (response) {
        if (chrome.runtime.lastError || !response || !response.record) { resolve(null); return; }
        resolve(response.record.report || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function answerText(task) {
  return (task.answers || []).map(function (entry) { return entry.text || '—'; }).join('\n');
}

/** Текущее задание: позиция из /task/N, иначе единственное задание. */
function pickTask(report) {
  if (!report || !report.tasks || !report.tasks.length) return null;
  var current = report.current;
  if (current === null || current === undefined) current = currentFromUrl(tabUrl);
  if (current !== null && current !== undefined) {
    for (var i = 0; i < report.tasks.length; i++) {
      if (Number(report.tasks[i].position) === Number(current)) return report.tasks[i];
    }
  }
  if (report.tasks.length === 1) return report.tasks[0];
  return null;
}

function showEmpty(title, text) {
  el('answerCard').hidden = true;
  el('fillBtn').hidden = true;
  el('emptyCard').hidden = false;
  el('emptyTitle').textContent = title;
  el('emptyText').textContent = text || '';
}

function render(report) {
  var task = pickTask(report);
  currentTask = task;

  if (!task) {
    if (!isYandex(tabUrl)) {
      showEmpty('Откройте задание на education.yandex.ru', 'Ответ появится здесь автоматически.');
    } else if (!report || !report.tasks || !report.tasks.length) {
      showEmpty('Готовлю ответ…', 'Страница ещё загружается. Если пусто — обновите её (F5).');
    } else {
      showEmpty('Не удалось определить задание', 'Обновите страницу задания (F5) и откройте окно снова.');
    }
    return;
  }

  el('emptyCard').hidden = true;
  el('fillBtn').hidden = false;
  el('answerCard').hidden = false;
  el('answerValue').textContent = answerText(task);

  el('answerMeta').textContent = 'Задание ' + (task.label !== undefined && task.label !== '' ? task.label : task.position);
}

function fillCurrent() {
  var button = el('fillBtn');
  if (!currentTask) return;
  button.disabled = true;
  button.textContent = 'Заполняю…';
  sendTab({ type: 'ege:fill', position: currentTask.position }, 25000).then(function (response) {
    if (response && response.ok && response.advanced) {
      // Задание сменилось — сначала показываем его ответ, потом разблокируем.
      load().then(function () {
        button.textContent = 'Заполнить и сохранить';
        button.disabled = false;
      });
      return;
    }
    button.textContent = 'Заполнить и сохранить';
    button.disabled = false;
    if (!response || !response.ok) {
      el('answerMeta').textContent = 'Не удалось: ' + ((response && response.error) || 'ошибка');
    }
  });
}

function fetchState() {
  return sendTab({ type: 'ege:get' }, 3000).then(function (response) {
    if (response && response.ok) return response;
    return getStored();
  }).catch(function () {
    return null;
  });
}

function load() {
  return fetchState().then(function (report) {
    render(report);
    return report;
  });
}

function startUrlWatch() {
  if (tabId === null) return;
  var last = tabUrl;
  var timer = setInterval(function () {
    chrome.tabs.get(tabId, function (tab) {
      if (chrome.runtime.lastError || !tab) return;
      if (tab.url && tab.url !== last) {
        last = tab.url;
        tabUrl = tab.url;
        load();
      }
    });
  }, 700);
  window.addEventListener('unload', function () { clearInterval(timer); });
}

function init() {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs && tabs[0]) {
      tabId = tabs[0].id;
      tabUrl = tabs[0].url || '';
    }
    startUrlWatch();
    load().then(function (report) {
      // Данных ещё нет — один раз просим страницу запросить их заново.
      if (!pickTask(report) && isYandex(tabUrl) && !retried) {
        retried = true;
        sendTab({ type: 'ege:refetch' }, 2500).then(function () {
          setTimeout(load, 900);
        });
      }
    });
  });

  el('fillBtn').addEventListener('click', fillCurrent);
}

document.addEventListener('DOMContentLoaded', init);

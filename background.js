/* background.js — service worker YaEduSolver: отчёты ЕГЭ и бейдж решения занятий. */
'use strict';

function egeStorageKey(tabId) {
  return 'egeReport:' + String(tabId);
}

// ---------------- бейдж «идёт решение занятий» ----------------

var bulkRunning = {};

function setAction(tabId, text, color, title) {
  try {
    var value = (text == null) ? '' : String(text).slice(0, 6); // ~4 символа влезает комфортно, но Chrome принимает больше
    chrome.action.setBadgeText({ tabId: tabId, text: value });
    if (color) chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: color });
    if (title) chrome.action.setTitle({ tabId: tabId, title: title });
  } catch (e) {}
}

// «сколько из скольки»: «3/12». Держим до 5 знаков (Chrome советует ~4),
// если совсем длинно — оставляем хотя бы текущий номер, но никогда не точку.
function progressLabel(done, total) {
  if (!done || !total) return done ? String(done) : '';
  var text = done + '/' + total;
  return text.length <= 5 ? text : String(done);
}

// Решаем всё — прогресс занятий; решаем одно занятие — прогресс заданий.
function badgeTextFor(state) {
  var label = (state.mode === 'one')
    ? progressLabel(state.taskIndex, state.taskTotal)
    : progressLabel(state.index, state.total);
  return label || '…';
}

function titleFor(state) {
  var parts = [];
  if (state.mode !== 'one' && state.total) parts.push('занятие ' + state.index + '/' + state.total);
  if (state.taskIndex) parts.push('задание ' + state.taskIndex + (state.taskTotal ? ('/' + state.taskTotal) : ''));
  parts.push(state.text || 'решаю');
  return 'YaEduSolver: ' + parts.join(' · ');
}

function renderBulkBadge(sender, state) {
  var tabId = sender && sender.tab ? sender.tab.id : null;
  if (tabId === null || tabId === undefined) return;
  if (state && state.running) {
    bulkRunning[tabId] = true;
    setAction(tabId, badgeTextFor(state), '#4d6bfe', titleFor(state));
  } else if (bulkRunning[tabId]) {
    delete bulkRunning[tabId];
    setAction(tabId, '✓', '#2f9e6e', 'YaEduSolver: готово');
    setTimeout(function () { setAction(tabId, '', null, 'YaEduSolver'); }, 4000);
  } else {
    setAction(tabId, '', null, 'YaEduSolver');
  }
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !message.type) return false;

  if (message.type === 'bulk:state') {
    renderBulkBadge(sender, message.state);
    return false;
  }

  if (message.type === 'ege:report') {
    var tabId = sender && sender.tab ? sender.tab.id : null;
    if (tabId === null || tabId === undefined) {
      sendResponse({ ok: false });
      return true;
    }
    var patch = {};
    patch[egeStorageKey(tabId)] = { report: message.report, ts: Date.now() };
    try {
      chrome.storage.session.set(patch).then(function () {
        sendResponse({ ok: true });
      }).catch(function () {
        sendResponse({ ok: false });
      });
    } catch (e) {
      sendResponse({ ok: false });
    }
    return true;
  }

  if (message.type === 'ege:getStored') {
    var key = egeStorageKey(message.tabId);
    chrome.storage.session.get(key).then(function (values) {
      sendResponse({ ok: true, record: values[key] || null });
    }).catch(function () {
      sendResponse({ ok: false, record: null });
    });
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  try { chrome.storage.session.remove(egeStorageKey(tabId)); } catch (e) {}
  delete bulkRunning[tabId];
  setAction(tabId, '', null, 'YaEduSolver');
});

chrome.tabs.onUpdated.addListener(function (tabId, info) {
  if (info && info.status === 'loading' && bulkRunning[tabId]) {
    delete bulkRunning[tabId];
    setAction(tabId, '', null, 'YaEduSolver');
  }
});

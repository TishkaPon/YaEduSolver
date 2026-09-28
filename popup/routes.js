/*
 * routes.js — выбор окна:
 *   ЕГЭ (/ege/.../variants|collections) -> ege.html
 *   остальное (курс/занятия)             -> bulk.html
 */
'use strict';

var EGE_PAGE = /^https:\/\/education\.yandex\.ru\/ege\/[^?#]*\/(variants|collections)\//;

function target(url) {
  return EGE_PAGE.test(String(url || '')) ? 'ege.html' : 'bulk.html';
}

try {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var url = tabs && tabs[0] ? tabs[0].url || '' : '';
    location.replace(target(url));
  });
} catch (e) {
  location.replace('bulk.html');
}

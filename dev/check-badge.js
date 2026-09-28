/* dev/check-badge.js — логика бейджа иконки (через мок chrome). */
'use strict';
var fs = require('fs');
var path = require('path');
var assert = require('assert');

var calls = [];
globalThis.setTimeout = function () { return 0; };
globalThis.chrome = {
  action: {
    setBadgeText: function (o) { calls.push(['text', o.tabId, o.text]); },
    setBadgeBackgroundColor: function (o) { calls.push(['color', o.tabId, o.color]); },
    setTitle: function (o) { calls.push(['title', o.tabId, o.title]); }
  },
  runtime: { onMessage: { addListener: function () {} } },
  tabs: { onRemoved: { addListener: function () {} }, onUpdated: { addListener: function () {} } },
  storage: {
    session: {
      remove: function () {},
      set: function () { return Promise.resolve(); },
      get: function () { return Promise.resolve({}); }
    }
  }
};

var src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
src += '\n;globalThis.__badge = {' +
  ' progressLabel: progressLabel, badgeTextFor: badgeTextFor, titleFor: titleFor,' +
  ' setAction: setAction, renderBulkBadge: renderBulkBadge };';
eval(src);
var B = globalThis.__badge;

var problems = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { problems++; console.log('  XX  ' + name + ' -> ' + e.message); }
}
function lastText() { for (var i = calls.length - 1; i >= 0; i--) if (calls[i][0] === 'text') return calls[i][2]; return null; }

check('решаем все — прогресс занятий', function () {
  assert.strictEqual(B.badgeTextFor({ mode: 'all', total: 3, index: 2, taskIndex: 5, taskTotal: 10 }), '2/3');
});

check('решаем одно — прогресс заданий', function () {
  assert.strictEqual(B.badgeTextFor({ mode: 'one', total: 1, index: 1, taskIndex: 5, taskTotal: 22 }), '5/22');
});

check('двузначное не превращается в точку', function () {
  assert.strictEqual(B.badgeTextFor({ mode: 'all', total: 12, index: 10 }), '10/12');
  assert.strictEqual(B.badgeTextFor({ mode: 'one', total: 1, index: 1, taskIndex: 12, taskTotal: 22 }), '12/22');
});

check('слишком длинно — показываем текущий номер', function () {
  assert.strictEqual(B.progressLabel(123, 456), '123');
});

check('до старта — «…», не точка', function () {
  assert.strictEqual(B.badgeTextFor({ mode: 'all', total: 3, index: 0 }), '…');
  assert.strictEqual(B.badgeTextFor({ mode: 'one', total: 1, index: 1 }), '…');
});

check('setAction ограничивает длину', function () {
  calls.length = 0;
  B.setAction(9, '1234567', '#000', 't');
  assert.strictEqual(lastText(), '123456');
});

check('подпись содержит занятие и задание', function () {
  var t = B.titleFor({ mode: 'all', total: 12, index: 3, taskIndex: 5, taskTotal: 16, text: 'Решаю 5/16…' });
  assert(t.indexOf('занятие 3/12') !== -1, t);
  assert(t.indexOf('задание 5/16') !== -1, t);
});

check('нет чередования: одно и то же значение', function () {
  calls.length = 0;
  var state = { running: true, mode: 'all', total: 3, index: 1, taskIndex: 4, taskTotal: 10, text: 'Решаю 4/10…' };
  B.renderBulkBadge({ tab: { id: 1 } }, state);
  var first = lastText();
  B.renderBulkBadge({ tab: { id: 1 } }, state);
  var second = lastText();
  assert.strictEqual(first, '1/3');
  assert.strictEqual(second, '1/3');
});

check('running -> счётчик, стоп -> галочка', function () {
  calls.length = 0;
  B.renderBulkBadge({ tab: { id: 1 } }, { running: true, mode: 'one', total: 1, index: 1, taskIndex: 7, taskTotal: 22, text: 'Решаю 7/22…' });
  assert.strictEqual(lastText(), '7/22');
  B.renderBulkBadge({ tab: { id: 1 } }, { running: false, text: 'Готово' });
  assert.strictEqual(lastText(), '✓');
});

if (problems) { console.log('ПРОБЛЕМ: ' + problems); process.exit(1); }
console.log('Все проверки бейджа пройдены.');

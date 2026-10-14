/* dev/check-config.js — флаг Advanced settings и проверка промежутка. */
'use strict';
var path = require('path');
var assert = require('assert');
var C = require(path.join(__dirname, '..', 'config.js'));

var problems = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { problems++; console.log('  XX  ' + name + ' -> ' + e.message); }
}

check('Advanced settings — булев флаг сборки', function () {
  // Значение задаёт разработчик в config.js, поэтому проверяем только тип.
  assert.strictEqual(typeof C.advanced, 'boolean');
  assert.strictEqual(typeof C.DEFAULT_TIME_FROM, 'number');
  assert.strictEqual(typeof C.DEFAULT_TIME_TO, 'number');
});

check('промежуток: обычный случай', function () {
  assert.deepStrictEqual(C.normalizeRange(7, 13), { from: 7, to: 13 });
  assert.deepStrictEqual(C.normalizeRange(5, 5), { from: 5, to: 5 });
});

check('промежуток 0–0 разрешён', function () {
  assert.deepStrictEqual(C.normalizeRange(0, 0), { from: 0, to: 0 });
});

check('левое больше правого — разворачиваем', function () {
  assert.deepStrictEqual(C.normalizeRange(13, 7), { from: 7, to: 13 });
  assert.deepStrictEqual(C.normalizeRange(600, 1), { from: 1, to: 600 });
});

check('пустое/мусор/отрицательное — значения по умолчанию', function () {
  assert.deepStrictEqual(C.normalizeRange('', ''), { from: 7, to: 13 });
  assert.deepStrictEqual(C.normalizeRange(null, undefined), { from: 7, to: 13 });
  assert.deepStrictEqual(C.normalizeRange(-5, -1), { from: 7, to: 13 });
  assert.deepStrictEqual(C.normalizeRange('abc', 'xyz'), { from: 7, to: 13 });
});

check('строки и дробные приводятся к целым', function () {
  assert.deepStrictEqual(C.normalizeRange('10', '20'), { from: 10, to: 20 });
  assert.deepStrictEqual(C.normalizeRange(10.9, 20.2), { from: 10, to: 20 });
});

if (problems) { console.log('ПРОБЛЕМ: ' + problems); process.exit(1); }
console.log('Все проверки config пройдены.');

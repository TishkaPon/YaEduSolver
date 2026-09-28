/* dev/check-content.js — проверка distributeTime из content.js. */
'use strict';
var fs = require('fs');
var path = require('path');
var assert = require('assert');

var candidates = ['../src/content.js', '../bulk/content.js'];
var file = null;
for (var i = 0; i < candidates.length; i++) {
  var p = path.join(__dirname, candidates[i]);
  if (fs.existsSync(p)) { file = p; break; }
}
if (!file) throw new Error('content.js не найден');

// Вырезаем чистую функцию distributeTime из IIFE и тестируем её как есть.
var src = fs.readFileSync(file, 'utf8');
var start = src.indexOf('function distributeTime');
assert(start >= 0, 'distributeTime не найдена');
var depth = 0, end = -1;
for (var j = src.indexOf('{', start); j < src.length; j++) {
  if (src[j] === '{') depth++;
  else if (src[j] === '}') { depth--; if (!depth) { end = j + 1; break; } }
}
var distributeTime = eval('(' + src.slice(start, end) + ')');

var problems = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { problems++; console.log('  XX  ' + name + ' -> ' + e.message); }
}
var sum = function (a) { return a.reduce(function (x, y) { return x + y; }, 0); };

check('сумма ровно равна цели, минимум соблюдён', function () {
  for (var t = 0; t < 5000; t++) {
    var total = Math.floor(Math.random() * 900);
    var count = 1 + Math.floor(Math.random() * 20);
    var a = distributeTime(total, count, 8);
    assert.strictEqual(a.length, count);
    assert.strictEqual(sum(a), total, 'сумма ' + sum(a) + ' != ' + total);
    var floor = Math.min(8, Math.floor(total / count));
    a.forEach(function (v) { assert(v >= floor, 'значение ' + v + ' < ' + floor); });
  }
});

check('распределение неравномерное (не поровну)', function () {
  var uneven = 0;
  for (var t = 0; t < 200; t++) {
    var a = distributeTime(600, 10, 8);
    if (Math.max.apply(null, a) - Math.min.apply(null, a) > 20) uneven++;
  }
  assert(uneven > 150, 'слишком ровное: ' + uneven + '/200');
});

check('мало времени на много заданий — сумма всё равно точная', function () {
  assert.strictEqual(sum(distributeTime(30, 12, 8)), 30);
});

check('нет перекоса по позициям', function () {
  var n = 10, runs = 20000, pos = new Array(n).fill(0);
  for (var r = 0; r < runs; r++) {
    var a = distributeTime(720, n, 8);
    for (var k = 0; k < n; k++) pos[k] += a[k];
  }
  var avg = 720 / n;
  pos.forEach(function (v, k) {
    var mean = v / runs;
    assert(Math.abs(mean - avg) < avg * 0.05, 'позиция ' + k + ': ' + mean.toFixed(1));
  });
});

if (problems) { console.log('ПРОБЛЕМ: ' + problems); process.exit(1); }
console.log('Все проверки distributeTime пройдены.');

/* dev/check-content.js — проверка расчёта времени и режимов из content.js. */
'use strict';
var fs = require('fs');
var path = require('path');
var assert = require('assert');

function pick(candidates) {
  for (var i = 0; i < candidates.length; i++) {
    var p = path.join(__dirname, candidates[i]);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

var contentFile = pick(['../src/content.js', '../bulk/content.js']);
if (!contentFile) throw new Error('content.js не найден');

var src = fs.readFileSync(contentFile, 'utf8');

// Вырезаем функции из IIFE и собираем обратно с нужным окружением.
function extract(name) {
  var start = src.indexOf('function ' + name);
  assert(start >= 0, name + ' не найдена');
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6; // сохраняем async
  var depth = 0, end = -1;
  for (var j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) { end = j + 1; break; } }
  }
  return src.slice(start, end);
}

function constant(name) {
  var m = src.match(new RegExp('var ' + name + '\\s*=\\s*(\\d+)'));
  assert(m, 'нет константы ' + name);
  return Number(m[1]);
}

var PRACTICE_MIN = constant('PRACTICE_MIN'), PRACTICE_MAX = constant('PRACTICE_MAX');
var THEORY_MIN = constant('THEORY_MIN'), THEORY_MAX = constant('THEORY_MAX');

var stepSeconds = new Function('PRACTICE_MIN', 'PRACTICE_MAX', 'THEORY_MIN', 'THEORY_MAX',
  extract('randomInt') + '\n' + extract('stepSeconds') + '\nreturn stepSeconds;')(
  PRACTICE_MIN, PRACTICE_MAX, THEORY_MIN, THEORY_MAX);

function makeWorker(slow, max) {
  return new Function('slowMode', 'MAX_PARALLEL',
    extract('workerCount') + '\nreturn workerCount;')(slow, max);
}

var problems = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { problems++; console.log('  XX  ' + name + ' -> ' + e.message); }
}

check('константы: практика 27–48 с, теория 2–5 с', function () {
  assert.strictEqual(PRACTICE_MIN, 27);
  assert.strictEqual(PRACTICE_MAX, 48);
  assert.strictEqual(THEORY_MIN, 2);
  assert.strictEqual(THEORY_MAX, 5);
});

check('теория: всегда 2–5 с', function () {
  for (var i = 0; i < 2000; i++) {
    var s = stepSeconds({ kind: 'theory' });
    assert(s >= THEORY_MIN && s <= THEORY_MAX, 'вышло ' + s);
  }
});

check('практика: одинаковое время независимо от числа полей', function () {
  var one = { kind: 'practice', answer: { '1': { user_answer: { '1': '35' } } } };
  var many = { kind: 'practice', answer: { '1': { user_answer: { '1': 'а', '2': 'б', '3': 'в', '4': 'г' } } } };
  var web = { kind: 'web' };
  var empty = { kind: 'practice', answer: {} };
  for (var i = 0; i < 2000; i++) {
    [one, many, web, empty].forEach(function (step) {
      var s = stepSeconds(step);
      assert(s >= PRACTICE_MIN && s <= PRACTICE_MAX, 'вышло ' + s);
    });
  }
});

check('весь диапазон практики достижим', function () {
  var lo = false, hi = false;
  for (var i = 0; i < 4000; i++) {
    var s = stepSeconds({ kind: 'practice' });
    if (s === PRACTICE_MIN) lo = true;
    if (s === PRACTICE_MAX) hi = true;
  }
  assert(lo && hi, 'диапазон обрезан: min=' + lo + ' max=' + hi);
});

check('медленный режим: одно занятие за раз', function () {
  assert.strictEqual(makeWorker(true, 0)(10), 1);
  assert.strictEqual(makeWorker(true, 3)(10), 1);
  assert.strictEqual(makeWorker(true, 0)(1), 1);
});

check('быстрый режим: без лимита — все сразу', function () {
  assert.strictEqual(makeWorker(false, 0)(10), 10);
  assert.strictEqual(makeWorker(false, 2)(10), 2);
  assert.strictEqual(makeWorker(false, 5)(3), 3);
});

// --- ручной промежуток времени (Advanced settings) ---
var distributeTime = new Function(extract('distributeTime') + '\nreturn distributeTime;')();

function makeTimePlan(advanced, useCustom, from, to) {
  return new Function('advancedSettings', 'useCustomTime', 'timeFrom', 'timeTo',
    'distributeTime', 'stepSeconds',
    extract('buildTimePlan') + '\nreturn buildTimePlan;')(
    function () { return advanced; }, useCustom, from, to, distributeTime, stepSeconds);
}
var STEPS = [{ kind: 'practice' }, { kind: 'theory' }, { kind: 'practice' }, { kind: 'skip' }];

check('distributeTime: сумма ровно равна цели', function () {
  for (var t = 0; t < 500; t++) {
    var total = Math.floor(Math.random() * 900);
    var count = 1 + Math.floor(Math.random() * 20);
    var a = distributeTime(total, count, 8);
    assert.strictEqual(a.length, count);
    assert.strictEqual(a.reduce(function (x, y) { return x + y; }, 0), total);
    a.forEach(function (v) { assert(v >= 0, 'отрицательное значение ' + v); });
  }
});

check('distributeTime: 0 секунд — все кусочки нулевые', function () {
  assert.deepStrictEqual(distributeTime(0, 4, 8), [0, 0, 0, 0]);
});

check('без галочки промежуток не используется', function () {
  var plan = makeTimePlan(true, false, 1, 1)({ spentTime: 0 }, STEPS);
  assert.strictEqual(plan.anchors.length, 3, 'skip не учитываем');
  plan.slices.forEach(function (s) {
    assert(s >= 2 && s <= 48, 'не авто-время: ' + s);
  });
});

check('с галочкой: сумма равна цели из промежутка', function () {
  var plan = makeTimePlan(true, true, 1, 1)({ spentTime: 0 }, STEPS);
  assert.strictEqual(plan.anchors.length, 3);
  assert.strictEqual(plan.slices.reduce(function (x, y) { return x + y; }, 0), 60);
});

check('промежуток 0–0: все кусочки нулевые (запросы не уйдут)', function () {
  var plan = makeTimePlan(true, true, 0, 0)({ spentTime: 0 }, STEPS);
  assert.deepStrictEqual(plan.slices, [0, 0, 0]);
  // и даже если занятие уже что-то потратило — тоже ничего не доначисляем
  var plan2 = makeTimePlan(true, true, 0, 0)({ spentTime: 120 }, STEPS);
  assert.deepStrictEqual(plan2.slices, [0, 0, 0]);
});

check('уже потрачено больше цели — нули, а не отрицательные', function () {
  var plan = makeTimePlan(true, true, 1, 1)({ spentTime: 600 }, STEPS);
  assert.deepStrictEqual(plan.slices, [0, 0, 0]);
});

// --- waitTime: ждём ровно запрошенное и не висим после «Остановить» ---
(async function () {
  // --- отправка времени: с нулём запрос не должен уходить вообще ---
  var spentCalls = 0;
  var sendSpentSlice = new Function('postJsonRetry', 'API_SPENT', 'CONFLICT_DELAY', 'uuid',
    extract('sendSpentSlice') + '\nreturn sendSpentSlice;')(
    function () { spentCalls++; return Promise.resolve({ ok: true }); },
    '/api/spent/', 900, function () { return 'id'; });

  await sendSpentSlice({ resultId: 1, sk: 'sk' }, { problemLinkId: 2 }, 0);
  check('0 секунд — запрос времени не уходит', function () {
    assert.strictEqual(spentCalls, 0, 'запросов: ' + spentCalls);
  });

  await sendSpentSlice({ resultId: 1, sk: 'sk' }, { problemLinkId: 2 }, 30);
  check('ненулевое время — запрос уходит', function () {
    assert.strictEqual(spentCalls, 1, 'запросов: ' + spentCalls);
  });

  var realNow = Date.now;
  var clock = 0;
  Date.now = function () { return clock; };
  try {
    var queue = { stop: false };
    var waited = 0;
    var sleepStub = function (ms) { waited += ms; clock += ms; return Promise.resolve(); };
    var waitTime = new Function('queue', 'sleep',
      extract('waitTime') + '\nreturn waitTime;')(queue, sleepStub);

    await waitTime(500);
    check('waitTime: выжидает запрошенное время', function () {
      assert.strictEqual(waited, 500, 'выждано ' + waited);
    });

    queue.stop = true;
    waited = 0;
    clock = 0;
    await waitTime(60000);
    check('waitTime: «Остановить» прерывает ожидание', function () {
      assert.strictEqual(waited, 0, 'выждано ' + waited);
    });
  } finally {
    Date.now = realNow;
  }

  if (problems) { console.log('ПРОБЛЕМ: ' + problems); process.exit(1); }
  console.log('Все проверки времени пройдены.');
})();

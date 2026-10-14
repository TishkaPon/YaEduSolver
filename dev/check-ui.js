/* dev/check-ui.js — список занятий и обработчик сообщений content.js (минимальный DOM). */
'use strict';
var fs = require('fs');
var path = require('path');
var assert = require('assert');

function pick(cands) {
  for (var i = 0; i < cands.length; i++) {
    var p = path.join(__dirname, cands[i]);
    if (fs.existsSync(p)) return p;
  }
  throw new Error('файл не найден: ' + cands.join(', '));
}
var solverPath = pick(['../src/solver.js', '../bulk/solver.js']);
var contentPath = pick(['../src/content.js', '../bulk/content.js']);

function node(extra) {
  return Object.assign({
    children: [], style: {}, __attrs: {},
    appendChild: function (c) { this.children.push(c); return c; },
    removeChild: function () {},
    setAttribute: function (k, v) { this.__attrs[k] = v; },
    getAttribute: function (k) { return this.__attrs[k] == null ? null : this.__attrs[k]; },
    addEventListener: function () {},
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    getClientRects: function () { return [{ width: 10 }]; },
    closest: function () { return null; },
    insertAdjacentElement: function () {},
    remove: function () {}
  }, extra || {});
}

function makeLesson(name, href, done, total) {
  var nameEl = node({ textContent: name });
  var titleEl = node({ textContent: done + ' ' + total });
  var qs = function (sel) {
    if (sel === '.student-lessons-view__lesson-name-text') return nameEl;
    if (sel === '.progress-circle__title') return titleEl;
    return null;
  };
  var wrapper = node({ querySelector: qs });
  return node({
    textContent: name,
    getAttribute: function (k) { return k === 'href' ? href : null; },
    closest: function () { return wrapper; },
    querySelector: qs
  });
}

var anchors = [
  makeLesson('Системы счисления. Перевод', '/classroom/courses/15494513/assignments/262635964/run/?latest', 1, 5),
  makeLesson('Практическая работа «Моделирование»', '/classroom/courses/15494513/assignments/262635614/run/?latest', 0, 16)
];
var finishedTab = false;
var hiddenAnchor = makeLesson('Скрытое', '/classroom/courses/15494513/assignments/262635613/run/?latest', 0, 17);
hiddenAnchor.getClientRects = function () { return []; }; // невидимая вкладка
anchors.push(hiddenAnchor);

var listeners = [];
globalThis.window = globalThis;
globalThis.location = { origin: 'https://education.yandex.ru', pathname: '/classroom/courses/15494513/', href: 'https://education.yandex.ru/classroom/courses/15494513/' };
globalThis.document = {
  head: node(), body: node(), documentElement: node(),
  getElementById: function () { return null; },
  createElement: function () { return node(); },
  querySelector: function (sel) { return sel.indexOf('radio') >= 0 ? { checked: !!finishedTab } : null; },
  querySelectorAll: function (sel) { return sel.indexOf('student-lessons-view__lesson') >= 0 ? anchors : []; },
  addEventListener: function () {}
};
globalThis.chrome = {
  runtime: {
    onMessage: { addListener: function (fn) { listeners.push(fn); } },
    sendMessage: function (msg, cb) { if (cb) cb(); },
    lastError: null
  },
  storage: {
    local: {
      get: function (defs, cb) {
        // Состав уже в кэше: тест не должен ходить за страницами занятий.
        cb(Object.assign({}, defs, { ybsCompositions: {
          '262635964': { total: 5, theory: 1, practice: 4 },
          '262635614': { total: 16, theory: 0, practice: 16 },
          '262635613': { total: 17, theory: 2, practice: 15 }
        } }));
      },
      set: function () {}
    },
    onChanged: { addListener: function () {} }
  }
};
globalThis.YBS = require(solverPath);

var problems = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { problems++; console.log('  XX  ' + name + ' -> ' + e.message); }
}

var src = fs.readFileSync(contentPath, 'utf8');
eval(src);

var handler = listeners[0];
if (!handler) throw new Error('handler не зарегистрирован');
function ask(msg) { var out = null; handler(msg, {}, function (r) { out = r; }); return out; }

check('bulk:getState отдаёт список занятий', function () {
  var st = ask({ type: 'bulk:getState' });
  assert(st, 'нет ответа');
  assert.strictEqual(st.tab, 'active');
  assert.strictEqual(st.lessons.length, 2); // невидимая карточка отфильтрована
  assert.strictEqual(st.running, false);
  assert.strictEqual(st.active, 0);
  assert.ok(Array.isArray(st.activeIds), 'activeIds — массив');
  assert.strictEqual(st.lessons[0].name, 'Системы счисления. Перевод');
  assert.strictEqual(st.lessons[0].done, 1);
  assert.strictEqual(st.lessons[0].total, 5);
  assert.strictEqual(String(st.lessons[0].id), '262635964');
  assert.strictEqual(String(st.lessons[1].id), '262635614');
  assert.deepStrictEqual(st.lessons[0].composition, { total: 5, theory: 1, practice: 4 });
});

check('вкладка «Сдано» распознаётся', function () {
  finishedTab = true;
  var st = ask({ type: 'bulk:getState' });
  assert.strictEqual(st.tab, 'finished');
  finishedTab = false;
});

check('неизвестное занятие — ok:false', function () {
  var r = ask({ type: 'bulk:solveOne', id: '000' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'notfound');
});

check('стоп без запуска не падает', function () {
  var r = ask({ type: 'bulk:stop' });
  assert.strictEqual(r.ok, true);
});

check('пустое сообщение игнорируется', function () {
  assert.strictEqual(handler({}, {}, function () {}), undefined);
});

// --- оценка времени в окне (popup/bulk.js) ---
var popupSrc = fs.readFileSync(path.join(__dirname, '..', 'popup', 'bulk.js'), 'utf8');
function popupFn(name, args, values) {
  var start = popupSrc.indexOf('function ' + name);
  assert(start >= 0, name + ' не найдена');
  var depth = 0, end = -1;
  for (var j = popupSrc.indexOf('{', start); j < popupSrc.length; j++) {
    if (popupSrc[j] === '{') depth++;
    else if (popupSrc[j] === '}') { depth--; if (!depth) { end = j + 1; break; } }
  }
  return new Function(args.join(','), popupSrc.slice(start, end) + '\nreturn ' + name + ';').apply(null, values);
}
var slowLessonSeconds = popupFn('slowLessonSeconds',
  ['SLOW_SECONDS_PER_TASK', 'SLOW_THEORY_SECONDS'], [37.5, 3.5]);

check('оценка: 21 слайд (14 теории + 6 практики) ≈ 4–5 мин', function () {
  var sec = slowLessonSeconds(21, { total: 21, theory: 14, practice: 6 });
  assert(sec > 200 && sec < 320, 'получилось ' + Math.round(sec) + ' с');
});

check('оценка остатка: 7 практических считаются как практика', function () {
  var comp = { total: 21, theory: 14, practice: 7 };
  var left = slowLessonSeconds(7, comp);
  assert.strictEqual(left, 7 * 37.5, 'получилось ' + left + ' с');
  // теория уже пройдена — остаток считаем практикой, а не средней ценой слайда
  assert(left > 200, 'слишком мало: ' + left);
});

check('оценка остатка: если осталась только теория — она дешёвая', function () {
  var comp = { total: 10, theory: 10, practice: 0 };
  assert.strictEqual(slowLessonSeconds(4, comp), 14);
});

check('оценка: без состава считаем всё практикой', function () {
  assert.strictEqual(slowLessonSeconds(10, null), 375);
  assert.strictEqual(slowLessonSeconds(0, null), 0);
});

var popupNormalize = popupFn('normalizeRange', ['CFG', 'DEFAULT_FROM', 'DEFAULT_TO'],
  [require(path.join(__dirname, '..', 'config.js')), 7, 13]);

check('промежуток в окне: левое не больше правого', function () {
  assert.deepStrictEqual(popupNormalize(13, 7), { from: 7, to: 13 });
  assert.deepStrictEqual(popupNormalize(0, 0), { from: 0, to: 0 });
  assert.deepStrictEqual(popupNormalize('', ''), { from: 7, to: 13 });
});

check('оценка: чистая теория дешёвая', function () {
  assert.strictEqual(slowLessonSeconds(10, { total: 10, theory: 10, practice: 0 }), 35);
});

if (problems) { console.log('ПРОБЛЕМ: ' + problems); process.exit(1); }
console.log('Все проверки UI-content пройдены.');

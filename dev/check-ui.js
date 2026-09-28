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
    local: { get: function (defs, cb) { cb(defs || {}); } },
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

if (problems) { console.log('ПРОБЛЕМ: ' + problems); process.exit(1); }
console.log('Все проверки UI-content пройдены.');

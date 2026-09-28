/* dev/check-lessons.js — список занятий из API (страницы, закрытые, не в DOM). */
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
    children: [], style: { setProperty: function () {}, removeProperty: function () {} }, __attrs: {},
    appendChild: function (c) { this.children.push(c); return c; },
    removeChild: function () {}, remove: function () {},
    setAttribute: function (k, v) { this.__attrs[k] = v; },
    getAttribute: function (k) { return this.__attrs[k] == null ? null : this.__attrs[k]; },
    addEventListener: function () {}, querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    getClientRects: function () { return [{ width: 1 }]; }, closest: function () { return null; }, insertAdjacentElement: function () {}
  }, extra || {});
}
// в DOM отрисовано только одно занятие — id 100
function domLesson(id, name) {
  var nameEl = node({ textContent: name });
  var titleEl = node({ textContent: '1 5' });
  var qs = function (s) { return s === '.student-lessons-view__lesson-name-text' ? nameEl : (s === '.progress-circle__title' ? titleEl : null); };
  var wrapper = node({ querySelector: qs });
  return node({ textContent: name, getAttribute: function (k) { return k === 'href' ? '/classroom/courses/1/assignments/' + id + '/run/?latest' : null; }, closest: function () { return wrapper; }, querySelector: qs });
}
var anchors = [domLesson(100, 'A')];

var listeners = [];
globalThis.window = globalThis;
globalThis.location = { origin: 'https://education.yandex.ru', pathname: '/classroom/courses/1/', href: 'https://education.yandex.ru/classroom/courses/1/' };
globalThis.document = {
  head: node(), body: node(), documentElement: node(),
  getElementById: function () { return null; }, createElement: function () { return node(); },
  querySelector: function (s) { return s.indexOf('radio') >= 0 ? { checked: false } : null; },
  querySelectorAll: function (s) { return s.indexOf('student-lessons-view__lesson') >= 0 ? anchors : []; },
  addEventListener: function () {}
};
globalThis.chrome = {
  runtime: { onMessage: { addListener: function (fn) { listeners.push(fn); } }, sendMessage: function (m, cb) { if (cb) cb(); }, lastError: null },
  storage: { local: { get: function (d, cb) { cb(d || {}); } }, onChanged: { addListener: function () {} } }
};
globalThis.YBS = require(solverPath);

var apiCalls = 0;
function jsonRes(o) { return { ok: true, status: 200, url: '', text: async function () { return JSON.stringify(o); }, json: async function () { return o; } }; }
globalThis.fetch = async function (url) {
  var u = String(url);
  if (u.indexOf('get-course-student-lessons') === -1) return { ok: false, status: 404, url: u, text: async function () { return ''; }, json: async function () { return {}; } };
  apiCalls++;
  if (u.indexOf('sort_key=') === -1) {
    return jsonRes({ clessons: [
      { id: 100, is_closed: false, lesson: { name: 'A', problems_count: 5 }, finished_problems: 1, assigned_problems: 5 },
      { id: 200, is_closed: false, lesson: { name: 'B', problems_count: 7 }, finished_problems: 3, assigned_problems: 7 },
      { id: 300, is_closed: true, lesson: { name: 'C', problems_count: 2 }, finished_problems: 2, assigned_problems: 2 },
      { id: 500, is_closed: false, lesson: { name: 'E', problems_count: 0 }, finished_problems: 0, assigned_problems: 0 }
    ], sortKey: '["student_active",null,"2026-01-01"]' });
  }
  return jsonRes({ clessons: [
    { id: 400, is_closed: false, lesson: { name: 'D', problems_count: 4 }, finished_problems: 0, assigned_problems: 4 }
  ], sortKey: null });
};

var problems = 0;
function check(name, fn) { try { fn(); console.log('  ok  ' + name); } catch (e) { problems++; console.log('  XX  ' + name + ' -> ' + e.message); } }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var src = fs.readFileSync(contentPath, 'utf8');
eval(src);
var handler = listeners[0];
function ask(msg) { var out = null; handler(msg, {}, function (r) { out = r; }); return out; }

(async function () {
  await sleep(60); // дать бутстрапу подтянуть список из API
  var st = ask({ type: 'bulk:getState' });

  check('взяты все страницы API (2 запроса)', function () { assert(apiCalls >= 2, 'apiCalls=' + apiCalls); });
  check('закрытое занятие исключено', function () {
    assert.strictEqual(st.lessons.some(function (l) { return String(l.id) === '300'; }), false);
  });
  check('пустое занятие (0 заданий) исключено', function () {
    assert.strictEqual(st.lessons.some(function (l) { return String(l.id) === '500'; }), false);
  });
  check('занятие не из DOM попало в список (id 200)', function () {
    var l = st.lessons.filter(function (x) { return String(x.id) === '200'; })[0];
    assert(l, 'нет 200');
    assert.strictEqual(l.name, 'B');
    assert.strictEqual(l.done, 3);
    assert.strictEqual(l.total, 7);
  });
  check('вторая страница тоже попала (id 400)', function () {
    assert(st.lessons.some(function (l) { return String(l.id) === '400'; }), 'нет 400');
  });
  check('итоговый список: 100, 200, 400', function () {
    assert.deepStrictEqual(st.lessons.map(function (l) { return String(l.id); }).sort(), ['100', '200', '400']);
  });

  if (problems) { console.log('ПРОБЛЕМ: ' + problems); process.exit(1); }
  console.log('Все проверки списка занятий пройдены.');
  process.exit(0);
})();

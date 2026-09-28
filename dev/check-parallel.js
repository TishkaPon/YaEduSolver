/* dev/check-parallel.js — параллельное решение занятий (мок fetch). */
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
  var n = Object.assign({
    children: [], style: { setProperty: function () {}, removeProperty: function () {} },
    __attrs: {}, parentNode: null, offsetHeight: 10,
    appendChild: function (c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild: function (c) { var i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
    remove: function () {},
    setAttribute: function (k, v) { this.__attrs[k] = v; },
    getAttribute: function (k) { return this.__attrs[k] == null ? null : this.__attrs[k]; },
    addEventListener: function () {},
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    getClientRects: function () { return [{ width: 10 }]; },
    getBoundingClientRect: function () { return { height: 10 }; },
    insertAdjacentElement: function () {}
  }, extra || {});
  if (!n.closest) n.closest = function () { return n; };
  return n;
}

function makeLesson(name, href) {
  var nameEl = node({ textContent: name });
  var titleEl = node({ textContent: '0 5' });
  var qs = function (sel) {
    if (sel === '.student-lessons-view__lesson-name-text') return nameEl;
    if (sel === '.progress-circle__title') return titleEl;
    if (sel === '.progress-circle') return node();
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

var LESSONS = 6;
var TASKS = 5;
var anchors = [];
for (var L = 0; L < LESSONS; L++) {
  anchors.push(makeLesson('Занятие ' + L, '/classroom/courses/1/assignments/' + (900000 + L) + '/run/?latest'));
}

var listeners = [];
globalThis.window = globalThis;
globalThis.location = { origin: 'https://education.yandex.ru', pathname: '/classroom/courses/1/', href: 'https://education.yandex.ru/classroom/courses/1/' };
globalThis.document = {
  head: node(), body: node(), documentElement: node(),
  getElementById: function () { return null; },
  createElement: function () { return node(); },
  querySelector: function (sel) { return sel.indexOf('radio') >= 0 ? { checked: false } : null; },
  querySelectorAll: function (sel) { return sel.indexOf('student-lessons-view__lesson') >= 0 ? anchors : []; },
  addEventListener: function () {}
};
globalThis.chrome = {
  runtime: {
    onMessage: { addListener: function (fn) { listeners.push(fn); } },
    sendMessage: function (m, cb) { if (cb) cb(); },
    lastError: null
  },
  storage: { local: { get: function (d, cb) { cb(d || {}); } }, onChanged: { addListener: function () {} } }
};
globalThis.YBS = require(solverPath);

// --- мок сети ---
var inflight = 0, maxInflight = 0, answerPatches = 0, timePosts = 0, completes = 0, starts = 0, runFetches = 0, rateLimited = 0, start429Pending = true, runErrPending = 1, runErrRetries = 0;
function jsonRes(obj) { return { ok: true, status: 200, url: '', text: async function () { return JSON.stringify(obj); }, json: async function () { return obj; } }; }
globalThis.fetch = async function (url, opts) {
  var u = String(url);
  var method = (opts && opts.method) || 'GET';
  if (method !== 'POST') {
    if (u.indexOf('get-course-student-lessons') !== -1) return jsonRes({ clessons: [], sortKey: null });
    runFetches++;
    var id = Number((u.match(/assignments\/(\d+)/) || [])[1]);
    if (runErrPending > 0) { // один раз отдаём страницу с ошибкой бэкенда (как реальный 429 limited)
      runErrPending--;
      runErrRetries++;
      var errData = { config: { sk: 'SK' }, data: { errors: { getCLessonRun: { statusCode: 429, statusMessage: 'Too Many Requests' } } } };
      return { ok: true, status: 200, url: u, text: async function () { return '<script>window._data=' + JSON.stringify(errData) + '</script>'; }, json: async function () { return errData; } };
    }
    var problems = [];
    for (var k = 1; k <= TASKS; k++) problems.push({ id: id * 10 + k, problem: { type: 'practice', markup: { answers: { '1': [0] } } } });
    var data = { config: { sk: 'SK' }, data: { getCLessonRun: { problems: problems }, getLatestCLessonResult: { statusCode: 404 } } };
    return { ok: true, status: 200, url: u, text: async function () { return '<script>window.data=1;window._data=' + JSON.stringify(data) + '</script>'; }, json: async function () { return data; } };
  }
  if (u.indexOf('/classroom/api/patch-clesson-results/') !== -1) {
    inflight++;
    answerPatches++;
    if (inflight > maxInflight) maxInflight = inflight;
    await new Promise(function (r) { setTimeout(r, 5); });
    inflight--;
    return jsonRes({});
  }
  if (u.indexOf('update-spent-time') !== -1) { timePosts++; return jsonRes({}); }
  if (u.indexOf('post-clesson-results-complete') !== -1) { completes++; return jsonRes({}); }
  if (u.indexOf('/classroom/api/post-clesson-results/') !== -1) {
    starts++;
    if (start429Pending) {
      start429Pending = false;
      rateLimited++;
      return { ok: false, status: 429, url: '', text: async function () { return '"limited"'; }, json: async function () { return {}; }, headers: { get: function () { return '0'; } } };
    }
    return jsonRes({ id: 2000 + starts });
  }
  return jsonRes({});
};

var problemsCount = 0;
function check(name, fn) { try { fn(); console.log('  ok  ' + name); } catch (e) { problemsCount++; console.log('  XX  ' + name + ' -> ' + e.message); } }

var src = fs.readFileSync(contentPath, 'utf8');
eval(src);
var handler = listeners[0];
function ask(msg) { var out = null; handler(msg, {}, function (r) { out = r; }); return out; }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(async function () {
  ask({ type: 'bulk:solveAll' });
  var guard = 0;
  while (ask({ type: 'bulk:getState' }).running && guard++ < 2000) await sleep(5);
  var st = ask({ type: 'bulk:getState' });

  check('решение завершилось', function () { assert.strictEqual(st.running, false); });
  check('все занятия решены', function () { assert.strictEqual(st.index, LESSONS); assert.strictEqual(st.total, LESSONS); });
  check('отправлены ответы всех заданий', function () { assert.strictEqual(answerPatches, LESSONS * TASKS); });
  check('время отправлено по всем заданиям', function () { assert.strictEqual(timePosts, LESSONS * TASKS); });
  check('каждое занятие сдано', function () { assert.strictEqual(completes, LESSONS); });
  check('429 «limited» повторяется и не теряет занятие', function () {
    assert.strictEqual(rateLimited, 1, 'не было 429 в моке');
    assert.strictEqual(starts, LESSONS + 1, 'стартов ' + starts + ' (ожидалось ' + (LESSONS + 1) + ': один повтор)');
  });
  check('занятия решались параллельно (>=2)', function () { assert(maxInflight >= 2, 'макс. одновременно ' + maxInflight); });
  check('нет лимита: запущены все занятия', function () { assert(starts >= LESSONS, 'стартов ' + starts + ' из ' + LESSONS); });
  check('сорванная загрузка run-страницы (errors внутри) повторяется', function () { assert(runErrRetries >= 1, 'не было сбоя'); });
  check('после завершения нет активных', function () { assert.strictEqual(st.active, 0); assert.deepStrictEqual(st.activeIds, []); });
  console.log('   (параллельно максимум: ' + maxInflight + ', ответов: ' + answerPatches + ', время: ' + timePosts + ', сдач: ' + completes + ')');

  if (problemsCount) { console.log('ПРОБЛЕМ: ' + problemsCount); process.exit(1); }
  console.log('Все проверки параллельного решения пройдены.');
  process.exit(0);
})();

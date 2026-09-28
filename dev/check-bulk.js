/* dev/check-solver.js — проверка solver.js на реальных HAR. */
'use strict';
var fs = require('fs');
var path = require('path');
var assert = require('assert');
var YBS = require(path.join(__dirname, '..', 'bulk', 'solver.js'));

var HAR1 = '/home/tisha/.dsh/attachments/v1/files/04/04a9bf3b6291db9e877dc241521d552f8178f5da6715db9607ebf46aa927a330/education.yandex.ru.har';
var HAR2 = '/home/tisha/.dsh/attachments/v1/files/5e/5eb10f5c7943b7e09e6a70903a1934ed8b4185890911b2deea8404570f001d2f/education.yandex.ru2.har';
var INFO_HTML = '/home/tisha/.dsh/attachments/v1/files/85/8556dd4ce77ae8db569a6a05c8b8b55755c6461cf755040d8018a846cf74bc80/infa.html';

var PROBLEMS = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { PROBLEMS++; console.log('  XX  ' + name + ' -> ' + e.message); }
}

function runEntry(har) {
  return har.log.entries.find(function (e) {
    return /\/run\//.test(e.request.url) &&
      (e.response.content && e.response.content.mimeType || '').indexOf('html') !== -1 &&
      /window\._data=/.test(e.response.content.text || '');
  });
}

check('clessonIdFromHref', function () {
  assert.strictEqual(YBS.clessonIdFromHref('/classroom/courses/15494513/assignments/262635964/run/?latest'), 262635964);
  assert.strictEqual(YBS.clessonIdFromHref('/no-id'), null);
});

check('normalize: inline, выбор, matching', function () {
  assert.deepStrictEqual(YBS.normalize({ '1': ['76'], '2': ['26'] }), { '1': '76', '2': '26' });
  assert.deepStrictEqual(YBS.normalize([2, 3, 5]), [2, 3, 5]);
  assert.deepStrictEqual(YBS.normalize([[[1, 0], [6, 1]]]), [[1, 0], [6, 1]]);
});

check('normalize: chooseimage и выбор без повторов', function () {
  assert.deepStrictEqual(YBS.normalize([['i7']]), ['i7']);      // chooseimage
  assert.deepStrictEqual(YBS.normalize([3, 3, 5]), [3, 5]);     // choice: дубли убираем (как сам сайт)
  assert.deepStrictEqual(YBS.normalize([2, 3, 5]), [2, 3, 5]);  // без дублей — как есть
  assert.deepStrictEqual(YBS.normalize([0]), [0]);              // одиночный выбор
  assert.deepStrictEqual(YBS.normalize([['i1'], ['i2']]), [['i1'], ['i2']]); // строки/пары не трогаем
});

check('isSolvedState: mistakes — нет, status:0 с верным ответом — решено', function () {
  assert.strictEqual(YBS.isSolvedState({ answered: true, completed: true, status: 1, points: 30, markers: { '1': { mistakes: 0, answer_status: [1], status: 1 } } }), true);
  // ответ совпал (answer_status all 1), но сервер не начислил балл — считаем решённым
  assert.strictEqual(YBS.isSolvedState({ answered: true, completed: true, status: 0, points: 0, markers: { '1': { mistakes: -1, answer_status: [1, 1, 1], status: 0 } } }), true);
  assert.strictEqual(YBS.isSolvedState({ answered: true, status: 1, markers: { '1': { mistakes: 1, answer_status: 0, status: 0 } } }), false);
  assert.strictEqual(YBS.isSolvedState({ answered: true, status: 0, markers: { '1': { mistakes: 1, answer_status: 0 } } }), false);
  assert.strictEqual(YBS.isSolvedState({ answered: false, completed: false, status: 1 }), false);
  assert.strictEqual(YBS.isSolvedState(null), false);
});

check('isUngraded: верный ответ, но сервер не выставил балл', function () {
  var step = { kind: 'practice', problemLinkId: 681507250 };
  var dup = { answers: { 681507250: [{ answered: true, completed: true, status: 0, points: 0, markers: { '1': { mistakes: -1, answer_status: [1, 1, 1], status: 0 } } }] } };
  var good = { answers: { 681507250: [{ answered: true, completed: true, status: 1, points: 30, markers: { '1': { mistakes: 0, answer_status: [1] } } }] } };
  assert.strictEqual(YBS.isUngraded(dup, step), true);
  assert.strictEqual(YBS.isUngraded(good, step), false);
});

[[ 'HAR1', HAR1 ], [ 'HAR2', HAR2 ]].forEach(function (pair) {
  check(pair[0] + ': план и ответы совпадают с отправленными', function () {
    var har = JSON.parse(fs.readFileSync(pair[1], 'utf8'));
    var entry = runEntry(har);
    assert.ok(entry, 'нет run-HTML');
    var data = YBS.parseWindowData(entry.response.content.text);
    assert.ok(data, 'window._data не разобран');
    var pageUrl = entry.request.url;
    var plan = YBS.buildPlan(data, YBS.clessonIdFromHref(pageUrl));
    assert.ok(plan.sk, 'нет sk');
    assert.ok(plan.resultId, 'нет resultId');
    assert.ok(plan.steps.length > 0, 'нет шагов');

    var submitted = {};
    har.log.entries.forEach(function (e) {
      if (e.request.url.indexOf('patch-clesson-results') === -1) return;
      if (!e.request.postData || e.request.postData.text.indexOf('user_answer') === -1) return;
      var body = JSON.parse(e.request.postData.text);
      submitted[body.problemLinkId] = JSON.parse(body.answer);
    });

    var compared = 0;
    plan.steps.forEach(function (step) {
      if (!step.answer) return; // теория — без ответа
      var actual = submitted[step.problemLinkId];
      if (!actual) return;
      Object.keys(step.answer).forEach(function (marker) {
        assert.ok(actual[marker], 'нет маркера ' + marker);
        assert.deepStrictEqual(step.answer[marker].user_answer, actual[marker].user_answer);
      });
      compared++;
    });
    assert.ok(compared > 0, 'ничего не сравнили');
    console.log('        система: ' + compared + ' задач, sk=' + plan.sk.slice(0, 12) + '…, resultId=' + plan.resultId);
  });
});

var HAR3 = '/home/tisha/.dsh/attachments/v1/files/7a/7af235c687417eefa5f59fd47fb83b2b49eb09d09d575a2b31e181d1363c53fc/education.yandex.ru.har';

check('HAR3 (занятие не начато): resultId пустой, 17 проблем (13 практики + 4 теории), sk есть', function () {
  var har = JSON.parse(fs.readFileSync(HAR3, 'utf8'));
  var entry = runEntry(har);
  assert.ok(entry, 'нет run-HTML');
  var data = YBS.parseWindowData(entry.response.content.text);
  assert.ok(data, 'window._data не разобран');
  var plan = YBS.buildPlan(data, YBS.clessonIdFromHref(entry.request.url));
  assert.ok(plan.sk, 'нет sk');
  assert.strictEqual(plan.resultId, null, 'resultId должен быть пустым');
  assert.strictEqual(plan.steps.length, 17, 'все проблемы в плане');
  var practice = plan.steps.filter(function (s) { return s.kind === 'practice'; }).length;
  var theory = plan.steps.filter(function (s) { return s.kind === 'theory'; }).length;
  assert.strictEqual(practice, 13, '13 практических');
  assert.strictEqual(theory, 4, '4 теории');
});

check('HAR3: старт — post-clesson-results {clessonId, sk} -> id (201)', function () {
  var har = JSON.parse(fs.readFileSync(HAR3, 'utf8'));
  var start = har.log.entries.find(function (e) {
    return e.request.url.indexOf('/classroom/api/post-clesson-results/') !== -1 && e.request.url.indexOf('complete') === -1;
  });
  assert.ok(start, 'нет запроса старта');
  var body = JSON.parse(start.request.postData.text);
  assert.ok(body.clessonId, 'нет clessonId');
  assert.ok(body.sk, 'нет sk');
  assert.strictEqual(start.response.status, 201);
  var response = JSON.parse(start.response.content.text);
  assert.ok(response.id, 'нет id в ответе');
});

var HAR4 = '/home/tisha/.dsh/attachments/v1/files/86/8630399548f9ce9d1e5a027dc83813df4c7a75d7546630fa661e0cf4ce4f5392/education.yandex.ru.har';

check('HAR4 (часть заданий уже выполнена): 5 пройдено (3 практики + 2 теории), 3 в очереди', function () {
  var har = JSON.parse(fs.readFileSync(HAR4, 'utf8'));
  var entry = runEntry(har);
  assert.ok(entry, 'нет run-HTML');
  var data = YBS.parseWindowData(entry.response.content.text);
  assert.ok(data, 'window._data не разобран');
  var plan = YBS.buildPlan(data, YBS.clessonIdFromHref(entry.request.url));
  assert.strictEqual(plan.steps.length, 8, 'всего 8 проблем');
  var done = plan.steps.filter(function (s) { return s.done; }).length;
  var pending = plan.steps.filter(function (s) { return !s.done; }).length;
  // 3 практики отвечены + 2 теории уже открыты = 5; в очереди 3 практики.
  assert.strictEqual(done, 5, 'пять уже пройдены (3 практики + 2 теории)');
  assert.strictEqual(pending, 3, 'три в очереди');
  var theoryDone = plan.steps.filter(function (s) { return s.kind === 'theory' && s.done; }).length;
  assert.strictEqual(theoryDone, 2, 'теория с состоянием считается пройденной');
});

var HAR5 = '/home/tisha/.dsh/attachments/v1/files/35/35225f620982316a801b85c05f553f15938841866e841d07cb17b41dc9293efa/education.yandex.ru.har';

check('HAR5 (web-задания): 3 web с answer_panes и готовы к отправке', function () {
  var har = JSON.parse(fs.readFileSync(HAR5, 'utf8'));
  var entry = runEntry(har);
  var data = YBS.parseWindowData(entry.response.content.text);
  assert.ok(data, 'window._data не разобран');
  var plan = YBS.buildPlan(data, YBS.clessonIdFromHref(entry.request.url));
  assert.strictEqual(plan.steps.length, 6, 'всего 6 проблем');
  var web = plan.steps.filter(function (s) { return s.kind === 'web'; });
  var done = plan.steps.filter(function (s) { return s.done; }).length;
  var sendable = plan.steps.filter(function (s) { return !s.done && s.kind === 'web'; }).length;
  assert.strictEqual(web.length, 3, 'три web-задания');
  assert.strictEqual(web.every(function (s) { return s.answer === null && s.panes && s.panes.length > 0; }), true, 'у web есть answer_panes');
  assert.strictEqual(done, 3, 'теория(2) + практика(1) пройдены');
  assert.strictEqual(sendable, 3, 'три web в очереди');
});

check('buildWebAttempt повторяет формат post-attempts', function () {
  var har = JSON.parse(fs.readFileSync(HAR5, 'utf8'));
  var entry = runEntry(har);
  var data = YBS.parseWindowData(entry.response.content.text);
  var plan = YBS.buildPlan(data, YBS.clessonIdFromHref(entry.request.url));
  var web = plan.steps.filter(function (s) { return s.kind === 'web'; })[0];
  var body = YBS.buildWebAttempt(web, 211955352);
  assert.strictEqual(body.lpl_id, web.problemLinkId);
  assert.strictEqual(body.clr_id, 211955352);
  assert.strictEqual(body.attempt.answered, true);
  assert.strictEqual(body.attempt.completed, true);
  assert.strictEqual(body.attempt.markers.user_answer.verdict.status, true);
  assert.strictEqual(body.attempt.markers.user_answer.verdict.errors.length, 0);
  assert.ok(Array.isArray(body.attempt.markers.user_answer.panes));
  assert.ok(body.attempt.markers.user_answer.panes[0].content.length > 0);
  assert.strictEqual(body.attempt.markers.user_answer.panes[0].name, 'index.html');
});

var HAR6 = '/home/tisha/.dsh/attachments/v1/files/7e/7ee0c7db121a8d2fb561643efd73e73ddd5f828ba5bf2b5a9566920ed2c5d3f3/education.yandex.ru.har';

check('HAR6 (editable/diskurl): ручное задание помечено skip', function () {
  var har = JSON.parse(fs.readFileSync(HAR6, 'utf8'));
  var entry = runEntry(har);
  var data = YBS.parseWindowData(entry.response.content.text);
  var plan = YBS.buildPlan(data, YBS.clessonIdFromHref(entry.request.url));
  var skip = plan.steps.filter(function (s) { return s.kind === 'skip'; });
  assert.strictEqual(skip.length, 1, 'одно ручное задание');
  assert.strictEqual(skip[0].type, 'editable');
  assert.strictEqual(skip[0].answer, null);
  var sendable = plan.steps.filter(function (s) { return !s.done && s.kind !== 'skip'; });
  console.log('        отправляем: ' + sendable.length + ', пропускаем: ' + skip.length);
});

check('readVerdict: практика — верно/неверно', function () {
  var step = { kind: 'practice', problemLinkId: 681071041 };
  var good = { answers: { 681071041: [{ answered: true, completed: true, markers: { '1': { mistakes: 0, answer_status: 1 } } }] } };
  var bad = { answers: { 681071041: [{ answered: true, completed: true, markers: { '1': { mistakes: 1, answer_status: 0 } } }] } };
  // ответ принят (answer_status all 1), но сервер не начислил points — это НЕ «неверно»
  var ungraded = { answers: { 681071041: [{ answered: true, completed: true, status: 0, markers: { '1': { mistakes: -1, answer_status: [1] , status: 0 } } }] } };
  assert.strictEqual(YBS.readVerdict(good, step), true);
  assert.strictEqual(YBS.readVerdict(bad, step), false);
  assert.strictEqual(YBS.readVerdict(ungraded, step), true);
});

check('readVerdict: теория никогда не "неверно"', function () {
  // Реальный ответ на пустой патч теории: answered:false — это НОРМА, не ошибка.
  var response = { answers: { '681077588': [{ answered: false, completed: false, markers: {} }] } };
  assert.strictEqual(YBS.readVerdict(response, { kind: 'theory', problemLinkId: 681077588 }), true);
});

check('readVerdict: web — верно/неверно', function () {
  var step = { kind: 'web', problemLinkId: 681507441 };
  var good = { attempt: { answered: true, markers: { user_answer: { verdict: { status: true } }, result: { '0': { answer_status: true } } } } };
  var bad = { attempt: { answered: true, markers: { user_answer: { verdict: { status: true } }, result: { '0': { answer_status: false } } } } };
  assert.strictEqual(YBS.readVerdict(good, step), true);
  assert.strictEqual(YBS.readVerdict(bad, step), false);
});

check('progressOffset: 0 / половина / полный', function () {
  assert.strictEqual(YBS.progressOffset(100, 0, 4), 100);
  assert.strictEqual(YBS.progressOffset(100, 2, 4), 50);
  assert.strictEqual(YBS.progressOffset(100, 4, 4), 0);
  assert.strictEqual(YBS.progressOffset(100, 5, 4), 0);
});

check('isFinishedPath: страница «Сдано»', function () {
  assert.strictEqual(YBS.isFinishedPath('/classroom/courses/15914082/finished/'), true);
  assert.strictEqual(YBS.isFinishedPath('/classroom/courses/15914082/finished'), true);
  assert.strictEqual(YBS.isFinishedPath('/classroom/courses/15914082/'), false);
  assert.strictEqual(YBS.isFinishedPath('/classroom/courses/15914082/assignments/1/run/3/'), false);
});

check('infa.html: карточки занятий найдены', function () {
  var html = fs.readFileSync(INFO_HTML, 'utf8');
  var matches = html.match(/a class="[^"]*student-lessons-view__lesson[^"]*"[^>]*href="[^"]*\/assignments\/\d+\/run\//g) || [];
  assert.ok(matches.length >= 1, 'нет ссылок на run');
  assert.ok(html.indexOf('/assignments/262635964/run/?latest') !== -1);
  assert.ok(html.indexOf('student-lessons-view__lesson-wrapper') !== -1);
});

console.log('');
console.log(PROBLEMS ? ('Ошибок: ' + PROBLEMS) : 'Все проверки solver пройдены.');
process.exit(PROBLEMS ? 1 : 0);

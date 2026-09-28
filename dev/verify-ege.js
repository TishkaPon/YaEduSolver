/*
 * dev/verify-har.js — офлайн-проверка extractor.js на реальных HAR.
 * Запуск: node dev/verify-har.js [har ...]  (без аргументов — все эталоны)
 */
'use strict';

var fs = require('fs');
var path = require('path');
var answers = require(path.join(__dirname, '..', 'ege', 'extractor.js'));

var DEFAULT_HARS = [
  '/home/tisha/.dsh/attachments/v1/files/d0/d043a88ca97dfdf8323050d8e9ccfcda372d596996f204056d22b0e299b859bf/education.yandex.ru_Archive [26-09-20 14-26-30].har',
  '/home/tisha/.dsh/attachments/v1/files/0d/0df5ed2f602ffe3451c2cc09a9f55d3378a16d5557b9a98674a46bb170c9f42d/education.yandex.ru.har',
  '/home/tisha/.dsh/attachments/v1/files/20/20452729bfbfd849c270829da6c1e6c4306979b6bc07c31d4d3bdc1788a99211/education.yandex.ru.har'
];

// Порядок = порядок в массиве tasks (страница /task/N открывает tasks[N-1]).
var expectedByCount = {
  27: {
    1: '17', 2: 'xzwy', 3: '52100', 4: '37', 5: '300', 6: '582', 7: '112',
    8: '7439040', 9: '1382', 10: '194', 11: '33', 12: '188', 13: '1202',
    14: '1184788512452608', 15: '67', 16: '153727', 17: '6 189930', 18: '3434 1756',
    19: '19', 20: '33 36', 21: '67', 22: '6', 23: '41993', 24: '166',
    25: '1326269 189467\n1326311 189473\n1326353 189479\n1326401 6733\n1326527 78031',
    26: '1806992450 984',
    27: '11593 66776\n398 278'
  },
  5: {
    1: '1103299319 1693\n1103309477 1693\n1103322107 16187\n1103323021 1693\n1103328547 3169',
    2: '700002 27\n700003 37\n700005 6087\n700007 77\n700008 29167',
    3: '1500010 750007\n1500030 750017\n1500070 750037\n1500090 750047\n1500110 750057',
    4: '1324795 264959\n1324801 1151\n1324903 2543\n1325015 265003\n1325029 5279',
    5: '351261495 183235\n3212614035 1675855\n3412614645 1780185\n3712414275 1936575\n3912414885 2040905'
  }
};

function pageUrlFrom(entry, har) {
  var headers = entry.request.headers || [];
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i].name).toLowerCase() === 'referer' && /education\.yandex\.ru\//.test(headers[i].value || '')) {
      return headers[i].value;
    }
  }
  if (har.log.pages && har.log.pages[0] && har.log.pages[0].title) return har.log.pages[0].title;
  return entry.request.url;
}

function checkHar(harPath) {
  console.log('=== ' + path.basename(harPath));
  var har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
  var entry = har.log.entries.find(function (e) {
    return e.request.url === 'https://education.yandex.ru/api/v5/gpttr' &&
      e.request.postData && /public_get_variant_request_item/.test(e.request.postData.text);
  });
  if (!entry) { console.log('  gpttr-ответ не найден\n'); return 1; }

  var pageUrl = pageUrlFrom(entry, har);
  var payload = JSON.parse(entry.response.content.text);
  var report = answers.buildReport(payload, pageUrl);
  if (!report) { console.log('  не удалось разобрать\n'); return 1; }

  var expected = expectedByCount[report.count] || {};
  var current = answers.currentTaskNumberFromUrl(pageUrl);
  console.log('  страница: ' + pageUrl);
  console.log('  задач:    ' + report.count + ', текущее задание: ' + current);

  var got = {};
  var failures = 0;
  report.tasks.forEach(function (task) {
    var text = task.answers.map(function (a) { return a.text; }).join(' | ');
    got[task.position] = text;
    var mark = expected[task.position] === undefined ? '  +  ' : (expected[task.position] === text ? '  ok ' : '  XX ');
    console.log('  ' + mark + '#' + String(task.position).padStart(2) + ' (number ' + task.number + '): ' + text.replace(/\n/g, ' ⏎ '));
  });

  Object.keys(expected).forEach(function (position) {
    if (got[position] !== expected[position]) {
      failures++;
      console.log('  НЕ СОВПАЛО #' + position + ': ожидалось "' + expected[position].replace(/\n/g, ' ⏎ ') + '", получено "' + (got[position] || '—').replace(/\n/g, ' ⏎ ') + '"');
    }
  });
  if (report.count !== Object.keys(expected).length) {
    failures++;
    console.log('  НЕ СОВПАЛО по количеству: задач ' + report.count + ', ожидалось ' + Object.keys(expected).length);
  }

  // Ищем задание так же, как попап: по позиции из /task/N.
  var picked = null;
  for (var i = 0; i < report.tasks.length; i++) {
    if (Number(report.tasks[i].position) === Number(current)) { picked = report.tasks[i]; break; }
  }
  if (!picked) {
    failures++;
    console.log('  ОШИБКА: текущее задание #' + current + ' не найдено');
  } else {
    console.log('  текущее #' + current + ' -> ответ: ' + picked.answers.map(function (a) { return a.text; }).join(' | ').replace(/\n/g, ' ⏎ '));
  }
  console.log('');
  return failures;
}

var paths = process.argv.slice(2);
if (!paths.length) paths = DEFAULT_HARS;
var total = 0;
paths.forEach(function (p) { total += checkHar(p); });
console.log(total ? ('Ошибок: ' + total) : 'Все проверки пройдены.');
process.exit(total ? 1 : 0);

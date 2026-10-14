/*
 * config.js — флаги сборки. Правятся только разработчиком, в интерфейсе их нет.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.YBSConfig = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ──────────────────────────────────────────────────────────────────────
  //  Advanced settings.
  //  false — обычная сборка: в настройках только переключатель режима.
  //  true  — плюс блок «Время решения»: промежуток «от—до» минут и
  //          галочка «использовать это время» (решатель будет доводить
  //          время занятия до случайного значения из промежутка).
  // ──────────────────────────────────────────────────────────────────────
  var ADVANCED_SETTINGS = false;

  // Промежуток по умолчанию, минуты.
  var DEFAULT_TIME_FROM = 7;
  var DEFAULT_TIME_TO = 13;

  /**
   * Промежуток приходит любым: 0—0, число—число, иногда «наоборот»
   * (левое больше правого). Приводим к неотрицательным целым и следим,
   * чтобы левое число не было больше правого.
   */
  function normalizeRange(from, to) {
    var lo = parseInt(from, 10);
    var hi = parseInt(to, 10);
    if (!isFinite(lo) || lo < 0) lo = DEFAULT_TIME_FROM;
    if (!isFinite(hi) || hi < 0) hi = DEFAULT_TIME_TO;
    if (lo > hi) { var swap = lo; lo = hi; hi = swap; }
    return { from: lo, to: hi };
  }

  return {
    advanced: ADVANCED_SETTINGS === true,
    normalizeRange: normalizeRange,
    DEFAULT_TIME_FROM: DEFAULT_TIME_FROM,
    DEFAULT_TIME_TO: DEFAULT_TIME_TO
  };
});

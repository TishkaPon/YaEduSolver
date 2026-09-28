/*
 * page-hook.js — запускается в MAIN world (контекст страницы).
 *
 * Перехватывает fetch/XHR и передаёт content-скрипту те JSON-ответы,
 * в которых лежат правильные ответы (answer_control_layout / correct_answers).
 * Дополнительно запоминает последний запрос к /api/v5/gpttr, чтобы уметь
 * повторить его, если попап открыли уже после загрузки страницы.
 */
(function () {
  'use strict';

  if (window.__egeHookInstalled) return;
  window.__egeHookInstalled = true;

  var MARKERS = ['answer_control_layout', 'correct_answers'];
  var captured = [];
  var lastGpttrRequest = null;

  function looksInteresting(text) {
    if (typeof text !== 'string' || text.length < 20) return false;
    for (var i = 0; i < MARKERS.length; i++) {
      if (text.indexOf(MARKERS[i]) !== -1) return true;
    }
    return false;
  }

  function clearCaptured() {
    captured = [];
  }

  function post(payload, source, url) {
    if (!payload) return;
    try {
      captured.push({ payload: payload, source: source || '', url: url || location.href });
      if (captured.length > 20) captured.shift();
    } catch (e) {}
    try {
      window.postMessage({
        __ege: true,
        type: 'data',
        source: source || '',
        url: url || location.href,
        data: payload
      }, '*');
    } catch (e) {}
  }

  function handleText(text, source, url) {
    if (typeof text !== 'string') return false;
    var clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    if (!looksInteresting(clean)) return false;
    var data;
    try { data = JSON.parse(clean); } catch (e) { return false; }
    post(data, source, url);
    return true;
  }

  function headerObject(headers) {
    var result = {};
    if (!headers) return result;
    try {
      if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        headers.forEach(function (value, key) { result[key] = value; });
      } else if (Array.isArray(headers)) {
        headers.forEach(function (pair) { if (pair && pair.length >= 2) result[pair[0]] = pair[1]; });
      } else if (typeof headers === 'object') {
        for (var key in headers) {
          if (Object.prototype.hasOwnProperty.call(headers, key)) result[key] = headers[key];
        }
      }
    } catch (e) {}
    return result;
  }

  function rememberRequest(url, method, body, headers) {
    if (typeof url !== 'string') return;
    if (url.indexOf('/api/v5/gpttr') === -1) return;
    var text = body;
    if (text && typeof text !== 'string') {
      try { text = String(text); } catch (e) { text = null; }
    }
    if (!text || text.indexOf('public_get_variant_request_item') === -1) return;
    lastGpttrRequest = {
      url: url,
      method: method || 'POST',
      body: text,
      headers: headerObject(headers)
    };
  }

  /* -------------------- fetch -------------------- */
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function () {
      var args = arguments;
      var url = '';
      var method = 'GET';
      var body = null;
      var headers = null;
      try {
        if (typeof args[0] === 'string') {
          url = args[0];
        } else if (args[0] && typeof args[0] === 'object') {
          url = args[0].url || '';
          method = args[0].method || 'GET';
          body = args[0].body || null;
          headers = args[0].headers || null;
        }
        if (args[1] && typeof args[1] === 'object') {
          if (args[1].method) method = args[1].method;
          if (args[1].body) body = args[1].body;
          if (args[1].headers) headers = args[1].headers;
        }
      } catch (e) {}
      try { rememberRequest(url, method, body, headers); } catch (e) {}

      var result = origFetch.apply(this, args);
      try {
        result.then(function (response) {
          try {
            var type = (response && response.headers && response.headers.get('content-type')) || '';
            var finalUrl = (response && response.url) || url;
            if (type.indexOf('json') === -1 && String(finalUrl).indexOf('/api/') === -1) return;
            response.clone().text().then(function (text) {
              handleText(text, 'fetch', finalUrl);
            }).catch(function () {});
          } catch (e) {}
        });
      } catch (e) {}
      return result;
    };
  }

  /* -------------------- XMLHttpRequest -------------------- */
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__egeUrl = url; this.__egeMethod = method; } catch (e) {}
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this;
    try { rememberRequest(xhr.__egeUrl, xhr.__egeMethod, body, null); } catch (e) {}
    xhr.addEventListener('readystatechange', function () {
      if (xhr.readyState !== 4) return;
      try {
        if (xhr.responseType && xhr.responseType !== 'text' && xhr.responseType !== '') return;
        var text = typeof xhr.responseText === 'string' ? xhr.responseText : '';
        handleText(text, 'xhr', xhr.__egeUrl);
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };

  /* -------------------- общение с content-скриптом -------------------- */

  var FORBIDDEN_HEADERS = {
    host: 1, 'content-length': 1, cookie: 1, connection: 1, origin: 1,
    referer: 1, 'user-agent': 1, 'accept-encoding': 1, 'set-cookie': 1
  };

  function refetchVariant(fallbackUrl) {
    var request = lastGpttrRequest;
    var target = (request && request.url) || fallbackUrl;
    if (!target || String(target).indexOf('/api/') === -1) return;
    var options = {
      method: (request && request.method) || 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' }
    };
    if (request && request.headers) {
      for (var key in request.headers) {
        if (!Object.prototype.hasOwnProperty.call(request.headers, key)) continue;
        if (FORBIDDEN_HEADERS[String(key).toLowerCase()]) continue;
        options.headers[key] = request.headers[key];
      }
    }
    if (request && request.body) options.body = request.body;
    try {
      fetch(target, options).then(function (response) {
        return response.text();
      }).then(function (text) {
        handleText(text, 'refetch', target);
      }).catch(function () {});
    } catch (e) {}
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var message = event.data;
    if (!message || message.__ege !== true) return;

    if (message.type === 'ready') {
      for (var i = 0; i < captured.length; i++) {
        (function (item) {
          try {
            window.postMessage({
              __ege: true,
              type: 'data',
              source: item.source,
              url: item.url,
              data: item.payload
            }, '*');
          } catch (e) {}
        })(captured[i]);
      }
    } else if (message.type === 'refetch') {
      refetchVariant(message.url);
    } else if (message.type === 'reset') {
      clearCaptured();
    }
  });

  // SPA: при смене варианта старые ответы не должны всплывать повторно.
  var lastPath = location.pathname;
  function maybeReset() {
    var next = location.pathname;
    if (next === lastPath) return;
    lastPath = next;
    // /variants/<id>/task/N — сбрасываем только при смене самого варианта
    if (/\/variants\//.test(next)) clearCaptured();
  }
  window.addEventListener('popstate', maybeReset);
  var pushState = history.pushState;
  history.pushState = function () { var r = pushState.apply(this, arguments); setTimeout(maybeReset, 0); return r; };
  var replaceState = history.replaceState;
  history.replaceState = function () { var r = replaceState.apply(this, arguments); setTimeout(maybeReset, 0); return r; };
})();

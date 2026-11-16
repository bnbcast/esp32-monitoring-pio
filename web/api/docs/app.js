// web/api/docs/app.js - interactive tester for the Cloudflare history API.
//
// Everything here is static: a request goes straight from the browser to the
// base URL, with no proxy and no logging. The ingest key is read from the
// input at send time and is never embedded in this file, the markup, or the
// curl preview (which always shows $INGEST_KEY).
'use strict';

(function () {
  const DEFAULT_BASE = 'https://race-tracker-history.pages.dev';
  const BASE_STORAGE = 'orion.api.base';
  const KEY_STORAGE = 'orion.api.ingestKey';
  const TIMEOUT_MS = 20000;
  const BODY_MAX = 200000;      // characters kept in the response panel
  const MAX_FRAMES = 120;
  const MAX_BYTES = 64 * 1024;

  const $ = (id) => document.getElementById(id);
  const on = (el, ev, fn) => { if (el) el.addEventListener(ev, fn); };

  // ---- small helpers ---------------------------------------------------

  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function byteLen(s) {
    return new TextEncoder().encode(String(s)).length;
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + ' KB';
  }

  function stored(key) {
    try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
  }

  function save(key, value) {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch (e) { /* private mode: keep it in memory only */ }
  }

  function json(r) {
    try { return JSON.parse(r.body); } catch (e) { return null; }
  }

  function shellQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  // ---- base URL --------------------------------------------------------

  function readBase() {
    const raw = (($('base') && $('base').value) || '').trim();
    return (raw || DEFAULT_BASE).replace(/\/+$/, '');
  }

  function baseProblem(base) {
    let u;
    try { u = new URL(base); } catch (e) { return 'Not a valid URL.'; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Use http:// or https://.';
    if (u.search || u.hash) return 'Keep the base URL to scheme + host (+ port).';
    return '';
  }

  function baseNote() {
    const el = $('baseNote');
    const base = readBase();
    const problem = baseProblem(base);
    if (problem) {
      el.className = 'hint err';
      el.textContent = problem;
      return;
    }
    el.className = 'hint';
    if (base === DEFAULT_BASE) {
      el.innerHTML = 'Default: the public history API. For a local run use <code>http://localhost:8788</code>.';
    } else {
      el.textContent = 'Custom base - requests go only to this origin.';
    }
  }

  // ---- date fields -----------------------------------------------------

  function localValue(date) {
    const p = (n) => String(n).padStart(2, '0');
    return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate()) +
      'T' + p(date.getHours()) + ':' + p(date.getMinutes());
  }

  function epochOf(input) {
    if (!input.value) return null;
    const t = new Date(input.value).getTime();
    return Number.isFinite(t) ? Math.floor(t / 1000) : NaN;
  }

  function updateEpoch(inputId, outId) {
    const v = epochOf($(inputId));
    const el = $(outId);
    if (v == null) {
      el.textContent = 'epoch \u2014';
      el.className = 'epoch';
    } else if (Number.isNaN(v)) {
      el.textContent = 'epoch invalid';
      el.className = 'epoch bad';
    } else {
      el.textContent = 'epoch ' + v;
      el.className = 'epoch';
    }
  }

  function setLast24() {
    const now = new Date();
    $('hTo').value = localValue(now);
    $('hFrom').value = localValue(new Date(now.getTime() - 24 * 3600 * 1000));
    updateEpoch('hFrom', 'hFromEpoch');
    updateEpoch('hTo', 'hToEpoch');
    updateCurls();
  }

  // ---- request previews ------------------------------------------------

  function historyQuery() {
    const p = new URLSearchParams();
    const device = $('hDevice').value.trim();
    if (device) p.set('device', device);
    const from = epochOf($('hFrom'));
    const to = epochOf($('hTo'));
    if (Number.isFinite(from)) p.set('from', String(from));
    if (Number.isFinite(to)) p.set('to', String(to));
    const limit = $('hLimit').value.trim();
    if (limit) p.set('limit', limit);
    const qs = p.toString();
    return '/history' + (qs ? '?' + qs : '');
  }

  function liveQuery() {
    const key = $('lKey').value.trim();
    const p = new URLSearchParams();
    if (key) p.set('key', key);
    const qs = p.toString();
    return '/live' + (qs ? '?' + qs : '');
  }

  function curlGet(url) {
    return 'curl -sS -i ' + shellQuote(url);
  }
  function curlOptions(url) {
    return 'curl -sS -i -X OPTIONS ' + shellQuote(url);
  }

  function curlIngest(url) {
    return [
      'curl -sS -i -X POST \\',
      '  -H "content-type: application/json" \\',
      '  -H "x-ingest-key: $INGEST_KEY" \\',
      '  --data-binary @batch.json \\',
      '  ' + shellQuote(url),
      '',
      '# batch.json = the JSON shown in the frames box;',
      '# $INGEST_KEY = the header value, never written into this page.'
    ].join('\n');
  }

  function updateCurls() {
    const base = readBase();
    setText('curl-health', curlGet(base + '/health'));
    setText('curl-history', curlGet(base + historyQuery()));
    setText('curl-live', curlGet(base + liveQuery()));
    setText('curl-ingest', curlIngest(base + '/ingest'));
    setText('curl-options', curlOptions(base + $('oPath').value));
    setText('curl-error', curlGet(base + '/ingest'));
  }

  // ---- ingest form -----------------------------------------------------

  function sampleFrames() {
    const now = Math.floor(Date.now() / 1000);
    // A high seq and a separate boot keep the sample clear of the real
    // device's series if somebody points it at esp32-01 by accident.
    return [{
      seq: 900000 + (now % 1000),
      ts: now,
      up: 42,
      boot: 9001,
      fix: true,
      lat: -6.200001,
      lng: 106.800001,
      alt: 120.4,
      kmh: 12.5,
      cog: 90.5,
      hdop: 0.8,
      sats: 8,
      dist_m: 42.5,
      roll: 1.2,
      pitch: -0.4,
      lap_n: 0,
      lap_last_ms: 0,
      lap_best_ms: 0
    }];
  }

  function resetSample() {
    $('iFrames').value = JSON.stringify(sampleFrames(), null, 2);
    updateFramesMeta();
  }

  function updateFramesMeta() {
    const raw = $('iFrames').value;
    const bytes = byteLen(raw);
    let n = null;
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) n = v.length;
      else if (v && Array.isArray(v.frames)) n = v.frames.length;
    } catch (e) { /* reported below */ }

    const parts = [];
    parts.push(n == null ? 'not a frame array yet' : n + (n === 1 ? ' frame' : ' frames'));
    parts.push(fmtBytes(bytes));
    if (n != null && n > MAX_FRAMES) parts.push('over the ' + MAX_FRAMES + '-frame limit');
    if (bytes > MAX_BYTES) parts.push('over the 64 KB limit');

    const el = $('iFramesMeta');
    el.textContent = parts.join(' \u00b7 ');
    el.className = 'epoch' + ((n != null && n > MAX_FRAMES) || bytes > MAX_BYTES ? ' bad' : '');
  }

  function ingestKey() {
    const key = $('iKey').value.trim();
    if (!key) {
      throw new Error('Paste the X-Ingest-Key first - it is in src/history_secret.h on the machine that owns the project.');
    }
    return key;
  }

  function ingestPayload() {
    const raw = $('iFrames').value.trim();
    if (!raw) throw new Error('Frames are empty.');
    let frames;
    try { frames = JSON.parse(raw); } catch (e) {
      throw new Error('Frames are not valid JSON: ' + e.message);
    }
    if (!Array.isArray(frames)) throw new Error('Frames must be a JSON array of frame objects.');
    if (!frames.length) throw new Error('Frames array is empty.');
    const device = $('iDevice').value.trim() || 'esp32-test';
    return JSON.stringify({ device: device, frames: frames });
  }

  function showIngestError(message) {
    const el = $('ingestErr');
    el.textContent = message;
    el.hidden = false;
  }

  function clearIngestError() {
    const el = $('ingestErr');
    el.textContent = '';
    el.hidden = true;
  }

  function showHistoryError(message) {
    const el = $('historyErr');
    el.textContent = message;
    el.hidden = false;
  }

  function clearHistoryError() {
    const el = $('historyErr');
    el.textContent = '';
    el.hidden = true;
  }

  function showLiveError(message) {
    const el = $('liveErr');
    el.textContent = message;
    el.hidden = false;
  }

  function clearLiveError() {
    const el = $('liveErr');
    el.textContent = '';
    el.hidden = true;
  }

  // ---- the request -----------------------------------------------------

  function describe(err) {
    if (err && err.name === 'AbortError') return 'Request timed out after ' + (TIMEOUT_MS / 1000) + ' s.';
    if (err instanceof TypeError) {
      return 'Network or CORS failure: ' + err.message +
        '. Check the base URL, that the function is deployed, and that the page is served over http(s).';
    }
    return (err && err.message) || String(err);
  }

  function setBusy(busy) {
    document.querySelectorAll('button[type="submit"], button[data-act], #btnVerifyKey')
      .forEach((b) => { b.disabled = busy; });
    if (busy) setStatus('run', 'SENDING');
  }

  async function run(opts) {
    const base = readBase();
    const problem = baseProblem(base);
    const url = base + opts.path;
    if (problem) {
      show({ label: opts.label, method: opts.method, url: url, error: problem });
      return;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const t0 = performance.now();
    setBusy(true);

    let r;
    try {
      const res = await fetch(url, {
        method: opts.method,
        headers: opts.headers,
        body: opts.body,
        mode: 'cors',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'follow',
        signal: ctrl.signal
      });
      const ms = Math.round(performance.now() - t0);
      const headers = [];
      res.headers.forEach((value, name) => headers.push([name, value]));
      let body = '';
      try { body = await res.text(); } catch (e) { body = ''; }
      r = {
        label: opts.label,
        method: opts.method,
        url: url,
        intent: opts.intent || 'send',
        status: res.status,
        statusText: res.statusText,
        ms: ms,
        headers: headers,
        body: body
      };
    } catch (err) {
      r = {
        label: opts.label,
        method: opts.method,
        url: url,
        intent: opts.intent || 'send',
        ms: Math.round(performance.now() - t0),
        error: describe(err)
      };
    } finally {
      clearTimeout(timer);
      setBusy(false);
    }

    if (opts.note) {
      try {
        const note = opts.note(r);
        if (note) {
          r.note = note.text || note;
          r.tone = note.tone || '';
        }
      } catch (e) { /* the response still renders */ }
    }
    show(r);
  }

  // ---- response panel --------------------------------------------------

  function setStatus(cls, text) {
    const el = $('respStatus');
    el.className = 'status' + (cls ? ' ' + cls : '');
    el.textContent = text;
  }

  const STATUS_TEXT = {
    200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
    413: 'Payload Too Large', 429: 'Too Many Requests',
    500: 'Server Error', 503: 'Service Unavailable'
  };

  function statusClass(code) {
    if (code >= 200 && code < 300) return 'ok';
    if (code >= 400 && code < 500) return 'warn';
    if (code >= 500) return 'bad';
    return '';
  }

  function pretty(text) {
    let out = text;
    try { out = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { /* plain text */ }
    if (out.length > BODY_MAX) {
      out = out.slice(0, BODY_MAX) + '\n\u2026 truncated at ' + BODY_MAX + ' characters';
    }
    return out;
  }

  function revealResponse() {
    const el = document.querySelector('.response');
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // On a narrow screen the panel sits below the cards, so a result the user
    // cannot see looks like nothing happened.
    if (rect.top >= window.innerHeight || rect.bottom <= 0) {
      el.scrollIntoView({ behavior: 'auto', block: 'start' });
    }
  }

  function show(r) {
    const failed = !!r.error;
    setStatus(failed ? 'bad' : statusClass(r.status),
      failed ? 'ERROR' : ((r.status + ' ' + (r.statusText || STATUS_TEXT[r.status] || '')).trim()));
    setText('respLabel', r.label);

    const bits = [];
    if (r.ms != null) bits.push('<b>' + r.ms + ' ms</b>');
    if (r.status != null) bits.push('status <b>' + r.status + '</b>');
    if (r.body != null) bits.push('<b>' + fmtBytes(byteLen(r.body)) + '</b> body');
    bits.push('<span class="url">' + escapeHtml(r.method + ' ' + r.url) + '</span>');
    $('respMeta').innerHTML = bits.join(' \u00b7 ');

    const noteEl = $('respNote');
    noteEl.textContent = '';
    noteEl.className = '';
    if (failed) {
      noteEl.className = 'note bad';
      noteEl.textContent = r.error;
    } else if (r.note) {
      noteEl.className = 'note' + (r.tone ? ' ' + r.tone : '');
      noteEl.textContent = r.note;
    }

    const hdr = $('respHeaders');
    const hasHeaders = !!(r.headers && r.headers.length);
    hdr.textContent = '';
    hdr.hidden = !hasHeaders;
    $('respHeadersTitle').hidden = !hasHeaders;
    $('respHeadersHint').hidden = !hasHeaders;
    if (hasHeaders) {
      r.headers.forEach(function (pair) {
        const tr = document.createElement('tr');
        const name = document.createElement('td');
        const value = document.createElement('td');
        name.textContent = pair[0];
        value.textContent = pair[1];
        tr.append(name, value);
        hdr.append(tr);
      });
    }

    const bodyEl = $('respBody');
    const bodyTitle = $('respBodyTitle');
    let body = null;
    if (failed) body = null;
    else if (r.body == null) body = null;
    else if (r.body.length === 0) body = '(empty body)';
    else body = pretty(r.body);

    bodyEl.hidden = body == null;
    bodyTitle.hidden = body == null;
    bodyEl.textContent = body == null ? '' : body;

    revealResponse();
  }

  function clearResponse() {
    setStatus('', 'READY');
    setText('respLabel', 'No request yet');
    $('respMeta').textContent = 'Send a request to see the status, timing, headers and body.';
    $('respNote').textContent = '';
    $('respNote').className = '';
    $('respHeaders').textContent = '';
    $('respHeaders').hidden = true;
    $('respHeadersTitle').hidden = true;
    $('respHeadersHint').hidden = true;
    $('respBody').textContent = '';
    $('respBody').hidden = true;
    $('respBodyTitle').hidden = true;
  }

  // ---- notes per endpoint ---------------------------------------------

  function healthNote(r) {
    if (r.error) return null;
    const j = json(r);
    if (r.status === 200 && j && j.ok === true) {
      return { text: 'Healthy. The service calls itself "' + (j.service || '?') + '".', tone: 'good' };
    }
    return null;
  }

  function historyNote(r) {
    if (r.error || r.status !== 200) return null;
    const j = json(r);
    if (!j) return null;
    const parts = [];
    if (j.count != null) parts.push(j.count + ' of ' + (j.total != null ? j.total : '?') + ' points');
    if (j.step) parts.push('step ' + j.step + ' s');
    if (Array.isArray(j.laps)) parts.push(j.laps.length + ' lap' + (j.laps.length === 1 ? '' : 's'));
    if (j.sampled) parts.push('downsampled server-side');
    if (j.truncated) parts.push('truncated');
    return parts.length ? { text: parts.join(' \u00b7 '), tone: 'good' } : null;
  }

  function liveNote(r) {
    if (r.error) return null;
    const j = json(r);

    if (r.status !== 200 || !j || j.ok !== true) {
      if (r.status === 400) {
        return { text: 'Topic keys may only use letters, digits, "_" and "-" (1-32 characters).', tone: 'bad' };
      }
      if (r.status === 504) {
        return { text: 'No retained frame arrived in time. If the device never published to this topic, there is nothing to replay; check the key.', tone: 'bad' };
      }
      if (r.status === 502) {
        return { text: 'The relay could not get through to the MQTT broker. Try again in a moment.', tone: 'bad' };
      }
      return null;
    }

    const f = j.frame;
    if (!f || typeof f !== 'object') {
      return { text: 'The broker returned a payload that is not a JSON frame.', tone: 'bad' };
    }

    const g = f.gps && typeof f.gps === 'object' ? f.gps : {};
    const s = f.sys && typeof f.sys === 'object' ? f.sys : {};
    const parts = [];

    parts.push(j.online === true ? 'device online'
      : j.online === false ? 'device offline'
      : 'online state unknown');
    parts.push(g.fix ? 'GPS fix' + (g.sats != null ? ' (' + g.sats + ' sats)' : '') : 'no GPS fix');
    if (g.fix && g.kmh != null) parts.push(g.kmh + ' km/h');
    if (f.roll != null && f.pitch != null) parts.push('roll ' + f.roll + '\u00b0 / pitch ' + f.pitch + '\u00b0');
    if (f.mpu === false) parts.push('MPU not detected');
    if (f.temp != null) parts.push('MPU ' + f.temp + ' \u00b0C');
    if (s.temp_c != null) parts.push('chip ' + s.temp_c + ' \u00b0C');
    if (s.rssi != null) parts.push('Wi-Fi ' + s.rssi + ' dBm');
    if (f.seq != null) parts.push('seq ' + f.seq);
    if (j.retained === false) parts.push('not retained');

    return { text: parts.join(' \u00b7 '), tone: j.online === false ? 'bad' : 'good' };
  }

  function ingestNote(r) {    if (r.error) return null;
    const j = json(r);
    if (r.status === 200 && j && j.ok) {
      const rejected = Array.isArray(j.rejected) ? j.rejected.length : 0;
      return {
        text: 'Stored ' + j.stored + ' of ' + j.received + ' frames' +
          (j.laps ? ', ' + j.laps + ' lap' + (j.laps === 1 ? '' : 's') : '') +
          (j.duplicates ? ', ' + j.duplicates + ' duplicate' + (j.duplicates === 1 ? '' : 's') : '') +
          (rejected ? ', ' + rejected + ' rejected' : '') +
          '. Retention: ' + j.retention + '.',
        tone: 'good'
      };
    }
    if (r.status === 401) {
      return { text: 'The key was rejected (401 unauthorized). Nothing was written.', tone: 'bad' };
    }
    if (r.status === 400 && j && j.error === 'no-frames') {
      if (r.intent === 'verify') {
        return { text: 'Key accepted - the empty probe body was rejected with no-frames, as designed. Nothing was written.', tone: 'good' };
      }
      return { text: 'The server saw no frames. Check that the box holds a JSON array.', tone: 'bad' };
    }
    if (r.status === 413) {
      return { text: 'The batch is over a limit: 120 frames or 64 KB.', tone: 'bad' };
    }
    if (r.status === 503) {
      return { text: 'This deployment has no INGEST_KEY configured, so ingest is disabled.', tone: 'bad' };
    }
    return null;
  }

  function optionsNote(r) {
    if (r.error) return null;
    if (r.status === 204) {
      return { text: 'Preflight answered with 204 and no body. The browser can send the real request.', tone: 'good' };
    }
    return null;
  }

  function errorNote(r) {
    if (r.error) return null;
    const j = json(r);
    if (r.status === 404 && j && j.error === 'not-found') {
      return { text: 'Routing works: the wrong method on a known path returns the documented 404 shape.', tone: 'good' };
    }
    if (r.status === 200) {
      return { text: 'This route answered GET. The router method check may have changed.', tone: 'bad' };
    }
    return null;
  }

  // ---- wiring ----------------------------------------------------------

  function flash(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    btn.disabled = true;
    setTimeout(function () {
      btn.textContent = old;
      btn.disabled = false;
    }, 1200);
  }

  function wireCopy() {
    document.querySelectorAll('[data-copy]').forEach(function (btn) {
      on(btn, 'click', async function () {
        const src = $(btn.getAttribute('data-copy'));
        if (!src) return;
        const text = src.textContent;
        try {
          await navigator.clipboard.writeText(text);
          flash(btn, 'Copied');
        } catch (e) {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.top = '-1000px';
          document.body.append(ta);
          ta.select();
          try { document.execCommand('copy'); flash(btn, 'Copied'); }
          catch (e2) { flash(btn, 'Copy failed'); }
          ta.remove();
        }
      });
    });
  }

  function wire() {
    // Base URL
    const baseEl = $('base');
    const savedBase = stored(BASE_STORAGE);
    if (savedBase) baseEl.value = savedBase;
    on(baseEl, 'input', function () { baseNote(); updateCurls(); });
    on(baseEl, 'change', function () {
      save(BASE_STORAGE, readBase() === DEFAULT_BASE ? '' : readBase());
    });
    on($('btnBaseReset'), 'click', function () {
      baseEl.value = DEFAULT_BASE;
      save(BASE_STORAGE, '');
      baseNote();
      updateCurls();
    });

    // GET /health
    document.querySelectorAll('[data-act="health"]').forEach(function (btn) {
      on(btn, 'click', function () {
        run({ label: 'GET /health', method: 'GET', path: '/health', intent: 'health', note: healthNote });
      });
    });

    // GET /history
    ['hFrom', 'hTo'].forEach(function (id) {
      on($(id), 'input', function () {
        updateEpoch(id, id === 'hFrom' ? 'hFromEpoch' : 'hToEpoch');
        updateCurls();
      });
    });
    ['hDevice', 'hLimit'].forEach(function (id) {
      on($(id), 'input', updateCurls);
    });
    on($('btnLast24'), 'click', setLast24);
    on($('btnHistoryClear'), 'click', function () {
      $('hFrom').value = '';
      $('hTo').value = '';
      updateEpoch('hFrom', 'hFromEpoch');
      updateEpoch('hTo', 'hToEpoch');
      clearHistoryError();
      updateCurls();
    });
    on($('form-history'), 'submit', function (e) {
      e.preventDefault();
      const from = epochOf($('hFrom'));
      const to = epochOf($('hTo'));
      if (Number.isNaN(from) || Number.isNaN(to)) {
        return showHistoryError('From and To must be valid local date-times.');
      }
      if (from != null && to != null && from >= to) {
        return showHistoryError('From must be earlier than To. The server returns 400 bad-window otherwise.');
      }
      clearHistoryError();
      run({
        label: 'GET /history',
        method: 'GET',
        path: historyQuery(),
        intent: 'history',
        note: historyNote
      });
    });

    // GET /live
    on($('lKey'), 'input', updateCurls);
    on($('form-live'), 'submit', function (e) {
      e.preventDefault();
      const key = $('lKey').value.trim();
      if (key && !/^[A-Za-z0-9_-]{1,32}$/.test(key)) {
        return showLiveError('Topic keys may only use letters, digits, "_" and "-" (1-32 characters).');
      }
      clearLiveError();
      run({
        label: 'GET /live',
        method: 'GET',
        path: liveQuery(),
        intent: 'live',
        note: liveNote
      });
    });

    // POST /ingest
    const keyEl = $('iKey');
    const remember = $('iRemember');
    const savedKey = stored(KEY_STORAGE);
    if (savedKey) {
      keyEl.value = savedKey;
      remember.checked = true;
    }
    on(remember, 'change', function () {
      save(KEY_STORAGE, remember.checked ? keyEl.value.trim() : '');
    });
    on(keyEl, 'change', function () {
      if (remember.checked) save(KEY_STORAGE, keyEl.value.trim());
    });
    on($('iFrames'), 'input', updateFramesMeta);
    on($('btnSample'), 'click', function () {
      resetSample();
      clearIngestError();
    });
    on($('form-ingest'), 'submit', function (e) {
      e.preventDefault();
      let key, body;
      try {
        key = ingestKey();
        body = ingestPayload();
      } catch (err) {
        return showIngestError(err.message);
      }
      clearIngestError();
      run({
        label: 'POST /ingest',
        method: 'POST',
        path: '/ingest',
        body: body,
        headers: { 'content-type': 'application/json', 'x-ingest-key': key },
        intent: 'send',
        note: ingestNote
      });
    });
    on($('btnVerifyKey'), 'click', function () {
      let key;
      try { key = ingestKey(); } catch (err) { return showIngestError(err.message); }
      clearIngestError();
      run({
        label: 'POST /ingest (key check)',
        method: 'POST',
        path: '/ingest',
        body: '{}',
        headers: { 'content-type': 'application/json', 'x-ingest-key': key },
        intent: 'verify',
        note: ingestNote
      });
    });

    // OPTIONS
    on($('oPath'), 'change', updateCurls);
    on($('form-options'), 'submit', function (e) {
      e.preventDefault();
      const path = $('oPath').value;
      run({
        label: 'OPTIONS ' + path,
        method: 'OPTIONS',
        path: path,
        intent: 'options',
        note: optionsNote
      });
    });

    // Wrong method (error shape)
    on($('form-error'), 'submit', function (e) {
      e.preventDefault();
      run({
        label: 'GET /ingest',
        method: 'GET',
        path: '/ingest',
        intent: 'error',
        note: errorNote
      });
    });

    on($('respClear'), 'click', clearResponse);
    wireCopy();

    // Initial state
    setLast24();
    resetSample();
    baseNote();
    updateCurls();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();

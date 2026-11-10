"use strict";

// ---------------------------------------------------------------------------
// web/ui/app.js — ESP32 Live Dashboard (neo-brutalist refactor)
// Keeps the live data path unchanged: MQTT over WebSocket, ingestGPS(),
// "?dev&t=..." mode, simulator, GPS + MPU6050 fields. No firmware changes.
// ---------------------------------------------------------------------------

// ---- settings -------------------------------------------------------------
const DEV_MODE = /(?:^|[?&])dev(?:&|$|#)/.test(location.search) || location.hostname === 'localhost';
const BROKER_URL = DEV_MODE ? 'ws://localhost:5003/mqtt' : 'wss://broker.hivemq.com:8884/mqtt';
const TOPIC_ROOT = "esp32-dash/";
// Must match TOPIC_KEY in src/mqtt_simple/mqtt_simple.cpp. Used only when the
// page is opened without a #t=<key> fragment, so the deployed dashboard shows
// live data straight away instead of the setup form. A second tracker changes
// that one firmware line and opens the dashboard with #t=<slug>.
const DEFAULT_KEY = 'race-tracker';

// Read-only history API (Cloudflare Pages Function, see docs/CLOUDFLARE.md).
// Public like the map: no key, no account. Loaded only when the HIST tab is
// opened, so a normal page view never depends on this host being reachable.
const HISTORY_API = 'https://race-tracker-history.pages.dev';
const STALE_AFTER_MS = 6000;
const N = 120;

// ---- helpers --------------------------------------------------------------
const $ = id => document.getElementById(id);
const C = { ink: "#000", blue: "#2447ff", red: "#ff3b1f", green: "#00e676", yellow: "#ffe600" };
const fmt = (v, d = 1) => (typeof v !== "number" || Number.isNaN(v)) ? "--" : v.toFixed(d);
const setPill = (el, text, cls) => { if (!el) return; el.textContent = text; el.className = "pill " + cls; };
const uptime = s => {
  const d = Math.floor(s / 86400);
  const hms = [Math.floor(s / 3600) % 24, Math.floor(s / 60) % 60, Math.floor(s % 60)]
    .map(n => String(n).padStart(2, "0")).join(":");
  return d > 0 ? d + "d " + hms : hms;
};

// ---- Tilt History Chart ----------------------------------------------------
function drawTiltChart() {
  const canvas = $('tiltChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  // Size canvas internal resolution to match its fixed-height container (120px CSS height)
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = Math.max(rect.width, 300);
  canvas.height = 120;
  const width = canvas.width;
  const height = canvas.height;

  // Clear canvas
  ctx.clearRect(0, 0, width, height);

  // Draw grid
  ctx.strokeStyle = '#444';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 10; i++) {
    const y = height - (i * height / 10);
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  // Draw tilt history
  if (GPS.tiltHistory.length > 0) {
    ctx.strokeStyle = C.blue;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const step = width / GPS.maxTiltHistory;
    GPS.tiltHistory.forEach((tilt, i) => {
      const x = i * step;
      const y = height - (tilt / 180) * height;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

// ---- Reverse geocoding (keyless: OSM Nominatim) ---------------------------
// The usage policy allows a browser app if it is gentle: one request at a time,
// never faster than ~1/s, and results must be cached. We are far stricter than
// that (3 s minimum, 25 m minimum movement, 7-day cache per ~110 m cell) so a
// dashboard that sits open all day costs a handful of requests.
const GEO = {
  lastAt: 0, lat: null, lng: null, pending: false,
  blockedUntil: 0, cache: null, text: ''
};
const GEO_MIN_MS = 8000;   // never faster than this (policy is 1 req/s)
const GEO_MIN_M = 80;      // and never for less than this much movement

const GEO_CACHE_TTL = 7 * 24 * 3600 * 1000;

function geoCache() {
  if (GEO.cache) return GEO.cache;
  try { GEO.cache = JSON.parse(localStorage.getItem('geoCache') || '{}') || {}; }
  catch (e) { GEO.cache = {}; }
  return GEO.cache;
}

function setAddress(text, loading) {
  if (GEO.text === text && !loading) return;
  GEO.text = text;
  const ids = ['hudAddress', 'liveAddr'];
  for (const id of ids) {
    const el = $(id);
    if (!el) continue;
    el.textContent = text;
    el.classList.toggle('loading', !!loading);
  }
}

function formatAddress(j) {
  const a = (j && j.address) || {};
  const road = a.road || a.pedestrian || a.footway || a.cycleway || a.path || a.residential;
  const roadLine = [a.house_number, road].filter(Boolean).join(' ');
  const area = a.suburb || a.village || a.neighbourhood || a.hamlet || a.city_district;
  const cityLine = [a.city || a.town || a.municipality || a.county || a.state, a.postcode]
    .filter(Boolean).join(' ');
  const parts = [roadLine, area, cityLine].filter(Boolean);
  if (parts.length) return parts.slice(0, 3).join(', ');
  const d = (j && j.display_name) || '';
  return d.split(',').slice(0, 2).join(',').trim();
}

async function fetchAddress(lat, lng) {
  const key = lat.toFixed(3) + ',' + lng.toFixed(3);
  const cache = geoCache();
  const hit = cache[key];
  if (hit && (Date.now() - hit.ts) < GEO_CACHE_TTL) {
    setAddress(hit.text, false);
    return;
  }

  GEO.pending = true;
  const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 6000) : 0;
  try {
    const url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1'
      + '&lat=' + lat.toFixed(6) + '&lon=' + lng.toFixed(6);
    const res = await fetch(url, ctrl ? { signal: ctrl.signal } : {});
    if (!res.ok) {
      // 403/429 = the policy engine is unhappy: stop asking for a while.
      if (res.status === 403 || res.status === 429) GEO.blockedUntil = Date.now() + 10 * 60 * 1000;
      throw new Error('geocode ' + res.status);
    }
    const j = await res.json();
    const text = formatAddress(j);
    if (text) {
      cache[key] = { text, ts: Date.now() };
      const keys = Object.keys(cache);
      if (keys.length > 200) {
        keys.sort((x, y) => cache[x].ts - cache[y].ts);
        for (const k of keys.slice(0, keys.length - 200)) delete cache[k];
      }
      try { localStorage.setItem('geoCache', JSON.stringify(cache)); } catch (e) { /* quota */ }
      setAddress(text, false);
    } else {
      setAddress('address not found', false);
    }
  } catch (e) {
    setAddress('address unavailable', false);
  } finally {
    if (timer) clearTimeout(timer);
    GEO.pending = false;
  }
}

function maybeAddress(lat, lng) {
  if (!num(lat) || !num(lng)) return;
  if (document.hidden) return;            // no point burning requests in a background tab
  const now = Date.now();
  if (now < GEO.blockedUntil || GEO.pending) return;
  if (now - GEO.lastAt < GEO_MIN_MS) return;
  if (GEO.lat != null && haversineM(GEO.lat, GEO.lng, lat, lng) < GEO_MIN_M) return;
  GEO.lastAt = now;
  GEO.lat = lat;
  GEO.lng = lng;
  fetchAddress(lat, lng);
}

// ---- topic key ------------------------------------------------------------
// Accepts the key either as #t=<key> (shareable link) or ?t=<key> (dev server).
function readKey() {
  const fromQuery = new URLSearchParams(location.search).get('t') || '';
  const raw = fromQuery || location.hash.slice(1);
  const key = raw.startsWith('t=') ? raw.slice(2) : raw;
  return /^[A-Za-z0-9_-]{8,64}$/.test(key) ? key : null;
}

// ---- state ----------------------------------------------------------------
const H = { t: [], a: [] };
const GPS = {
  origin: null,
  trace: [],
  maxPoints: 1500,
  totalDist: 0,
  elevGain: 0,
  elevLoss: 0,
  movingTime: 0,
  tiltHistory: [],
  maxTiltHistory: 120,
  stoppedTime: 0,
  maxSpeed: 0,
  lastPoint: null,
  lastValidTs: 0,
  lastChars: 0,
  lastCharsTs: 0,
  lastCharsVal: 0
};
let warn = 30, danger = 50;
let last = null;
let lastFixPos = null;
let lastFixTs = 0;
let staleAnnounced = false;
let lastLiveAt = 0;
let lastPush = 0;
let linkState = "connecting";
let deviceState = "unknown";

// Delivery health (the firmware stamps every reading with seq + ts)
let lastSeq = null;
let seqGaps = 0;
let seqDup = 0;
let lastRxAt = 0;

// View state: 'map2d'
let lockNorth = false;
let fusedHeading = 0;

// ---- GPS math helpers -----------------------------------------------------
function haversineM(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDeg(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  let brng = Math.atan2(y, x) * 180 / Math.PI;
  return (brng + 360) % 360;
}

// ---- GPS ingestion (unchanged data path) ---------------------------------
function ingestGPS(g) {
  if (window.isReplaying || !window.isRecording) return;
  if (!g) return;

  // Health first. This used to sit below the "no fix" early return, so chars/s
  // was never updated while the receiver had no lock - exactly the case the
  // "NO SKY / SEARCHING" states need to distinguish.
  if (typeof g.chars === 'number') {
    const nowC = Date.now();
    const dtC = (nowC - GPS.lastCharsTs) / 1000 || 1;
    const delta = g.chars - GPS.lastCharsVal;
    // A reboot resets the counter; treat a negative delta as a new baseline
    // instead of publishing a nonsense rate.
    GPS.lastChars = (GPS.lastCharsTs && delta >= 0)
      ? Math.round(delta / dtC)
      : 0;
    GPS.lastCharsVal = g.chars;
    GPS.lastCharsTs = nowC;
    // Render immediately: the health panel must stay live even when the
    // position block below returns early for a missing fix.
    if ($('vChars')) $('vChars').textContent = GPS.lastChars + '/s';
  }

  if (!g.fix || typeof g.lat !== 'number' || typeof g.lng !== 'number') return;

  const now = Date.now();
  // Simple local projection from first fix
  if (!GPS.origin) GPS.origin = { lat: g.lat, lng: g.lng };
  const cosLat = Math.cos(GPS.origin.lat * Math.PI / 180);
  const pt = {
    lat: g.lat, lng: g.lng,
    x: (g.lng - GPS.origin.lng) * 111320 * cosLat,
    y: typeof g.alt === 'number' ? g.alt : 0,
    z: (g.lat - GPS.origin.lat) * 110540,
    alt: typeof g.alt === 'number' ? g.alt : 0,
    kmh: typeof g.kmh === 'number' ? g.kmh : 0,
    cog: typeof g.cog === 'number' ? g.cog : 0,
    hdop: typeof g.hdop === 'number' ? g.hdop : null,
    sats: typeof g.sats === 'number' ? g.sats : null,
    fix: !!g.fix,
    ts: now
  };

  if (GPS.lastPoint) {
    const d = haversineM(GPS.lastPoint.lat, GPS.lastPoint.lng, g.lat, g.lng);
    if (d < 2.0) return;
    pt.distSegment = d;
  } else {
    pt.distSegment = 0;
  }

  if (typeof g.dist_m === 'number') GPS.totalDist = g.dist_m;
  maybeAddress(g.lat, g.lng);
  if (GPS.lastPoint) {
    const dy = pt.alt - GPS.lastPoint.alt;
    if (dy > 0) GPS.elevGain += dy; else GPS.elevLoss -= dy;
  }
  if (GPS.lastPoint) {
    const dt = (now - GPS.lastValidTs) / 1000;
    if (pt.kmh > 1) GPS.movingTime += dt; else GPS.stoppedTime += dt;
  }
  GPS.lastValidTs = now;
  GPS.lastPoint = { lat: g.lat, lng: g.lng, alt: pt.alt, ts: now };
  GPS.trace.push(pt);
  if (GPS.trace.length > GPS.maxPoints) GPS.trace.shift();

  if (pt.kmh > GPS.maxSpeed) GPS.maxSpeed = pt.kmh;

  updateStatsDOM();
  updateSignalDOM();
}

// ---- DOM rendering --------------------------------------------------------
// Kilometres with a precision that stays readable from 10 m to 100 km.
function fmtKm(m) {
  if (!num(m)) return '--';
  const km = m / 1000;
  // Always km: the HUD/label unit is fixed, so "0 m" under a "km" caption reads
  // like a bug. Two decimals below 10 km keeps 10 m resolution.
  return km < 10 ? km.toFixed(2) : km.toFixed(1);
}
function fmtDist(m) {
  if (!num(m)) return '--';
  return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(2) + ' km';
}
function trailMetres() {
  return (typeof MAP !== 'undefined' && MAP.getTrailDistance) ? MAP.getTrailDistance() : 0;
}

// ---- odometer (device counter + local zero offset) ------------------------
// The firmware counts from boot and there is no downlink to reset it, so the
// reset is a stored offset; if the device reboots (counter drops below it) the
// offset clears itself.
let odoOffset = 0;
let lastRawOdo = null;
try { odoOffset = Number(localStorage.getItem('odoOffset') || '0') || 0; } catch (e) { odoOffset = 0; }

function odometerM(raw) {
  if (!num(raw)) return null;
  lastRawOdo = raw;
  if (raw + 5 < odoOffset) {
    odoOffset = 0;
    try { localStorage.setItem('odoOffset', '0'); } catch (e) { /* quota */ }
  }
  return Math.max(0, raw - odoOffset);
}

function resetOdometer() {
  if (lastRawOdo == null) return;
  odoOffset = lastRawOdo;
  try { localStorage.setItem('odoOffset', String(odoOffset)); } catch (e) { /* quota */ }
  updateStatsDOM();
}


// ---- ACS712 setup ---------------------------------------------------------
// The firmware reports the module voltage (after its own 10k/22k divider), its
// zero and its amps. The board has no downlink, so "re-zero" and re-scaling are
// done here: the tab recomputes amps from the raw voltage with the values the
// user picks, and the rest of the UI uses that same number.
const ACS = {
  model: 5,
  sens: 0.185,
  divider: 0.6875,
  zero: null,          // null = follow the device zero
  views: [],
  hist: [],
  maxHist: 120,
  last: null
};
const ACS_SENS = { 5: 0.185, 20: 0.100, 30: 0.066 };

function acsLoad() {
  try {
    const s = JSON.parse(localStorage.getItem('acsCfg') || 'null');
    if (s && typeof s === 'object') {
      if (num(s.model)) ACS.model = s.model;
      if (num(s.sens)) ACS.sens = s.sens;
      if (num(s.divider)) ACS.divider = s.divider;
      if (num(s.zero)) ACS.zero = s.zero;
    }
  } catch (e) { /* ignore */ }
}

function acsSave() {
  try {
    localStorage.setItem('acsCfg', JSON.stringify({
      model: ACS.model, sens: ACS.sens, divider: ACS.divider, zero: ACS.zero
    }));
  } catch (e) { /* quota */ }
}

function acsDraw(canvas) {
  if (!canvas) return;
  const w = canvas.clientWidth || 240;
  const h = canvas.clientHeight || 84;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = '#cccccc';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
  const hist = ACS.hist;
  if (hist.length < 2) return;
  let peak = 1;
  for (const a of hist) peak = Math.max(peak, Math.abs(a));
  ctx.strokeStyle = '#2447ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  hist.forEach((a, i) => {
    const x = (i / (ACS.maxHist - 1)) * w;
    const y = h / 2 - (a / peak) * (h / 2 - 4);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function acsSync() {
  for (const v of ACS.views) {
    if (v.model) v.model.value = String(ACS.model);
    if (v.sens) v.sens.value = String(ACS.sens);
    if (v.div) v.div.value = String(ACS.divider);
    if (v.zeroin) {
      v.zeroin.value = ACS.zero == null ? '' : String(ACS.zero);
      v.zeroin.placeholder = 'auto';
    }
  }
}

function acsMount() {
  const tpl = $('tpl-acs');
  if (!tpl) return;
  const host = $('tab-acs');
  if (!host || host.dataset.acsMounted) return;
  {
    host.dataset.acsMounted = '1';
    host.appendChild(tpl.content.cloneNode(true));
    const q = s => host.querySelector(s);
    const v = {
      v: q('.a-v'), zero: q('.a-zero'), amp: q('.a-amp'), peak: q('.a-peak'),
      state: q('.a-state'), chart: q('.a-chart'), model: q('.a-model'),
      sens: q('.a-sens'), div: q('.a-div'), zeroin: q('.a-zeroin'), hint: q('.a-hint')
    };
    v.model.addEventListener('change', () => {
      ACS.model = Number(v.model.value) || 5;
      ACS.sens = ACS_SENS[ACS.model] || ACS.sens;
      acsSave(); acsSync(); acsRender();
    });
    v.sens.addEventListener('change', () => {
      const n = Number(v.sens.value);
      if (num(n) && n > 0.005 && n < 1) { ACS.sens = n; acsSave(); }
      acsSync(); acsRender();
    });
    v.div.addEventListener('change', () => {
      const n = Number(v.div.value);
      if (num(n) && n >= 0.1 && n <= 1) { ACS.divider = n; acsSave(); }
      acsSync(); acsRender();
    });
    v.zeroin.addEventListener('change', () => {
      const raw = v.zeroin.value.trim();
      if (raw === '') ACS.zero = null;
      else {
        const n = Number(raw);
        if (num(n) && n >= 0 && n <= 5) ACS.zero = n;
      }
      acsSave(); acsSync(); acsRender();
    });
    q('.a-zeronow').addEventListener('click', () => {
      if (!ACS.last || !num(ACS.last.vTrue)) return;
      ACS.zero = Math.round(ACS.last.vTrue * 1000) / 1000;
      acsSave(); acsSync(); acsRender();
    });
    q('.a-zerodev').addEventListener('click', () => {
      ACS.zero = null; acsSave(); acsSync(); acsRender();
    });
    q('.a-reset').addEventListener('click', () => {
      ACS.model = 5; ACS.sens = 0.185; ACS.divider = 0.6875; ACS.zero = null;
      acsSave(); acsSync(); acsRender();
    });
    ACS.views.push(v);
  }
  acsSync();
}

function acsStateText(vTrue, amps, deadband) {
  if (!(vTrue > 0.3 && vTrue < 4.9))
    return 'NO SIGNAL - sensor unplugged or pin floating (0 A should read ~2.5 V)';
  if (Math.abs(amps) > 30) return 'OUT OF RANGE - check model / divider';
  if (Math.abs(amps) < (num(deadband) ? deadband : 0.08)) return 'OK - idle (0 A)';
  return 'OK';
}

// Called on every reading with the firmware's acs block.
function acsUpdate(acs, peakA) {
  if (!acs || !num(acs.v)) return;
  const scale = 0.6875 / (ACS.divider || 0.6875);
  const vTrue = acs.v * scale;
  const zeroTrue = (ACS.zero != null) ? ACS.zero : (num(acs.zero) ? acs.zero * scale : 0);
  const amps = (vTrue - zeroTrue) / (ACS.sens || 0.185);
  // Presence is the firmware's call: it owns the calibrated zero and (since
  // 1.3.1) requires that zero to sit near mid-supply. A second 0.3-4.9 V
  // "presence" test here is what made the pill read ACS OK on a floating
  // pin. The raw range is only used for the numeric readout.
  const inRange = !!acs.ok && vTrue > 0.05 && vTrue < 4.9;
  ACS.last = { vTrue, zeroTrue, amps, inRange, raw: acs };
  ACS.hist.push(inRange ? amps : 0);
  if (ACS.hist.length > ACS.maxHist) ACS.hist.shift();
  acsRender();
}

function acsRender() {
  const st = ACS.last;
  if (!st) return;
  const text = acsStateText(st.vTrue, st.amps, st.raw.deadband);
  for (const v of ACS.views) {
    if (v.v) v.v.textContent = st.vTrue.toFixed(3);
    if (v.zero) v.zero.textContent = st.zeroTrue.toFixed(3);
    if (v.amp) v.amp.textContent = st.inRange ? fmt(st.amps, 2) : 'ERR';
    if (v.peak) v.peak.textContent = num(st.raw.peak) ? fmt(st.raw.peak, 2) : '--';
    if (v.state) v.state.textContent = text;
    if (v.hint) {
      v.hint.textContent = 'Firmware: zero ' + (num(st.raw.zero) ? st.raw.zero.toFixed(3) : '--')
        + ' V, ' + (num(st.raw.amps) ? st.raw.amps.toFixed(2) : '--') + ' A'
        + ' · ' + (st.raw.ok ? 'acs.ok' : 'acs.not ok');
    }
    acsDraw(v.chart);
  }
}

function updateStatsDOM() {
  const avgSpd = GPS.movingTime > 0 ? (GPS.totalDist / 1000) / (GPS.movingTime / 3600) : 0;
  const el = id => $(id);
  const trailM = trailMetres();
  if (el('hudDist')) el('hudDist').textContent = fmtKm(trailM);
  if (el('liveTrailDist')) el('liveTrailDist').textContent = fmtKm(trailM);
  const odo = odometerM(GPS.totalDist);
  if (el('vDist')) el('vDist').textContent = odo == null ? '--' : odo.toFixed(1);
  if (el('liveDist')) el('liveDist').textContent = odo == null ? '--' : odo.toFixed(1);
  if (el('vAvgSpd')) el('vAvgSpd').textContent = avgSpd.toFixed(1);
  if (el('vMaxSpd')) el('vMaxSpd').textContent = GPS.maxSpeed.toFixed(1);
  if (el('liveMaxSpd')) el('liveMaxSpd').textContent = GPS.maxSpeed.toFixed(1);
  if (el('vMoveT')) el('vMoveT').textContent = Math.round(GPS.movingTime);
  if (el('vElevGain')) el('vElevGain').textContent = Math.round(GPS.elevGain);
  if (el('vElevLoss')) el('vElevLoss').textContent = Math.round(GPS.elevLoss);
}

// Measure badge on the map (A -> B distance).
function renderMeasure({ a, b, distM }) {
  const box = $('measureInfo');
  if (!box) return;
  box.hidden = false;
  const val = $('measureValue');
  const hint = $('measureHint');
  if (!a) { if (val) val.textContent = '--'; if (hint) hint.textContent = 'tap point A on the map'; }
  else if (!b) { if (val) val.textContent = '--'; if (hint) hint.textContent = 'tap point B on the map'; }
  else {
    if (val) val.textContent = fmtDist(distM);
    if (hint) hint.textContent = 'tap again to measure';
  }
}

function updateSignalDOM() {
  const last = GPS.trace[GPS.trace.length - 1];
  if (!last) return;
  if ($('vHdop')) $('vHdop').textContent = last.hdop != null ? last.hdop.toFixed(2) : '--';
  if ($('liveHdop')) $('liveHdop').textContent = last.hdop != null ? last.hdop.toFixed(2) : '--';
  if ($('vSats')) $('vSats').textContent = last.sats != null ? last.sats : '--';
  if ($('liveSats')) $('liveSats').textContent = last.sats != null ? last.sats : '--';
  if ($('vFix')) $('vFix').textContent = last.fix ? 'VALID' : 'INVALID';
  if ($('liveFix')) $('liveFix').textContent = last.fix ? 'VALID' : 'INVALID';
  if ($('vChars')) $('vChars').textContent = GPS.lastChars != null ? GPS.lastChars + '/s' : '--';
}

// ---- rendering: main data -------------------------------------------------
function renderData(d) {
  warn = d.warn; danger = d.danger;
  const ok = !!d.mpu, acs = d.acs, gps = d.gps, sys = d.sys;

  // ACS712: recompute in the browser with the user's sensor settings, so the
  // LIVE readout and the setup tab always agree.
  acsUpdate(acs, d.peakA);
  const acsGood = ACS.last ? ACS.last.inRange : !!acs.ok;
  const ampsTxt = (ACS.last && ACS.last.inRange) ? fmt(ACS.last.amps, 2) : 'ERR';

  // Pills
  setPill($('pMpu'), ok ? "MPU OK" : "MPU FAIL", ok ? "ok" : "bad");
  setPill($('pAcs'), acsGood ? "ACS OK" : "ACS CHECK", acsGood ? "ok" : "bad");
  setPill($('pGps'), gps.fix ? "GPS FIX" : (gps.chars < 10 ? "GPS NO DATA" : "GPS WAIT"),
    gps.fix ? "ok" : (gps.chars < 10 ? "bad" : "wait"));

  // Telemetry readouts (LIVE tab + map HUD)
  // Without a GPS fix the payload carries nulls for lat/lng/alt/speed. Printing
  // "NO FIX" instead of "--" makes clear the data was received but has no fix.
  const gv = (v, d) => (!gps.fix ? 'NO FIX' : (num(v) ? fmt(v, d) : '--'));
  const set = (id, val) => { const e = $(id); if (e) e.textContent = val; };
  // A parked receiver reports a couple of km/h of noise; show 0 instead.
  const parkedNow = (typeof MAP !== 'undefined' && MAP.isParked) ? MAP.isParked() : false;
  const spdTxt = !gps.fix ? 'NO FIX' : (parkedNow ? '0.0' : gv(gps.kmh));
  set('liveSpeed', spdTxt);
  set('liveAlt', gv(gps.alt));
  set('liveFix', gps.fix ? 'VALID' : 'NO FIX');
  set('liveTilt', fmt(d.tilt) + ' deg');
  set('liveAmps', ampsTxt);
  set('hudSpeed', spdTxt);
  set('gSpd', gps.fix ? (parkedNow ? '0.0 km/h' : (num(gps.kmh) ? fmt(gps.kmh) + ' km/h' : '--')) : 'NO FIX');
  if (num(gps.dist_m)) {
    const odo = odometerM(gps.dist_m);
    if (odo != null) {
      set('liveDist', odo.toFixed(1));
    }
  }

  // MPU6050 data
  set('mpuRoll', fmt(d.roll));
  set('mpuPitch', fmt(d.pitch));
  set('mpuYaw', fmt(d.yaw));
  set('mpuMaxTilt', fmt(d.maxTilt));
  set('mpuAx', fmt(d.ax, 2));
  set('mpuAy', fmt(d.ay, 2));
  set('mpuAz', fmt(d.az, 2));
  set('mpuTilt', fmt(d.tilt));
  set('mpuWarn', d.warn);
  set('mpuDanger', d.danger);

  // Update tilt history
  if (num(d.tilt)) {
    GPS.tiltHistory.push(d.tilt);
    if (GPS.tiltHistory.length > GPS.maxTiltHistory) {
      GPS.tiltHistory.shift();
    }
    drawTiltChart();
  }

  // Motion panel values (kept for reference)
  set('vRoll', fmt(d.roll)); set('vPitch', fmt(d.pitch)); set('vYaw', fmt(d.yaw));
  set('vTilt', fmt(d.tilt) + ' deg');
  set('vAx', fmt(d.ax, 2) + ' g'); set('vAy', fmt(d.ay, 2) + ' g'); set('vAz', fmt(d.az, 2) + ' g');
  set('vWarn', d.warn + ' deg'); set('vDanger', d.danger + ' deg');
  set('tTemp', fmt(d.temp) + ' C');
  set('vAmps', ampsTxt);
  set('vPeak', fmt(d.peakA, 2)); set('vSv', fmt(acs.v, 3)); set('vZv', fmt(acs.zero, 3));

  // GPS values
  set('gSat', num(gps.sats) ? gps.sats : '--');
  set('liveSats', num(gps.sats) ? gps.sats : '--');
  set('liveHdop', num(gps.hdop) ? gps.hdop.toFixed(2) : '--');
  set('gLat', gps.fix ? fmt(gps.lat, 6) : 'NO FIX');
  set('gLng', gps.fix ? fmt(gps.lng, 6) : 'NO FIX');
  set('gAlt', gps.fix && num(gps.alt) ? fmt(gps.alt) + ' m' : (gps.fix ? '--' : 'NO FIX'));


  // Map HUD - position
  set('hudLat', fmt(gps.lat, 6)); set('hudLng', fmt(gps.lng, 6));
  set('hudAlt', num(gps.alt) ? fmt(gps.alt) + ' m' : '--');

  // Device values
  set('sUp', num(d.up) ? uptime(d.up) : '--');
  set('sRssi', num(sys.rssi) ? sys.rssi + ' dBm' : '--');
  set('sHeap', num(sys.heap) ? Math.round(sys.heap / 1024) + ' KB' : '--');

  // WiFi tab values (desktop)
  set('wifiUp', num(d.up) ? uptime(d.up) : '--');
  set('wifiRssi', num(sys.rssi) ? sys.rssi + ' dBm' : '--');
  set('wifiHeap', num(sys.heap) ? Math.round(sys.heap / 1024) + ' KB' : '--');
  set('wifiHeapMin', num(sys.heap_min) ? Math.round(sys.heap_min / 1024) + ' KB' : '--');
  set('wifiBoot', num(sys.boot) ? sys.boot : '--');
  set('wifiLast', new Date().toLocaleTimeString());

  // WiFi connection info - sys object should have wifi data
  const wifi = sys.wifi || {};
  set('wifiSsid', wifi.ssid || '--');
  set('wifiBssid', wifi.bssid || '--');
  set('wifiChan', wifi.channel || '--');
  set('wifiStatus', wifi.status || (num(sys.rssi) ? 'Connected' : 'Disconnected'));
  set('wifiIp', wifi.ip || '--');
  set('wifiMac', wifi.mac || '--');

  // Device clock / delivery health
  set('liveSeq', num(d.seq) ? d.seq : '--');
  if (num(d.seq)) {
    set('liveGap', seqGaps);
  }
  if (num(d.ts) && d.ts > 0) {
    set('liveTs', new Date(d.ts * 1000).toISOString().slice(11, 19));
  } else {
    set('liveTs', 'no clock');
  }

  // Danger LEDs — solid blocks
  const lvl = d.lvl;
  $('ledB').classList.toggle('on', ok && lvl === 0);
  $('ledW').classList.toggle('on', ok && lvl === 1);
  $('ledR').classList.toggle('on', ok && lvl === 2);

}


const num = v => typeof v === "number" && Number.isFinite(v);
function validData(d) {
  return d && typeof d === "object" &&
    num(d.tilt) && num(d.roll) && num(d.pitch) && num(d.yaw) && num(d.lvl) && d.lvl >= 0 && d.lvl <= 2 &&
    num(d.warn) && num(d.danger) &&
    d.acs && typeof d.acs === "object" && d.gps && typeof d.gps === "object" &&
    d.sys && typeof d.sys === "object";
}

// ---- rendering: banner / status strip -------------------------------------
function renderBanner() {
  const strip = $('statusStrip');
  const text = $('statusText');
  const sub = $('statusSub');
  const age = Date.now() - lastLiveAt;
  const live = lastLiveAt > 0 && age < STALE_AFTER_MS;

  // A stale fix must not move or rotate the marker. Announce the loss once and
  // keep the last known heading: feeding heading 0 here (as the old code did on
  // every tick) decayed the compass towards north while the vehicle sat still.
  if (typeof MAP !== 'undefined' && MAP.isReady()) {
    const staleFix = lastFixPos && lastFixTs > 0 && (Date.now() - lastFixTs) > 2000;
    if (staleFix && !staleAnnounced) {
      MAP.setVehicle(lastFixPos.lng, lastFixPos.lat, MAP.getHeading().heading,
        0, null, false, Date.now());
      staleAnnounced = true;
    } else if (!staleFix) {
      staleAnnounced = false;
    }
  }

  if (!strip) return;

  strip.className = 'status-strip';
  if (linkState !== "connected") {
    strip.classList.add('nofix');
    text.textContent = "CONNECTING";
    sub.textContent = "opening link to broker";
  } else if (deviceState === "offline") {
    strip.classList.add('nofix');
    text.textContent = "DEVICE OFFLINE";
    sub.textContent = last ? "showing last known values" : "waiting for the ESP32 to come online";
  } else if (!live) {
    strip.classList.add('stale');
    text.textContent = last ? "NO SIGNAL" : "WAITING";
    sub.textContent = last ? "no live data, showing last known values" : "waiting for first reading";
  } else if (!last.mpu) {
    strip.classList.add('nofix');
    text.textContent = "NO MPU DATA";
    sub.textContent = "check MPU6050 wiring";
  } else {
    const lvl = last.lvl;
    strip.classList.add(lvl >= 2 ? 'danger' : (lvl >= 1 ? 'warn' : 'safe'));
    text.textContent = ["SAFE", "WARNING", "DANGER"][lvl];
    const gpsNote = (last.gps && last.gps.fix)
      ? ''
      : '  |  GPS NO FIX (' + (num(last.gps && last.gps.sats) ? last.gps.sats : 0) + ' sats)';
    sub.textContent = "tilt " + fmt(last.tilt, 0) + " deg  |  warn " + last.warn + "  danger " + last.danger + gpsNote;
  }

  setPill($('pLink'), linkState === "connected" ? "BROKER OK" : "BROKER ...", linkState === "connected" ? "ok" : "wait");
  if (deviceState === "offline") setPill($('pDev'), "DEVICE OFFLINE", "bad");
  else if (live) setPill($('pDev'), "DEVICE LIVE", "ok");
  else setPill($('pDev'), last ? "NO SIGNAL" : "DEVICE ...", last ? "bad" : "wait");

  if ($('lState')) $('lState').textContent = linkState.toUpperCase();
  if ($('sState')) $('sState').textContent = live ? "LIVE" : "NOT LIVE";
  if ($('sAge')) $('sAge').textContent = lastLiveAt ? Math.round(age / 1000) + " s ago" : "--";
  const ageTxt = lastRxAt ? (Math.round((Date.now() - lastRxAt) / 1000) + '') : '--';
  if ($('liveAge')) $('liveAge').textContent = ageTxt;
  if ($('fTime')) $('fTime').textContent = new Date().toLocaleTimeString();

  // Heading readout
  if (typeof MAP !== 'undefined' && MAP.isReady()) {
    const h = MAP.getHeading();
    if ($('hudHeading')) $('hudHeading').textContent = Math.round(h.heading) + '\u00B0';
    if ($('liveCog')) $('liveCog').textContent = Math.round(h.heading);
    if ($('hudSource')) {
      $('hudSource').textContent = GPS.lastPoint
        ? GPS.lastPoint.lat.toFixed(4) + ', ' + GPS.lastPoint.lng.toFixed(4)
        : 'NO FIX';
    }
  }
}

// ---- MQTT -----------------------------------------------------------------
function onMessage(topic, payload, retained) {
  if (topic === TOPIC_STATUS) {
    deviceState = payload === "online" ? "online" : payload === "offline" ? "offline" : "unknown";
    renderBanner();
    return;
  }
  if (topic !== TOPIC_DATA) return;

  let d;
  try { d = JSON.parse(payload); } catch (e) { return; }
  if (!validData(d)) return;

  // One gate for every live frame. A public broker means anyone can publish
  // here, so a frame has to survive plausibility checks before it can touch the
  // map, the trip meter or the charts.
  if (typeof GUARD !== 'undefined') {
    const verdict = GUARD.accept(d);
    if (!verdict.ok) {
      if (verdict.reason !== 'flood') console.warn('[guard] dropped frame:', verdict.reason, 'seq', d.seq);
      return;
    }
  }

  last = d;

  // Ask for the street name even when the vehicle is parked and sends no new
  // trail point (the first retained fix on page load lands here).
  if (d.gps && d.gps.fix && !GEO.text) maybeAddress(d.gps.lat, d.gps.lng);

  // Feed live GPS into the map
  if (typeof MAP !== 'undefined' && MAP.isReady() && d.gps && typeof d.gps.lat === 'number') {
    const g = d.gps;
    MAP.setVehicle(g.lng, g.lat, typeof g.cog === 'number' ? g.cog : 0,
      typeof g.kmh === 'number' ? g.kmh : 0, g.hdop, g.fix, Date.now(),
      typeof d.roll === 'number' ? d.roll : null,
      typeof d.pitch === 'number' ? d.pitch : null,
      typeof d.yaw === 'number' ? d.yaw : null,
      typeof d.mag_heading === 'number' ? d.mag_heading : null,
      typeof d.lvl === 'number' ? d.lvl : 0,
      typeof g.alt === 'number' ? g.alt : null);
    if (g.fix) { lastFixPos = { lng: g.lng, lat: g.lat }; lastFixTs = Date.now(); }
    fusedHeading = MAP.getHeading().heading;
  }

  ingestGPS(d.gps);

  // Sequence bookkeeping: a jump means readings were lost, a repeat means the
  // broker replayed a retained message.
  if (typeof d.seq === 'number') {
    if (lastSeq != null) {
      if (d.seq > lastSeq + 1) seqGaps += d.seq - lastSeq - 1;
      else if (d.seq === lastSeq) seqDup++;
    }
    lastSeq = d.seq;
  }
  lastRxAt = Date.now();

  // The firmware publishes every reading with retain=true, so the retained flag
  // does NOT mean "history": a retained message can arrive right after the
  // previous one. Receipt time is the only reliable liveness signal.
  lastLiveAt = Date.now();
  const now = Date.now();
  if (now - lastPush >= 1000) {
    lastPush = now;
    H.t.push(d.tilt); H.a.push(d.acs.ok && num(d.acs.amps) ? d.acs.amps : 0);
    if (H.t.length > N) { H.t.shift(); H.a.shift(); }
  }
  renderData(d);
  renderBanner();
}

// ---- start ----------------------------------------------------------------
const rawHash = location.hash.slice(1);
const hashKey = readKey();
// No key given at all -> use the built-in key. A key that is present but
// malformed must NOT silently fall back, otherwise a typo would quietly show
// somebody else's data.
let KEY = hashKey || (rawHash.length ? null : DEFAULT_KEY);
if (!KEY && DEV_MODE) {
  KEY = 'dev-test-1234';
  location.hash = 't=' + KEY;
}

// "SIMULATED" only makes sense against the local simulator, never on a live page.
const simBadge = $('sim-badge');
if (simBadge) simBadge.style.display = DEV_MODE ? '' : 'none';

const TOPIC_DATA = KEY ? TOPIC_ROOT + KEY + "/data" : "";
const TOPIC_STATUS = KEY ? TOPIC_ROOT + KEY + "/status" : "";

// ---- Lock mode -----------------------------------------------------------
// Spectator by default. Controls that reset or change local state are hidden
// until the operator holds the lock button for 1.2 s, and hide again after two
// idle minutes. This is accident protection, not authentication: nothing here
// reaches the device.
const LOCK = (function () {
  const IDLE_MS = 120000;
  const HOLD_MS = 1200;
  let locked = true;
  let idleTimer = 0;
  let holdTimer = 0;
  let suppressClick = false;

  function paint() {
    document.body.classList.toggle('locked', locked);
    const b = $('btnLock');
    if (!b) return;
    b.textContent = locked ? 'LOCKED' : 'OPERATOR';
    b.classList.toggle('on', !locked);
    b.setAttribute('aria-pressed', String(!locked));
  }

  function lock() {
    locked = true;
    suppressClick = false;
    if (idleTimer) clearTimeout(idleTimer);
    if (holdTimer) clearTimeout(holdTimer);
    idleTimer = holdTimer = 0;
    paint();
  }

  function arm() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(lock, IDLE_MS);
  }

  function unlock() {
    locked = false;
    paint();
    arm();
  }

  const btn = $('btnLock');
  if (btn) {
    btn.addEventListener('pointerdown', (e) => {
      if (!locked) return;
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = setTimeout(() => { suppressClick = true; unlock(); }, HOLD_MS);
    });
    const cancel = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; } };
    btn.addEventListener('pointerup', cancel);
    btn.addEventListener('pointerleave', cancel);
    btn.addEventListener('pointercancel', cancel);
    // The click that follows a successful hold must not immediately relock.
    btn.addEventListener('click', () => {
      if (suppressClick) { suppressClick = false; return; }
      if (!locked) lock();
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (locked) unlock(); else lock();
    });
  }

  // Any interaction while unlocked postpones the relock.
  document.addEventListener('pointerdown', () => { if (!locked) arm(); }, true);
  document.addEventListener('keydown', () => { if (!locked) arm(); }, true);

  paint();
  return { lock, unlock, arm, isLocked: () => locked };
})();
window.LOCK = LOCK;

if (!KEY) {
  $('setup').style.display = 'block';
  if (simBadge) simBadge.style.display = 'none';
  if ($('grid')) $('grid').style.display = 'none';
  if ($('banner')) $('banner').style.display = 'none';
  $('keyForm').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('keyInput').value.trim();
    if (/^[A-Za-z0-9_-]{8,64}$/.test(v)) { location.hash = "t=" + v; location.reload(); }
    else $('keyInput').setCustomValidity("Use 8-64 letters, digits, - or _");
  });
  $('keyInput').addEventListener('input', () => $('keyInput').setCustomValidity(""));
} else {
  $('setup').style.display = 'none';
  if ($('lKey')) $('lKey').textContent = KEY.slice(0, 4) + "..." + KEY.slice(-2);
  acsLoad();
  acsMount();
  renderBanner();

  const client = new MiniMqtt({
    url: BROKER_URL,
    topics: [TOPIC_DATA, TOPIC_STATUS],
    onMessage,
    onState: s => { linkState = s; if (s !== "connected") deviceState = "unknown"; renderBanner(); }
  });
  client.start();

  // ---- stored history (HIST tab) ------------------------------------------
  // On demand only. A failure here leaves the live map completely untouched:
  // no console error, no rejected promise, just a status line in the panel.
  let histMinutes = 1440;

  function kmBetween(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  function setHistFields(points, km, gap, windowText, statusText) {
    if ($('histPoints')) $('histPoints').textContent = points;
    if ($('histDist')) $('histDist').textContent = km;
    if ($('histGap')) $('histGap').textContent = gap;
    if ($('histWindow')) $('histWindow').textContent = windowText;
    if ($('histStatus')) $('histStatus').textContent = statusText;
  }

  async function loadHistory(minutes) {
    histMinutes = minutes;
    document.querySelectorAll('.hist-btn').forEach(b => {
      const on = Number(b.dataset.min) === minutes;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if ($('histStatus')) $('histStatus').textContent = 'loading...';

    const now = Math.floor(Date.now() / 1000);
    const from = now - minutes * 60;
    let body;
    try {
      const res = await fetch(`${HISTORY_API}/history?from=${from}&to=${now + 60}&limit=5000`,
        { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      body = await res.json();
    } catch (err) {
      // Offline, blocked or the host is down: the panel says so and the live
      // data keeps rendering. Deliberately not console.error().
      if (typeof MAP !== 'undefined' && MAP.clearHistory) MAP.clearHistory();
      setHistFields('--', '--', '--', '--', 'history host unreachable (' + err.message + ')');
      return;
    }

    const pts = Array.isArray(body && body.points) ? body.points : [];
    let km = 0, maxGap = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (!a || !b) continue;
      km += kmBetween([a[1], a[2]], [b[1], b[2]]);
      const gap = b[0] - a[0];
      if (gap > maxGap) maxGap = gap;
    }

    let windowText = '--';
    if (pts.length) {
      const t0 = new Date(pts[0][0] * 1000).toISOString().slice(11, 16);
      const t1 = new Date(pts[pts.length - 1][0] * 1000).toISOString().slice(11, 16);
      windowText = `${t0} - ${t1} UTC`;
    }

    const drawn = (typeof MAP !== 'undefined' && MAP.setHistory) ? MAP.setHistory(pts) : 0;
    let status = 'nothing stored in this window';
    if (pts.length) {
      status = `drawn as ${drawn} line(s)`;
      // The API samples wide windows instead of returning the first 5000
      // points, so say so: "24 h" that only covers two hours would be a lie.
      if (body.sampled) status += ` (1 of ${body.step} points, ${body.total} total)`;
      if (body.truncated) status += ', truncated at 5000';
    }
    setHistFields(
      String(body.count != null ? body.count : pts.length),
      km.toFixed(2),
      pts.length > 1 ? String(maxGap) : '--',
      windowText,
      status
    );
  }

  // ---- Init map -----------------------------------------------------------
  if (typeof MAP !== 'undefined') {
    MAP.create('map-container');
    MAP.loaded().then(() => {
      MAP.resize();
      // Force a resize after a short delay to ensure map renders
      setTimeout(() => MAP.resize(), 500);
    }).catch(() => {
      console.warn('Map failed to load');
    });
  }

  // ---- GPS controls -------------------------------------------------------
  window.isRecording = true;
  window.isReplaying = false;
  // ---- Tab switching ------------------------------------------------------
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      // One panel per tab now; there is no desktop/mobile duplicate to find.
      const target = $('tab-' + btn.dataset.tab);
      if (target) target.classList.add('active');
      // History is fetched on demand: opening the tab is the request.
      if (btn.dataset.tab === 'history') loadHistory(histMinutes);
    });
  });

  document.querySelectorAll('.hist-btn').forEach(btn => {
    btn.addEventListener('click', () => loadHistory(Number(btn.dataset.min) || 1440));
  });

  // ---- My-location / compass ---------------------------------------------
  const btnMyLocation = $('btnMyLocation');
  if (btnMyLocation && typeof MAP !== 'undefined') {
    btnMyLocation.innerHTML = '🧭';
    btnMyLocation.className = 'map-btn';
    btnMyLocation.title = 'Re-center on vehicle';
    btnMyLocation.addEventListener('click', (e) => {
      e.preventDefault();
      MAP.recenterNow();
    });
  }

  // ---- Measure A->B + trip reset -----------------------------------------
  let measureOn = false;
  function toggleMeasure(force) {
    measureOn = (typeof force === 'boolean') ? force : !measureOn;
    if (typeof MAP === 'undefined') return;
    MAP.setMeasureMode(measureOn);
    const b = $('btnMeasure');
    if (b) b.classList.toggle('active', measureOn);
    const box = $('measureInfo');
    if (box) box.hidden = !measureOn;
    if (!measureOn) {
      MAP.clearMeasure();
      if (box) box.hidden = true;
    } else {
      renderMeasure({ a: null, b: null, distM: null });
    }
  }

  function resetTrip() {
    if (typeof MAP !== 'undefined') MAP.clearTrail();
    GPS.trace.length = 0;
    GPS.lastPoint = null;
    GPS.maxSpeed = 0;
    GPS.movingTime = 0;
    GPS.stoppedTime = 0;
    GPS.elevGain = 0;
    GPS.elevLoss = 0;
    updateStatsDOM();
  }

  const btnMeasure = $('btnMeasure');
  if (btnMeasure) btnMeasure.addEventListener('click', () => toggleMeasure());
  const btnResetTrip = $('btnResetTrip');
  if (btnResetTrip) btnResetTrip.addEventListener('click', () => resetTrip());
  const btnResetOdo = $('btnResetOdo');
  if (btnResetOdo) btnResetOdo.addEventListener('click', (e) => { e.stopPropagation(); resetOdometer(); });
  if (typeof MAP !== 'undefined' && MAP.onMeasure) MAP.onMeasure(renderMeasure);

  // ---- Keyboard shortcuts -------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (k === 'c' && typeof MAP !== 'undefined') { e.preventDefault(); MAP.recenterNow(); }

    else if (k === 'm') { if (LOCK.isLocked()) return; e.preventDefault(); toggleMeasure(); }
    else if (k === 'r') { if (LOCK.isLocked()) return; e.preventDefault(); resetTrip(); }
    else if (k === 'escape') { e.preventDefault(); toggleMeasure(false); }
  });

  setInterval(renderBanner, 500);
  window.addEventListener('resize', () => { if (typeof MAP !== 'undefined') MAP.resize(); });
}

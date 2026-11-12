"use strict";

// ---------------------------------------------------------------------------
// web/ui/app.js - Orion Project live dashboard (neo-brutalist refactor)
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
  ctx.font = '10px "Courier New", Courier, monospace';

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

  if (!GPS.tiltHistory.length) {
    ctx.fillStyle = '#666';
    ctx.fillText('waiting for the MPU', 8, height / 2);
    return;
  }

  // A fixed 0-180 scale made normal driving (2-10 deg) a flat line on the
  // bottom pixel. Use the buffer's own peak with a 30 deg floor, so a real
  // lean is visible and a spike still fits.
  let peak = 0;
  for (const v of GPS.tiltHistory) {
    const a = Number(v);
    if (Number.isFinite(a) && a > peak) peak = a;
  }
  const maxDeg = Math.max(30, Math.ceil(peak / 10) * 10);

  // Draw tilt history
  ctx.strokeStyle = C.blue;
  ctx.lineWidth = 2;
  ctx.beginPath();
  const step = width / GPS.maxTiltHistory;
  GPS.tiltHistory.forEach((tilt, i) => {
    const x = i * step;
    const y = height - (Math.min(1, tilt / maxDeg) * (height - 4)) - 2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = '#000';
  ctx.fillText(`tilt 0-${maxDeg} deg`, 4, 11);
}

// ---- live sample history ---------------------------------------------------
// Kept in memory only; nothing here is a second upload path. The board sends
// at 1 Hz (the dev simulator faster), so a sample cap is also a time window.
const LIVE_HIST = { speed: [], max: 180 };   // [t, km/h, hdop]
const WIFI_HIST = { rssi: [], heap: [], max: 300 };
const MPU_HIST = { accel: [], max: 180 };
const RX_TIMES = { pts: [], max: 240 };

function pushSample(list, point, max) {
  list.push(point);
  if (list.length > max) list.splice(0, list.length - max);
}

const putText = (id, value) => {
  const el = $(id);
  if (el) el.textContent = value;
};

// Speed over the last few minutes, with the same HDOP > 3 shading as HIST so a
// bad fix is never mistaken for a fast section.
function renderLiveChart() {
  const pts = LIVE_HIST.speed;
  if (!pts.length) return;
  const max = CHARTS.niceMax(CHARTS.autoMax(pts.map(p => p[1]), 20), 20);
  CHARTS.drawSeries($('liveChart'), {
    height: 120,
    series: [{
      pts: pts.map(p => [p[0], p[1]]),
      min: 0,
      max,
      color: '#000',
      width: 2
    }],
    bands: CHARTS.bands(pts, p => Number(p[2]) > 3, 0.6),
    gapS: 6,
    topText: `speed 0-${max} km/h`,
    bottomText: 'red = HDOP above 3',
    bottomColor: '#ff3b1f',
    empty: 'waiting for a GPS fix'
  });
}

function renderLiveSummary() {
  let n = 0, moving = 0, sum = 0, peak = 0;
  for (const p of LIVE_HIST.speed) {
    const v = Number(p[1]);
    if (!Number.isFinite(v)) continue;
    n++;
    if (v > peak) peak = v;
    if (v >= 1) { moving++; sum += v; }
  }
  putText('liveAvg', moving ? (sum / moving).toFixed(0) : '--');
  putText('liveStopped', n ? String(Math.round((n - moving) * 100 / n)) : '--');
  putText('livePeak', n ? peak.toFixed(0) : '--');
}

// RSSI and free heap on independent scales: signal strength explains a dropout,
// heap explains a slow leak. Both are already in every sys block.
function renderWifiChart() {
  if (!WIFI_HIST.rssi.length) return;
  const heapMax = CHARTS.niceMax(
    CHARTS.autoMax(WIFI_HIST.heap.map(p => p[1]), 200), 50);
  CHARTS.drawSeries($('wifiChart'), {
    height: 120,
    series: [
      { pts: WIFI_HIST.rssi, min: -100, max: -30, color: '#000', width: 2 },
      { pts: WIFI_HIST.heap, min: 0, max: heapMax, color: '#ff3b1f', width: 1.5 }
    ],
    gapS: 6,
    topText: 'RSSI -30 (top) to -100 dBm',
    bottomText: `heap 0-${heapMax} KB`,
    bottomColor: '#ff3b1f',
    empty: 'waiting for a frame'
  });
}

function renderWifiSummary() {
  const rssi = WIFI_HIST.rssi;
  const last = rssi.length ? Number(rssi[rssi.length - 1][1]) : null;
  putText('wifiQuality', !Number.isFinite(last) ? '--'
    : last >= -60 ? 'strong' : last >= -75 ? 'fair' : 'weak');

  const now = Date.now() / 1000;
  const recent = RX_TIMES.pts.filter(t => now - t <= 15);
  let rate = '--';
  if (recent.length > 1) {
    const span = recent[recent.length - 1] - recent[0];
    if (span > 0) rate = ((recent.length - 1) / span).toFixed(1);
  }
  putText('wifiRate', rate);

  let gap = 0, prev = null;
  for (const t of RX_TIMES.pts) {
    if (now - t > 60) { prev = null; continue; }
    if (prev !== null) gap = Math.max(gap, t - prev);
    prev = t;
  }
  putText('wifiGap', gap > 0 ? gap.toFixed(1) : '--');
}

// |a| is about 1 g at rest, so the dashed reference makes a bump visible even
// when the numeric X/Y/Z columns scroll past on a phone.
function renderAccelChart() {
  const pts = MPU_HIST.accel;
  if (!pts.length) return;
  const max = CHARTS.niceMax(CHARTS.autoMax(pts.map(p => p[1]), 2), 0.5);
  CHARTS.drawSeries($('accelChart'), {
    height: 120,
    series: [{
      pts,
      min: 0,
      max,
      color: '#2447ff',
      width: 2
    }],
    refLines: [{ v: 1, color: '#777', text: '1 g' }],
    gapS: 6,
    topText: `accel 0-${max} g`,
    bottomText: 'dashed = 1 g (level)',
    empty: 'waiting for the MPU'
  });
}

function renderMpuSummary() {
  let peak = 0;
  for (const p of MPU_HIST.accel) {
    const v = Number(p[1]);
    if (Number.isFinite(v) && v > peak) peak = v;
  }
  putText('mpuPeak', peak ? peak.toFixed(2) : '--');

  let tiltPeak = 0;
  for (const v of GPS.tiltHistory) {
    const a = Math.abs(Number(v));
    if (Number.isFinite(a) && a > tiltPeak) tiltPeak = a;
  }
  putText('mpuPeakTilt', GPS.tiltHistory.length ? tiltPeak.toFixed(1) : '--');
}

// ---- MPU 3D attitude view ---------------------------------------------------
// The firmware already fuses roll/pitch/yaw; this only draws them, on a plain
// 2D canvas (see ui/mpu3d.js). Frames arrive at 1 Hz, so repainting faster than
// ~10 fps is wasted work; the view is throttled and redrawn on demand when the
// tab is opened or the window changes size.
let mpuAtt = { roll: 0, pitch: 0, yaw: 0, valid: false };
let mpuDrawnAt = 0;

function drawMpu3d(force) {
  const canvas = $('mpu3d');
  if (!canvas || typeof MPU3D === 'undefined') return;
  const now = Date.now();
  if (!force && now - mpuDrawnAt < 100) return;
  mpuDrawnAt = now;
  MPU3D.draw(canvas, mpuAtt);
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
  const ok = !!d.mpu, gps = d.gps, sys = d.sys;

  // Pills
  setPill($('pMpu'), ok ? "MPU OK" : "MPU FAIL", ok ? "ok" : "bad");
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
  mpuAtt = {
    roll: num(d.roll) ? d.roll : 0,
    pitch: num(d.pitch) ? d.pitch : 0,
    yaw: num(d.yaw) ? d.yaw : 0,
    valid: ok && num(d.roll) && num(d.pitch) && num(d.yaw)
  };
  drawMpu3d(false);

  // Update tilt history
  if (num(d.tilt)) {
    GPS.tiltHistory.push(d.tilt);
    if (GPS.tiltHistory.length > GPS.maxTiltHistory) {
      GPS.tiltHistory.shift();
    }
    drawTiltChart();
  }

  // Live chart buffers. Arrival time is used as the x axis because the GPS
  // stamp is 0 until the first fix; a gap then still looks like a gap.
  const nowS = Date.now() / 1000;
  pushSample(RX_TIMES.pts, nowS, RX_TIMES.max);
  if (gps.fix && num(gps.kmh)) {
    pushSample(LIVE_HIST.speed, [
      nowS,
      parkedNow ? 0 : Number(gps.kmh),
      num(gps.hdop) ? Number(gps.hdop) : null
    ], LIVE_HIST.max);
    renderLiveChart();
    renderLiveSummary();
  }
  if (num(sys.rssi)) {
    pushSample(WIFI_HIST.rssi, [nowS, Number(sys.rssi)], WIFI_HIST.max);
  }
  if (num(sys.heap)) {
    pushSample(WIFI_HIST.heap, [nowS, Math.round(Number(sys.heap) / 1024)],
      WIFI_HIST.max);
  }
  if (WIFI_HIST.rssi.length) renderWifiChart();
  renderWifiSummary();

  const amag = (num(d.ax) && num(d.ay) && num(d.az))
    ? Math.sqrt(d.ax * d.ax + d.ay * d.ay + d.az * d.az) : null;
  if (amag !== null) {
    pushSample(MPU_HIST.accel, [nowS, amag], MPU_HIST.max);
    putText('mpuAccel', amag.toFixed(2));
    renderAccelChart();
    renderMpuSummary();
  }

  // Motion panel values (kept for reference)
  set('vRoll', fmt(d.roll)); set('vPitch', fmt(d.pitch)); set('vYaw', fmt(d.yaw));
  set('vTilt', fmt(d.tilt) + ' deg');
  set('vAx', fmt(d.ax, 2) + ' g'); set('vAy', fmt(d.ay, 2) + ' g'); set('vAz', fmt(d.az, 2) + ' g');
  set('vWarn', d.warn + ' deg'); set('vDanger', d.danger + ' deg');
  set('tTemp', fmt(d.temp) + ' C');

  // GPS values
  set('gSat', num(gps.sats) ? gps.sats : '--');
  set('liveSats', num(gps.sats) ? gps.sats : '--');
  set('liveHdop', num(gps.hdop) ? gps.hdop.toFixed(2) : '--');
  set('gLat', gps.fix ? fmt(gps.lat, 6) : 'NO FIX');
  set('gLng', gps.fix ? fmt(gps.lng, 6) : 'NO FIX');
  set('gAlt', gps.fix && num(gps.alt) ? fmt(gps.alt) + ' m' : (gps.fix ? '--' : 'NO FIX'));
  set('gMode', gps.mode === 3 ? '3D' : gps.mode === 2 ? '2D' : '--');
  set('gTtff', num(gps.ttff_s) && gps.ttff_s > 0 ? gps.ttff_s : '--');
  set('gRej', num(gps.rej) ? gps.rej : '--');

  // Lap timing. The board counts a lap only when the segment between two fixes
  // crosses the stored gate A->B, and reports the last/best time in ms.
  const lap = d.lap || {};
  const lapS = ms => (num(ms) && ms > 0) ? (ms / 1000).toFixed(2) : '--';
  set('lapCount', num(lap.n) ? lap.n : '--');
  set('lapLast', lapS(lap.last_ms));
  set('lapBest', lapS(lap.best_ms));
  set('lapGate', lap.on ? 'armed' : 'not set (serial: a / b)');
  if (typeof MAP !== 'undefined' && MAP.setGate) {
    MAP.setGate(lap.on && Array.isArray(lap.la) && Array.isArray(lap.lb) ? lap : null);
  }


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
    d.gps && typeof d.gps === "object" &&
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
    sub.textContent = last ? "showing last known values" : "waiting for Orion to come online";
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

  // Brand state humor
  const brandState = $('brandState');
  if (brandState) {
    if (linkState !== "connected") brandState.textContent = "DREAMING";
    else if (deviceState === "offline") brandState.textContent = "WENT SLEEPING";
    else if (!live) brandState.textContent = last ? "WAITING..." : "STRETCHING";
    else brandState.textContent = "LIVE";
  }

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
  if (d.gps && d.gps.fix && !GEO.text) {
    maybeAddress(d.gps.lat, d.gps.lng);
  } else if (d.gps && !d.gps.fix && !GEO.text) {
    // No lock yet: say so instead of leaving "locating address..." up forever.
    // Only the DOM is touched - GEO.text stays empty so the first real fix
    // still triggers the lookup.
    for (const id of ['hudAddress', 'liveAddr']) {
      const el = $(id);
      if (!el) continue;
      el.textContent = 'no fix yet - the address follows the first GPS lock';
      el.classList.remove('loading');
    }
  }

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
  let histAll = [];          // every point in the loaded window
  let histSessions = [];     // SESSIONS.group(histAll)
  let histLaps = [];         // [[ts, n, dur_ms, best_ms], ...] from /history
  let histSelected = -1;     // index into histSessions, -1 = whole window
  let histMode = 'speed';    // chart view: speed | hdop | laps
  let histRequest = 0;       // token: only the newest load may touch the panel

  // Playback state. The chart always shows the current window; the transport
  // (play/scrub) is enabled only for a selected session, where the points are
  // close to 1:1 instead of a sampled whole-day view.
  let pbPoints = [];         // points the chart and playback are looking at
  let pbCoords = [];         // same, as [lng, lat] for the map overlay
  let pbIndex = 0;
  let pbPlayTs = 0;
  let pbPlaying = false;
  let pbTimer = 0;
  let pbLastTick = 0;
  let pbCanPlay = false;

  function setHistFields(points, km, gap, windowText, statusText) {
    if ($('histPoints')) $('histPoints').textContent = points;
    if ($('histDist')) $('histDist').textContent = km;
    if ($('histGap')) $('histGap').textContent = gap;
    if ($('histWindow')) $('histWindow').textContent = windowText;
    if ($('histStatus')) $('histStatus').textContent = statusText;
  }

  async function loadHistory(minutes) {
    // A slower earlier request must never overwrite a newer window: tapping
    // 1 h then 6 h could otherwise end with the 1 h response landing last.
    const req = ++histRequest;
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
      if (req !== histRequest) return;
      // Offline, blocked or the host is down: the panel says so and the live
      // data keeps rendering. Deliberately not console.error().
      if (typeof MAP !== 'undefined' && MAP.clearHistory) MAP.clearHistory();
      setPlaybackData([], false);
      setHistFields('--', '--', '--', '--', 'history host unreachable (' + err.message + ')');
      return;
    }

    if (req !== histRequest) return;

    const pts = Array.isArray(body && body.points) ? body.points : [];

    // Timeline: one row per run of fixes with no gap longer than
    // SESSIONS.DEFAULT_GAP_S. The whole window stays the default drawing, so
    // pressing 1 h / 6 h / 24 h behaves exactly as before.
    histAll = pts;
    histSessions = SESSIONS.group(pts);
    histLaps = Array.isArray(body.laps) ? body.laps : [];
    histSelected = -1;

    // Distance is the sum of the sessions, not the straight line between them:
    // joining two stints five hours apart would invent kilometres the vehicle
    // never drove (6.13 km instead of 1.59 km on the probe fixture).
    const km = SESSIONS.summarize(histSessions).distKm;

    let maxGap = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (!a || !b) continue;
      const gap = b[0] - a[0];
      if (gap > maxGap) maxGap = gap;
    }
    // The API measures the gap over raw rows, so a sampled window does not
    // report its own sample interval as an outage.
    if (typeof body.maxGap === 'number') maxGap = body.maxGap;

    // Local, matching the timeline rows and the footer clock.
    let windowText = '--';
    if (pts.length) {
      windowText = `${SESSIONS.fmtClock(pts[0][0])} - ` +
                   `${SESSIONS.fmtClock(pts[pts.length - 1][0])} local`;
    }

    renderTimeline();
    renderLaps();
    renderEvents();
    renderHistStats(pts);
    setPlaybackData(pts, false);

    const drawn = (typeof MAP !== 'undefined' && MAP.setHistory) ? MAP.setHistory(pts) : 0;
    let status = 'nothing stored in this window';
    if (pts.length) {
      status = `drawn as ${drawn} line(s)`;
      // The API samples wide windows instead of returning the first 5000
      // points, so say so: "24 h" that only covers two hours would be a lie.
      if (body.sampled) status += ` (1 of ${body.step} points, ${body.total} total)`;
      if (body.truncated) status += ', truncated at 5000';
    }

    // Quality and lean are per window, not per session: they describe what the
    // trail above is worth, and stay visible while a session is selected.
    const q = SESSIONS.quality(pts);
    if ($('histQuality')) {
      $('histQuality').textContent = q.n
        ? `hdop ${q.avg.toFixed(2)} · ${q.badPct.toFixed(0)}% poor`
        : '--';
    }
    if ($('histLean')) {
      const lean = SESSIONS.maxLean(pts);
      $('histLean').textContent = lean === null ? '--' : lean.toFixed(1);
    }
    setHistFields(
      String(body.count != null ? body.count : pts.length),
      km.toFixed(2),
      pts.length > 1 ? String(maxGap) : '--',
      windowText,
      status
    );
  }

  // A compact read on what the stored points mean: how much of the window was
  // moving, the average only while moving, and the peak. Percentages are used
  // because wide windows are sampled by the API.
  function renderHistStats(pts) {
    const s = SESSIONS.stats(pts);
    putText('histMoving', s.count ? String(s.movingPct) : '--');
    putText('histStopped', s.count ? String(100 - s.movingPct) : '--');
    putText('histAvg', s.moving ? s.avgMovingKmh.toFixed(0) : '--');
    putText('histMax', s.count ? s.maxKmh.toFixed(0) : '--');
  }

  const CHART_NOTES = {
    speed: 'speed (black), lean (red), red bands = HDOP above 3',
    hdop: 'HDOP (black), dashed = 3.0, red band = above 3',
    laps: 'bar height = seconds behind best · green = best lap'
  };

  function updateChartNote() {
    putText('chartNote', CHART_NOTES[histMode] || CHART_NOTES.speed);
  }

  // Rows are real buttons so they are keyboard-reachable; the text is set with
  // textContent, never innerHTML, because it comes from stored device data.
  function renderTimeline() {
    const list = $('histList');
    if (!list) return;
    const nowTs = Math.floor(Date.now() / 1000);
    list.textContent = '';

    if (!histSessions.length) {
      const empty = document.createElement('p');
      empty.className = 'hist-empty';
      empty.textContent = 'no stored sessions in this window';
      list.appendChild(empty);
    } else {
      let day = '';
      histSessions.forEach((s, i) => {
        const key = SESSIONS.dayKey(s.start);
        if (key !== day) {
          day = key;
          const head = document.createElement('div');
          head.className = 'hist-day';
          head.textContent = SESSIONS.fmtDay(s.start, nowTs);
          list.appendChild(head);
        }

        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'hist-session' + (i === histSelected ? ' active' : '');
        row.dataset.i = String(i);
        row.setAttribute('aria-pressed', i === histSelected ? 'true' : 'false');

        const time = document.createElement('span');
        time.className = 'hs-time';
        time.textContent = SESSIONS.fmtClock(s.start) + ' - ' + SESSIONS.fmtClock(s.end);

        const dur = document.createElement('span');
        dur.className = 'hs-dur';
        dur.textContent = SESSIONS.fmtDuration(s.seconds);

        const meta = document.createElement('span');
        meta.className = 'hs-meta';
        meta.textContent = `${s.distKm.toFixed(2)} km · ${Math.round(s.maxKmh)} km/h max · ${s.count} pts`;

        row.append(time, dur, meta);
        list.appendChild(row);
      });
    }

    const sum = $('histSummary');
    if (sum) {
      if (!histSessions.length) {
        sum.textContent = 'nothing stored in this window';
      } else {
        const t = SESSIONS.summarize(histSessions);
        sum.textContent = `${t.count} session${t.count === 1 ? '' : 's'} · ` +
          `${t.distKm.toFixed(2)} km · ${SESSIONS.fmtDuration(t.seconds)}`;
      }
    }
  }

  // One chip per lap the device logged. The counter comes from the tracker, so
  // this is "laps the board saw", not a shape guessed from the trail. Selecting
  // a session narrows the list to that stint.
  function renderLaps() {
    const box = $('histLaps');
    if (!box) return;
    box.textContent = '';

    const s = histSelected >= 0 ? histSessions[histSelected] : null;
    const list = s ? SESSIONS.lapsIn(histLaps, s.start, s.end) : histLaps;
    const t = SESSIONS.lapSummary(list);

    if (!t.count) {
      const empty = document.createElement('span');
      empty.className = 'lap-empty';
      empty.textContent = s ? 'no laps logged in this session'
                            : 'no laps logged in this window';
      box.appendChild(empty);
      return;
    }

    const head = document.createElement('span');
    head.className = 'lap-head';
    head.textContent = `${t.count} lap${t.count === 1 ? '' : 's'} · ` +
      `best ${SESSIONS.fmtLap(t.bestMs)} s · last ${SESSIONS.fmtLap(t.lastMs)} s`;
    box.appendChild(head);

    for (const l of list) {
      const dur = Number(l[2]);
      const chip = document.createElement('span');
      chip.className = 'lap-chip';

      const n = document.createElement('b');
      n.textContent = 'L' + Number(l[1]);
      const v = document.createElement('span');
      v.textContent = SESSIONS.fmtLap(dur) + ' s';
      chip.append(n, v);

      const d = SESSIONS.fmtDelta(dur - t.bestMs);
      if (d) {
        const dd = document.createElement('i');
        dd.className = dur > t.bestMs ? 'slow' : 'fast';
        dd.textContent = d;
        chip.appendChild(dd);
      }

      // The device timestamps a lap with the fix that carried the new counter,
      // so local time here matches the timeline rows.
      chip.title = new Date(Number(l[0]) * 1000).toLocaleTimeString();
      box.appendChild(chip);
    }
  }

  // Newest first, because the reason to open a log is usually "what happened
  // last". Capped so a noisy day cannot build thousands of DOM rows.
  function renderEvents() {
    const box = $('histEvents');
    if (!box) return;
    box.textContent = '';

    const s = histSelected >= 0 ? histSessions[histSelected] : null;
    const pts = s ? s.points : histAll;
    const laps = s ? SESSIONS.lapsIn(histLaps, s.start, s.end) : histLaps;
    const list = SESSIONS.events(pts, laps);
    const MAX = 200;

    if (!list.length) {
      const empty = document.createElement('span');
      empty.className = 'ev-empty';
      empty.textContent = 'no events in this window';
      box.appendChild(empty);
      return;
    }

    for (const e of list.slice().reverse().slice(0, MAX)) {
      const row = document.createElement('div');
      row.className = 'ev-row ev-' + e.kind;

      const t = document.createElement('span');
      t.className = 'ev-time';
      t.textContent = SESSIONS.fmtClock(e.ts);

      const k = document.createElement('span');
      k.className = 'ev-kind';
      k.textContent = e.kind;

      const d = document.createElement('span');
      d.className = 'ev-text';
      d.textContent = e.text;

      row.append(t, k, d);
      box.appendChild(row);
    }

    if (list.length > MAX) {
      const more = document.createElement('span');
      more.className = 'ev-empty';
      more.textContent = `+${list.length - MAX} older event(s) not shown`;
      box.appendChild(more);
    }
  }

  // ---- playback and session chart ------------------------------------------
  // Speed and lean are already columns on every stored point, so this is a
  // drawing problem, not a data one. Two independent scales share one box: the
  // labels say which line is which, and the red bands mark HDOP above 3 so a
  // spike is not mistaken for a corner.
  function drawHistChart() {
    const canvas = $('histChart');
    if (!canvas || !canvas.parentElement) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    const cw = Math.max(rect.width, 300);
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== 120) canvas.height = 120;
    const w = canvas.width, h = canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.font = '10px "Courier New", Courier, monospace';

    const pts = pbPoints;
    if (!pts.length) {
      ctx.fillStyle = '#666';
      ctx.fillText('select a range to chart', 8, h / 2);
      return;
    }

    // Lap deltas are bars, not a time series, so this view does not need the
    // x scale below. Best lap is the zero line; a green stub marks it.
    if (histMode === 'laps') {
      const s = histSelected >= 0 ? histSessions[histSelected] : null;
      const list = s ? SESSIONS.lapsIn(histLaps, s.start, s.end) : histLaps;
      const durs = list.map(l => Number(l[2])).filter(v => Number.isFinite(v) && v > 0);
      const best = durs.length ? Math.min(...durs) : 0;
      const deltas = list.map(l => Math.max(0, (Number(l[2]) - best) / 1000));
      CHARTS.drawBars(canvas, {
        height: 120,
        values: deltas,
        labels: list.map(l => 'L' + Number(l[1])),
        colors: deltas.map(v => v === 0 ? '#0a7d32' : '#000'),
        max: Math.max(1, Math.ceil(CHARTS.autoMax(deltas, 1))),
        topText: list.length
          ? `lap deltas vs best · ${list.length} lap${list.length === 1 ? '' : 's'}`
          : 'lap deltas',
        empty: s ? 'no laps in this session' : 'no laps in this window'
      });
      return;
    }

    const t0 = Number(pts[0][0]);
    const t1 = Number(pts[pts.length - 1][0]);
    const span = Math.max(1, t1 - t0);
    const x = ts => ((Number(ts) - t0) / span) * (w - 2) + 1;

    const grid = () => {
      ctx.strokeStyle = '#e2ded2';
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const y = Math.round(i * h / 4) + 0.5;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }
    };

    // Playhead, only when transport is live, so a static window is not marked
    // as if it were paused at t=0.
    const playhead = () => {
      if (!pbCanPlay || pbIndex < 0 || pbIndex >= pts.length) return;
      const px = x(pts[pbIndex][0]);
      ctx.strokeStyle = '#2447ff';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
    };

    // Poor fixes first, under everything else.
    const poorBands = () => {
      ctx.fillStyle = 'rgba(255,59,31,0.13)';
      for (let i = 1; i < pts.length; i++) {
        const hd = Number(pts[i][5]);
        if (Number.isFinite(hd) && hd > 3) {
          const xa = x(pts[i - 1][0]), xb = x(pts[i][0]);
          ctx.fillRect(xa, 0, Math.max(1, xb - xa), h);
        }
      }
    };

    if (histMode === 'hdop') {
      poorBands();
      grid();
      let maxH = 0;
      for (const p of pts) {
        const v = Number(p[5]);
        if (Number.isFinite(v) && v > maxH) maxH = v;
      }
      maxH = Math.max(5, Math.ceil(maxH / 2) * 2);

      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      for (const p of pts) {
        const v = Number(p[5]);
        if (!Number.isFinite(v)) { started = false; continue; }
        const px = x(p[0]);
        const py = h - Math.min(1, v / maxH) * (h - 4) - 2;
        if (!started) { ctx.moveTo(px, py); started = true; }
        else ctx.lineTo(px, py);
      }
      ctx.stroke();

      // The same 3.0 threshold the overlay and the quality line use.
      const y3 = h - Math.min(1, 3 / maxH) * (h - 4) - 2;
      ctx.strokeStyle = '#ff3b1f';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(0, y3); ctx.lineTo(w, y3); ctx.stroke();
      ctx.setLineDash([]);

      playhead();
      ctx.fillStyle = '#000';
      ctx.fillText(`HDOP 0-${maxH}`, 4, 11);
      ctx.fillStyle = '#ff3b1f';
      ctx.fillText('red band / line = above 3', 4, h - 4);
      return;
    }

    // Speed and lean: two independent scales share the box.
    poorBands();
    grid();

    let maxKmh = 0, maxLean = 0, hasLean = false;
    for (const p of pts) {
      const v = Number(p[3]);
      if (Number.isFinite(v) && v > maxKmh) maxKmh = v;
      for (const k of [6, 7]) {
        const raw = p[k];
        if (raw === null || raw === undefined || raw === "") continue;
        const a = Math.abs(Number(raw));
        if (!Number.isFinite(a)) continue;
        hasLean = true;
        if (a > maxLean) maxLean = a;
      }
    }
    maxKmh = Math.max(20, Math.ceil(maxKmh / 10) * 10);
    maxLean = Math.max(15, Math.ceil(maxLean / 5) * 5);

    const polyline = (pick, max, color, width) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      let started = false;
      for (const p of pts) {
        const v = pick(p);
        if (v === null) { started = false; continue; }
        const px = x(p[0]);
        const py = h - Math.min(1, v / max) * (h - 4) - 2;
        if (!started) { ctx.moveTo(px, py); started = true; }
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    };

    polyline(p => {
      const v = Number(p[3]);
      return Number.isFinite(v) ? v : null;
    }, maxKmh, '#000', 2);

    if (hasLean) {
      ctx.globalAlpha = 0.8;
      polyline(p => {
        const a = Math.abs(Number(p[6]) || 0);
        const b = Math.abs(Number(p[7]) || 0);
        return Math.max(a, b);
      }, maxLean, '#ff3b1f', 1.5);
      ctx.globalAlpha = 1;
    }

    playhead();

    ctx.fillStyle = '#000';
    ctx.fillText(`0-${maxKmh} km/h`, 4, 11);
    ctx.fillStyle = hasLean ? '#ff3b1f' : '#666';
    ctx.fillText(hasLean ? `0-${maxLean} deg` : 'lean: no data', 4, h - 4);
  }

  // Point the chart at a range and (when allowed) arm the transport.
  function setPlaybackData(pts, canPlay) {
    pbStop();
    pbPoints = Array.isArray(pts) ? pts : [];
    pbCoords = pbPoints.map(p => [Number(p[2]), Number(p[1])]);
    pbCanPlay = !!canPlay && pbPoints.length > 1;
    pbIndex = 0;
    pbPlayTs = pbPoints.length ? Number(pbPoints[0][0]) : 0;

    for (const id of ['btnPlay', 'btnPlayReset']) {
      if ($(id)) $(id).disabled = !pbCanPlay;
    }
    if ($('pbSlider')) {
      $('pbSlider').disabled = !pbCanPlay;
      $('pbSlider').max = String(Math.max(0, pbPoints.length - 1));
      $('pbSlider').value = '0';
    }

    if (!pbCanPlay) {
      if ($('pbClock')) $('pbClock').textContent = pbPoints.length
        ? SESSIONS.fmtClock(pbPoints[0][0]) : '--:--';
      if ($('pbRead')) $('pbRead').textContent = pbPoints.length
        ? 'select a session to play' : 'no stored range';
      if (typeof MAP !== 'undefined' && MAP.clearPlayback) MAP.clearPlayback();
    } else {
      pbApply(pbPlayTs);
    }
    drawHistChart();
  }

  function pbApply(ts) {
    if (!pbPoints.length) return;
    pbIndex = SESSIONS.indexAt(pbPoints, ts);
    const p = pbPoints[pbIndex];
    pbPlayTs = Number(p[0]);

    if ($('pbSlider')) $('pbSlider').value = String(pbIndex);
    if ($('pbClock')) $('pbClock').textContent = SESSIONS.fmtClock(p[0]);
    if ($('pbRead')) {
      const kmh = Number(p[3]);
      const noLean = (p[6] === null || p[6] === undefined) &&
                     (p[7] === null || p[7] === undefined);
      const lean = Math.max(Math.abs(Number(p[6]) || 0), Math.abs(Number(p[7]) || 0));
      $('pbRead').textContent =
        (Number.isFinite(kmh) ? kmh.toFixed(0) + ' km/h' : '-- km/h') +
        ' · ' + (noLean ? '--' : lean.toFixed(1) + ' deg');
    }
    if (typeof MAP !== 'undefined' && MAP.setPlayback) {
      MAP.setPlayback(Number(p[1]), Number(p[2]), pbCoords.slice(0, pbIndex + 1));
    }
    drawHistChart();
  }

  function pbPlay() {
    if (!pbCanPlay) return;
    // Pressing play at the end restarts from the beginning rather than doing
    // nothing, which looks broken.
    if (pbIndex >= pbPoints.length - 1) pbApply(Number(pbPoints[0][0]));
    pbPlaying = true;
    pbLastTick = performance.now();
    if (!pbTimer) pbTimer = setInterval(pbTick, 80);
    if ($('btnPlay')) {
      $('btnPlay').textContent = 'Pause';
      $('btnPlay').setAttribute('aria-pressed', 'true');
    }
  }

  function pbStop() {
    pbPlaying = false;
    if (pbTimer) { clearInterval(pbTimer); pbTimer = 0; }
    if ($('btnPlay')) {
      $('btnPlay').textContent = 'Play';
      $('btnPlay').setAttribute('aria-pressed', 'false');
    }
  }

  function pbTick() {
    if (!pbPlaying || !pbCanPlay || !pbPoints.length) return;
    const now = performance.now();
    const dt = Math.min(500, now - pbLastTick) / 1000;
    pbLastTick = now;
    const speed = Number(($('pbSpeed') && $('pbSpeed').value) || 4);
    const t1 = Number(pbPoints[pbPoints.length - 1][0]);
    pbPlayTs += dt * speed;
    if (pbPlayTs >= t1) {
      pbPlayTs = t1;
      pbApply(t1);
      pbStop();
      return;
    }
    pbApply(pbPlayTs);
  }

  function pbReset() {
    pbStop();
    if (pbPoints.length) pbApply(Number(pbPoints[0][0]));
  }

  if ($('btnPlay')) {
    $('btnPlay').addEventListener('click', () => (pbPlaying ? pbStop() : pbPlay()));
  }
  if ($('btnPlayReset')) $('btnPlayReset').addEventListener('click', pbReset);
  if ($('pbSlider')) {
    $('pbSlider').addEventListener('input', () => {
      pbStop();
      const i = Number($('pbSlider').value);
      if (pbPoints[i]) pbApply(Number(pbPoints[i][0]));
    });
  }
  if ($('pbSpeed')) {
    $('pbSpeed').addEventListener('change', () => { pbLastTick = performance.now(); });
  }
  if ($('chartMode')) {
    $('chartMode').addEventListener('change', () => {
      histMode = $('chartMode').value;
      updateChartNote();
      drawHistChart();
    });
  }
  // A hidden tab must not keep a timer alive, and neither must a backgrounded
  // phone: replay is cheap but pointless when nobody is looking.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pbStop();
  });

  // ---- export --------------------------------------------------------------
  // Built from the points already in memory. Exporting must not depend on the
  // history host still being reachable seconds after the fetch that loaded it.
  function exportPoints() {
    const s = histSelected >= 0 ? histSessions[histSelected] : null;
    return s ? s.points : histAll;
  }

  function stampName(ext) {
    const pts = exportPoints();
    const first = pts.length ? pts[0][0] : Math.floor(Date.now() / 1000);
    const d = new Date(Number(first) * 1000);
    const p = n => String(n).padStart(2, '0');
    return `race-tracker-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
           `-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
  }

  function download(text, name, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoking straight away cancels the save in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function exportHistory(kind) {
    const pts = exportPoints();
    if (!pts.length) {
      if ($('histStatus')) $('histStatus').textContent = 'nothing to export in this window';
      return;
    }
    const name = stampName(kind === 'gpx' ? 'gpx' : 'csv');
    if (kind === 'gpx') {
      // The track name inside the file is the label, not the file name.
      download(SESSIONS.toGpx(pts, name.replace(/\.gpx$/, '')), name, 'application/gpx+xml');
    } else {
      download(SESSIONS.toCsv(pts), name, 'text/csv');
    }
    if ($('histStatus')) {
      $('histStatus').textContent = `exported ${pts.length} points as ${name}`;
    }
  }

  if ($('btnExportGpx')) {
    $('btnExportGpx').addEventListener('click', () => exportHistory('gpx'));
  }
  if ($('btnExportCsv')) {
    $('btnExportCsv').addEventListener('click', () => exportHistory('csv'));
  }

  // Tap a row to draw just that stint; tap it again to go back to the full
  // window. The map is only touched here, so a bad row can never blank the live
  // trail or the current view.
  function selectSession(i) {
    if (!(i >= 0 && i < histSessions.length)) return;
    histSelected = (i === histSelected) ? -1 : i;
    renderTimeline();
    renderLaps();
    renderEvents();

    const s = histSelected >= 0 ? histSessions[histSelected] : null;
    const pts = s ? s.points : histAll;
    renderHistStats(pts);
    setPlaybackData(pts, !!s);
    const drawn = (typeof MAP !== 'undefined' && MAP.setHistory) ? MAP.setHistory(pts) : 0;
    if (s && typeof MAP !== 'undefined' && MAP.fitPoints) MAP.fitPoints(pts);

    if ($('histStatus')) {
      $('histStatus').textContent = s
        ? `session ${histSelected + 1} of ${histSessions.length}, drawn as ${drawn} line(s)`
        : `whole window, drawn as ${drawn} line(s)`;
    }
  }

  // Delegated: the rows are rebuilt on every load and every selection.
  if ($('histList')) {
    $('histList').addEventListener('click', ev => {
      const row = ev.target && ev.target.closest ? ev.target.closest('.hist-session') : null;
      if (row) selectSession(Number(row.dataset.i));
    });
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
  // One panel per tab now; there is no desktop/mobile duplicate to find.
  function showTab(name) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
    // Leaving HIST stops replay: a timer running behind another tab only burns
    // battery and would resume mid-session when the tab is opened again.
    if (name !== 'history') pbStop();
    // Each tab starts at its own top. Without this, a long panel left the next
    // one scrolled halfway down (or clamped to its end), which read as the page
    // jumping around on a phone.
    if (tabPanels) tabPanels.scrollTop = 0;
    // Picking a tab is a request to see it: reopen the bottom sheet if hidden.
    if (sidePanel && sidePanel.classList.contains('collapsed')) setSnap(lastOpenSnap);
    // History is fetched on demand: opening the tab is the request.
    if (name === 'history') loadHistory(histMinutes);
    // A canvas has no width while its panel is hidden, so the charts are
    // repainted when the tab actually opens.
    if (name === 'live') {
      renderLiveChart();
      renderLiveSummary();
    }
    if (name === 'wifi') {
      renderWifiChart();
      renderWifiSummary();
    }
    // The 3D canvas has no size while its panel is hidden, so it is painted
    // when the tab is actually opened, using the last frame received.
    if (name === 'mpu') {
      drawMpu3d(true);
      drawTiltChart();
      renderAccelChart();
    }
  }
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });

  // ---- Custom tooltip for field labels --------------------------------------
  // Replaces native `title` tooltip with a brutalist-styled one that matches
  // the dashboard aesthetic. Shows on hover/focus, hides on leave/blur.
  (function initFieldTooltips() {
    const tooltip = document.createElement('div');
    tooltip.className = 'field-tooltip';
    tooltip.textContent = 'What does this mean? Tap to open INFO';
    tooltip.setAttribute('role', 'tooltip');
    document.body.appendChild(tooltip);

    let currentEl = null;
    let hideTimer = 0;

    function show(el) {
      clearTimeout(hideTimer);
      currentEl = el;
      const rect = el.getBoundingClientRect();
      tooltip.style.left = (rect.left + rect.width / 2) + 'px';
      tooltip.style.top = (rect.top - 8) + 'px';
      tooltip.classList.add('show');
    }

    function hide() {
      hideTimer = setTimeout(() => {
        tooltip.classList.remove('show');
        currentEl = null;
      }, 120);
    }

    document.addEventListener('mouseover', (e) => {
      const lbl = e.target.closest('.hud-item .lbl, .hud-label');
      if (lbl && lbl.textContent.trim()) show(lbl);
    }, true);

    document.addEventListener('mouseout', (e) => {
      const lbl = e.target.closest('.hud-item .lbl, .hud-label');
      if (lbl === currentEl) hide();
    }, true);

    // Keyboard accessibility
    document.addEventListener('focusin', (e) => {
      const lbl = e.target.closest('.hud-item .lbl, .hud-label');
      if (lbl && lbl.textContent.trim()) show(lbl);
    }, true);

    document.addEventListener('focusout', (e) => {
      const lbl = e.target.closest('.hud-item .lbl, .hud-label');
      if (lbl === currentEl) hide();
    }, true);
  })();

  // ---- Tap a field label to read what it means ----------------------------
  document.addEventListener('click', (e) => {
    const lbl = e.target.closest('.hud-item .lbl, .hud-label');
    if (!lbl || !window.INFO || !window.INFO.reveal) return;
    const text = lbl.textContent.replace(/\s+/g, ' ').trim();
    if (!text || text.length > 30) return;
    const panel = lbl.closest('.tab-panel');
    const group = panel && panel.id.indexOf('tab-') === 0 ? panel.id.slice(4) : '';
    showTab('info');
    window.INFO.reveal(text, group);
  });

  // Range buttons only. Export and playback share the .hist-btn look but must
  // not reload history: doing so would clear the selection and disable replay
  // the moment Play was pressed.
  document.querySelectorAll('.hist-btn[data-min]').forEach(btn => {
    btn.addEventListener('click', () => loadHistory(Number(btn.dataset.min) || 1440));
  });

  // ---- My-location / compass ---------------------------------------------
  const btnMyLocation = $('btnMyLocation');
  if (btnMyLocation && typeof MAP !== 'undefined') {
    btnMyLocation.title = 'Re-center on vehicle';
    btnMyLocation.addEventListener('click', (e) => {
      e.preventDefault();
      MAP.recenterNow();
    });
  }

  // ---- Camera lock (the target button on the map) -------------------------
  // Spectator default: the camera eases toward the vehicle whenever it leaves
  // the middle of the screen. Locked means "keep it in the middle", and the
  // choice is remembered per browser so a reload does not lose it. A manual pan
  // releases the lock, so the map never fights the finger.
  const btnFollow = $('btnFollow');
  function paintFollow(on) {
    if (!btnFollow) return;
    btnFollow.classList.toggle('active', !!on);
    btnFollow.setAttribute('aria-pressed', String(!!on));
    btnFollow.title = on
      ? 'Camera locked on the vehicle - tap to release'
      : 'Lock the camera on the vehicle';
  }
  if (btnFollow && typeof MAP !== 'undefined') {
    let savedFollow = false;
    try { savedFollow = localStorage.getItem('followLock') === '1'; } catch (e) { savedFollow = false; }
    MAP.onFollow((on) => {
      paintFollow(on);
      try { localStorage.setItem('followLock', on ? '1' : '0'); } catch (e) { /* quota */ }
    });
    MAP.setFollow(savedFollow);
    btnFollow.addEventListener('click', () => MAP.setFollow(!MAP.isFollowing()));
  }

  // ---- Full-screen map ----------------------------------------------------
  // One class hides the top bar and the panels; the map keeps the whole window.
  // Useful on a phone in the hand, and on a desktop when watching a long run.
  const btnFull = $('btnFull');
  function paintFull(on) {
    if (!btnFull) return;
    btnFull.classList.toggle('active', !!on);
    btnFull.setAttribute('aria-pressed', String(!!on));
    btnFull.title = on ? 'Leave full screen (Esc)' : 'Full-screen map (F)';
  }
  function setFull(on) {
    document.body.classList.toggle('map-full', !!on);
    paintFull(on);
    // The grid changed: let the browser lay out, then resize the canvas once.
    requestAnimationFrame(() => { if (typeof MAP !== 'undefined') MAP.resize(); });
  }
  if (btnFull) btnFull.addEventListener('click', () => setFull(!document.body.classList.contains('map-full')));

  // ---- Bottom sheet: drag it, tap it, or let a tab reopen it --------------
  // On a phone the panels start at 38% of the screen. The handle is a real
  // resize grip: drag it down to the tab bar to give the map the whole screen,
  // or up past the tall sheet to a full sheet that covers the map.
  // On release it snaps to the nearest of four heights; a tap folds or unfolds
  // to the last height the reader chose, and picking a tab unfolds the sheet.
  const sidePanel = $('sidePanel');
  const sheetHandle = $('sheetHandle');
  const tabPanels = $('tabPanels');
  const SNAPS = ['collapsed', 'half', 'tall', 'full'];
  const SHEET_KEY = 'sheetSnap';
  let sheetSnap = 'half';
  let lastOpenSnap = 'half';
  let collapsedPx = 0;
  let sheetTimer = 0;
  let drag = null;
  let suppressClickUntil = 0;
  let resizeRaf = 0;

  function phoneSheet() {
    return window.matchMedia('(max-width: 900px)').matches;
  }

  function resizeMapSoon() {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      if (typeof MAP !== 'undefined') MAP.resize();
    });
  }

  // The folded height is the tab bar plus the panel's padding and borders. Let
  // the browser measure it in the folded state, then put the element back in
  // the same task. `.measuring` keeps the height transition from firing while
  // the probe is on screen.
  function measureCollapsed() {
    if (!sidePanel || !phoneSheet()) return 0;
    if (getComputedStyle(sheetHandle).display === 'none') return 0;
    const hadCollapsed = sidePanel.classList.contains('collapsed');
    const inlineH = sidePanel.style.height;
    const inlineVar = sidePanel.style.getPropertyValue('--sheet-h');
    sidePanel.classList.add('measuring', 'collapsed');
    sidePanel.style.height = '';
    const h = sidePanel.getBoundingClientRect().height;
    sidePanel.classList.toggle('collapsed', hadCollapsed);
    sidePanel.style.height = inlineH;
    if (inlineVar) sidePanel.style.setProperty('--sheet-h', inlineVar);
    sidePanel.getBoundingClientRect();
    sidePanel.classList.remove('measuring');
    return h;
  }

  // Tall stops at the same 160 px map floor #map-container declares, so the
  // vehicle stays visible while the sheet is at its highest.
  // Full covers the entire layout (map hidden).
  function maxSheetHeight() {
    const layout = sidePanel.parentElement;
    const gap = parseFloat(getComputedStyle(layout).rowGap) || 0;
    return Math.max(collapsedPx + 80, layout.clientHeight - 160 - gap);
  }

  function fullSheetHeight() {
    const layout = sidePanel.parentElement;
    const gap = parseFloat(getComputedStyle(layout).rowGap) || 0;
    return layout.clientHeight - gap;
  }

  function snapHeight(snap) {
    if (snap === 'collapsed') return collapsedPx;
    if (snap === 'full') return fullSheetHeight();
    const max = maxSheetHeight();
    if (snap === 'tall') return max;
    const half = Math.max(180, window.innerHeight * 0.38);
    return Math.min(max, Math.max(collapsedPx + 40, half));
  }

  function saveSnap(snap) {
    sheetSnap = snap;
    if (snap !== 'collapsed') lastOpenSnap = snap;
    if (sheetHandle) {
      sheetHandle.setAttribute('aria-expanded', String(snap !== 'collapsed'));
      sheetHandle.classList.toggle('near-collapsed', snap === 'collapsed');
    }
    if (sidePanel) sidePanel.classList.toggle('sheet-low', snap === 'collapsed');
    try {
      // sheetCollapsed is kept for older links/bookmarks and the UI test;
      // sheetSnap remembers which of the three heights to restore.
      localStorage.setItem('sheetCollapsed', snap === 'collapsed' ? '1' : '0');
      localStorage.setItem(SHEET_KEY, snap);
    } catch (e) { /* quota */ }
  }

  function foldNow() {
    clearTimeout(sheetTimer);
    sheetTimer = 0;
    sidePanel.classList.add('collapsed');
    sidePanel.style.height = '';
    sidePanel.style.removeProperty('--sheet-h');
    saveSnap('collapsed');
    resizeMapSoon();
  }

  function openTo(snap) {
    clearTimeout(sheetTimer);
    sheetTimer = 0;
    sidePanel.classList.remove('dragging');
    const target = snapHeight(snap);
    const wasCollapsed = sidePanel.classList.contains('collapsed');
    const startH = sidePanel.getBoundingClientRect().height;
    sidePanel.style.setProperty('--sheet-h', target + 'px');
    if (wasCollapsed) {
      // `height:auto` cannot interpolate: pin the folded height in pixels,
      // unfold without a transition, then release the pin so the height
      // animates up to --sheet-h.
      sidePanel.classList.add('measuring');
      sidePanel.style.height = startH + 'px';
      sidePanel.getBoundingClientRect();
      sidePanel.classList.remove('collapsed');
      sidePanel.classList.remove('measuring');
      void sidePanel.offsetHeight;
      requestAnimationFrame(() => { sidePanel.style.height = ''; });
    } else {
      sidePanel.style.height = '';
    }
    saveSnap(snap);
    resizeMapSoon();
  }

  function collapseTo() {
    clearTimeout(sheetTimer);
    sheetTimer = 0;
    sidePanel.classList.remove('dragging');
    if (sidePanel.classList.contains('collapsed')) { foldNow(); return; }
    const target = collapsedPx || measureCollapsed();
    const startH = sidePanel.getBoundingClientRect().height;
    if (target <= 0 || Math.abs(startH - target) < 1) { foldNow(); return; }
    sidePanel.style.height = startH + 'px';
    void sidePanel.offsetHeight;
    sidePanel.style.height = target + 'px';
    saveSnap('collapsed');
    resizeMapSoon();
    // Hand the final height back to `auto` once the sheet has shrunk, so the
    // folded panel always fits its content exactly.
    sheetTimer = setTimeout(foldNow, 230);
  }

  function setSnap(snap) {
    if (!sidePanel || !sheetHandle) return;
    if (!SNAPS.includes(snap)) snap = 'half';
    if (snap === 'collapsed') collapseTo();
    else openTo(snap);
  }

  if (sidePanel && sheetHandle) {
    collapsedPx = measureCollapsed();
    let savedSnap = null;
    let savedCollapsed = false;
    try {
      savedSnap = localStorage.getItem(SHEET_KEY);
      savedCollapsed = localStorage.getItem('sheetCollapsed') === '1';
    } catch (e) { savedSnap = null; savedCollapsed = false; }
    if (!SNAPS.includes(savedSnap)) savedSnap = savedCollapsed ? 'collapsed' : 'half';
    if (phoneSheet()) setSnap(savedSnap);

    // ---- Drag ---------------------------------------------------------
    sheetHandle.addEventListener('pointerdown', (e) => {
      if (!phoneSheet() || drag) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      clearTimeout(sheetTimer);
      sheetTimer = 0;
      const rect = sidePanel.getBoundingClientRect();
      collapsedPx = measureCollapsed();
      drag = {
        id: e.pointerId,
        startY: e.clientY,
        startH: rect.height,
        lastY: e.clientY,
        lastT: e.timeStamp,
        vy: 0,
        moved: false,
        wasCollapsed: sidePanel.classList.contains('collapsed'),
        maxH: fullSheetHeight()
      };
      // Unfold now so the panels are revealed under the finger, but keep the
      // pixel height the sheet had: the content is clipped until it is dragged.
      sidePanel.classList.add('dragging');
      sidePanel.classList.remove('collapsed');
      sidePanel.classList.remove('sheet-low');
      sidePanel.style.height = rect.height + 'px';
      try { sheetHandle.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ }
      e.preventDefault();
    });

    sheetHandle.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dy = e.clientY - drag.startY;
      if (Math.abs(dy) > 6) drag.moved = true;
      const h = Math.max(collapsedPx, Math.min(drag.maxH, drag.startH - dy));
      sidePanel.style.height = h + 'px';
      const dt = e.timeStamp - drag.lastT;
      if (dt > 0) drag.vy = 0.7 * drag.vy + 0.3 * ((e.clientY - drag.lastY) / dt);
      drag.lastY = e.clientY;
      drag.lastT = e.timeStamp;
      const low = h <= collapsedPx + 18;
      sidePanel.classList.toggle('sheet-low', low);
      sheetHandle.classList.toggle('near-collapsed', low);
      if (typeof MAP !== 'undefined') resizeMapSoon();
      e.preventDefault();
    }, { passive: false });

    function endDrag(e, cancelled) {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      const d = drag;
      drag = null;
      sidePanel.classList.remove('dragging');
      try { sheetHandle.releasePointerCapture(d.id); } catch (err) { /* already released */ }
      if (cancelled) {
        setSnap(d.wasCollapsed ? 'collapsed' : sheetSnap);
        return;
      }
      if (!d.moved) {
        // A tap, not a drag: fold, or unfold to the height the reader last used.
        suppressClickUntil = performance.now() + 600;
        setSnap(d.wasCollapsed ? lastOpenSnap : 'collapsed');
        return;
      }
      const h = sidePanel.getBoundingClientRect().height;
      const points = [
        { snap: 'collapsed', at: collapsedPx },
        { snap: 'half', at: snapHeight('half') },
        { snap: 'tall', at: snapHeight('tall') },
        { snap: 'full', at: snapHeight('full') }
      ].sort((a, b) => a.at - b.at);
      let pick = null;
      // A quick flick jumps one snap in that direction even if the finger did
      // not travel the whole way; a slower drag goes to the nearest height.
      // Threshold ~0.8 px/ms (800 px/s) to avoid triggering on normal drag release.
      if (Math.abs(d.vy) > 0.8) {
        pick = d.vy < 0
          ? points.find(p => p.at > h + 24)
          : points.slice().reverse().find(p => p.at < h - 24);
      }
      if (!pick) {
        pick = points.reduce((best, p) =>
          Math.abs(p.at - h) < Math.abs(best.at - h) ? p : best, points[0]);
      }
      setSnap(pick.snap);
    }
    sheetHandle.addEventListener('pointerup', (e) => endDrag(e, false));
    sheetHandle.addEventListener('pointercancel', (e) => endDrag(e, true));
    sheetHandle.addEventListener('lostpointercapture', (e) => endDrag(e, true));

    // Pointer taps are handled in endDrag(); the click below is for a screen
    // reader or a synthetic click. The window swallows the click that follows
    // a real pointer tap so it cannot toggle twice.
    sheetHandle.addEventListener('click', () => {
      if (performance.now() < suppressClickUntil) return;
      setSnap(sidePanel.classList.contains('collapsed') ? lastOpenSnap : 'collapsed');
    });
    sheetHandle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setSnap(sidePanel.classList.contains('collapsed') ? lastOpenSnap : 'collapsed');
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const i = SNAPS.indexOf(sheetSnap);
        setSnap(SNAPS[Math.max(0, Math.min(SNAPS.length - 1,
          i + (e.key === 'ArrowDown' ? 1 : -1)))]);
      }
    });

    // Rotating the phone or opening the keyboard changes what "38dvh" and the
    // map floor mean, so re-measure and re-apply the current snap.
    window.addEventListener('resize', () => {
      if (!phoneSheet()) return;
      collapsedPx = measureCollapsed();
      if (drag) { drag.maxH = fullSheetHeight(); return; }
      if (sidePanel.classList.contains('collapsed')) {
        sidePanel.style.height = '';
        sidePanel.style.removeProperty('--sheet-h');
      } else {
        sidePanel.style.setProperty('--sheet-h', snapHeight(sheetSnap) + 'px');
      }
      resizeMapSoon();
    }, { passive: true });
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
    else if (k === 'f') { e.preventDefault(); setFull(!document.body.classList.contains('map-full')); }
    else if (k === 'escape') {
      e.preventDefault();
      if (document.body.classList.contains('map-full')) setFull(false);
      else toggleMeasure(false);
    }
  });

  setInterval(renderBanner, 500);

  // A phone fires `resize` while the URL bar slides away and on every pinch.
  // Each call used to reallocate the map canvas and repaint every tile; one per
  // burst is enough, and MAP.resize() ignores a sub-2 px change on top of that.
  let resizeTimer = 0;
  function scheduleResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (typeof MAP !== 'undefined') MAP.resize();
      drawMpu3d(true);
    }, 150);
  }
  window.addEventListener('resize', scheduleResize);
  window.addEventListener('orientationchange', scheduleResize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleResize);
}

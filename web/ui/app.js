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
  let histSelected = -1;     // index into histSessions, -1 = whole window

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

    // Timeline: one row per run of fixes with no gap longer than
    // SESSIONS.DEFAULT_GAP_S. The whole window stays the default drawing, so
    // pressing 1 h / 6 h / 24 h behaves exactly as before.
    histAll = pts;
    histSessions = SESSIONS.group(pts);
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

  // Tap a row to draw just that stint; tap it again to go back to the full
  // window. The map is only touched here, so a bad row can never blank the live
  // trail or the current view.
  function selectSession(i) {
    if (!(i >= 0 && i < histSessions.length)) return;
    histSelected = (i === histSelected) ? -1 : i;
    renderTimeline();

    const s = histSelected >= 0 ? histSessions[histSelected] : null;
    const pts = s ? s.points : histAll;
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
    // Each tab starts at its own top. Without this, a long panel left the next
    // one scrolled halfway down (or clamped to its end), which read as the page
    // jumping around on a phone.
    if (tabPanels) tabPanels.scrollTop = 0;
    // Picking a tab is a request to see it: reopen the bottom sheet if hidden.
    if (sidePanel && sidePanel.classList.contains('collapsed')) setCollapsed(false);
    // History is fetched on demand: opening the tab is the request.
    if (name === 'history') loadHistory(histMinutes);
  }
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });

  // ---- Tap a field label to read what it means ----------------------------
  // The wording lives only in ui/info-data.js, so a value and its explanation
  // cannot drift apart. Unit captions are empty labels and are skipped.
  document.querySelectorAll('.hud-item .lbl, .hud-label').forEach(el => {
    if (el.textContent.trim()) el.title = 'What does this mean?';
  });
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

  document.querySelectorAll('.hist-btn').forEach(btn => {
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

  // ---- Bottom sheet: tap or swipe the handle to hide the panels -----------
  // On a phone the panels cover 38% of the screen. The handle folds them down to
  // the tab bar, and picking a tab unfolds them again, so nothing is hidden that
  // the reader then cannot find.
  const sidePanel = $('sidePanel');
  const sheetHandle = $('sheetHandle');
  const tabPanels = $('tabPanels');
  function setCollapsed(on) {
    if (!sidePanel) return;
    sidePanel.classList.toggle('collapsed', !!on);
    if (sheetHandle) sheetHandle.setAttribute('aria-expanded', String(!on));
    try { localStorage.setItem('sheetCollapsed', on ? '1' : '0'); } catch (e) { /* quota */ }
    requestAnimationFrame(() => { if (typeof MAP !== 'undefined') MAP.resize(); });
  }
  if (sidePanel && sheetHandle) {
    let savedSheet = false;
    try { savedSheet = localStorage.getItem('sheetCollapsed') === '1'; } catch (e) { savedSheet = false; }
    setCollapsed(savedSheet);
    const isCollapsed = () => sidePanel.classList.contains('collapsed');
    const toggleSheet = () => setCollapsed(!isCollapsed());

    sheetHandle.addEventListener('click', toggleSheet);
    sheetHandle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSheet(); }
    });
    // A swipe is the natural gesture on a phone: down = hide, up = show. A tap
    // still works, so a short drag that ends where it started is not a toggle.
    let startY = null;
    sheetHandle.addEventListener('touchstart', (e) => {
      startY = e.touches && e.touches[0] ? e.touches[0].clientY : null;
    }, { passive: true });
    sheetHandle.addEventListener('touchend', (e) => {
      const t = e.changedTouches && e.changedTouches[0];
      if (startY != null && t) {
        const dy = t.clientY - startY;
        if (dy > 28) setCollapsed(true);
        else if (dy < -28) setCollapsed(false);
        else toggleSheet();
      }
      startY = null;
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
    resizeTimer = setTimeout(() => { if (typeof MAP !== 'undefined') MAP.resize(); }, 150);
  }
  window.addEventListener('resize', scheduleResize);
  window.addEventListener('orientationchange', scheduleResize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleResize);
}

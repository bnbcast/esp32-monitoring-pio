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
// live data straight away instead of the setup form.
const DEFAULT_KEY = 'ea77aca95507194b8e46';
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

// ---- Reverse Geocoding (disabled - keyless/mailless only) -----------------
// Nominatim requires a contact email in User-Agent and rate-limits to 1 req/s.
// Removed to stay keyless + mailless. The hudAddress element does not exist
// in the HTML, so this was a no-op that generated 403 errors.
async function reverseGeocode(lat, lng) {
  // Disabled. No-op to avoid Nominatim 403 / console errors.
  return;
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
let lastLiveAt = 0;
let lastPush = 0;
let linkState = "connecting";
let deviceState = "unknown";

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
  if (!g || !g.fix || typeof g.lat !== 'number' || typeof g.lng !== 'number') return;

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

  if (typeof g.chars === 'number') {
    const dtC = (now - GPS.lastCharsTs) / 1000 || 1;
    GPS.lastChars = Math.round((g.chars - (GPS.lastCharsTs ? GPS.lastCharsVal : g.chars)) / dtC);
    GPS.lastCharsVal = g.chars;
    GPS.lastCharsTs = now;
  }
  if (pt.kmh > GPS.maxSpeed) GPS.maxSpeed = pt.kmh;

  updateStatsDOM();
  updateSignalDOM();
}

// ---- DOM rendering --------------------------------------------------------
function updateStatsDOM() {
  const avgSpd = GPS.movingTime > 0 ? (GPS.totalDist / 1000) / (GPS.movingTime / 3600) : 0;
  const el = id => $(id);
  if (el('vDist')) el('vDist').textContent = GPS.totalDist.toFixed(1);
  if (el('liveDist')) el('liveDist').textContent = GPS.totalDist.toFixed(1);
  if (el('liveDistMobile')) el('liveDistMobile').textContent = GPS.totalDist.toFixed(1);
  if (el('vAvgSpd')) el('vAvgSpd').textContent = avgSpd.toFixed(1);
  if (el('vMaxSpd')) el('vMaxSpd').textContent = GPS.maxSpeed.toFixed(1);
  if (el('liveMaxSpd')) el('liveMaxSpd').textContent = GPS.maxSpeed.toFixed(1);
  if (el('liveMaxSpdMobile')) el('liveMaxSpdMobile').textContent = GPS.maxSpeed.toFixed(1);
  if (el('vMoveT')) el('vMoveT').textContent = Math.round(GPS.movingTime);
  if (el('vElevGain')) el('vElevGain').textContent = Math.round(GPS.elevGain);
  if (el('vElevLoss')) el('vElevLoss').textContent = Math.round(GPS.elevLoss);
}

function updateSignalDOM() {
  const last = GPS.trace[GPS.trace.length - 1];
  if (!last) return;
  if ($('vHdop')) $('vHdop').textContent = last.hdop != null ? last.hdop.toFixed(2) : '--';
  if ($('liveHdop')) $('liveHdop').textContent = last.hdop != null ? last.hdop.toFixed(2) : '--';
  if ($('liveHdopMobile')) $('liveHdopMobile').textContent = last.hdop != null ? last.hdop.toFixed(2) : '--';
  if ($('vSats')) $('vSats').textContent = last.sats != null ? last.sats : '--';
  if ($('liveSats')) $('liveSats').textContent = last.sats != null ? last.sats : '--';
  if ($('liveSatsMobile')) $('liveSatsMobile').textContent = last.sats != null ? last.sats : '--';
  if ($('vFix')) $('vFix').textContent = last.fix ? 'VALID' : 'INVALID';
  if ($('liveFix')) $('liveFix').textContent = last.fix ? 'VALID' : 'INVALID';
  if ($('liveFixMobile')) $('liveFixMobile').textContent = last.fix ? 'VALID' : 'INVALID';
  if ($('vChars')) $('vChars').textContent = GPS.lastChars != null ? GPS.lastChars + '/s' : '--';
}

// ---- rendering: main data -------------------------------------------------
function renderData(d) {
  warn = d.warn; danger = d.danger;
  const ok = !!d.mpu, acs = d.acs, gps = d.gps, sys = d.sys;

  // Pills
  setPill($('pMpu'), ok ? "MPU OK" : "MPU FAIL", ok ? "ok" : "bad");
  setPill($('pAcs'), acs.ok ? "ACS OK" : "ACS CHECK", acs.ok ? "ok" : "bad");
  setPill($('pGps'), gps.fix ? "GPS FIX" : (gps.chars < 10 ? "GPS NO DATA" : "GPS WAIT"),
    gps.fix ? "ok" : (gps.chars < 10 ? "bad" : "wait"));

  // Telemetry readouts (LIVE tab + map HUD)
  const set = (id, val) => { const e = $(id); if (e) e.textContent = val; };
  set('liveSpeed', fmt(gps.kmh));
  set('liveSpeedMobile', fmt(gps.kmh));
  set('liveAlt', num(gps.alt) ? fmt(gps.alt) : '--');
  set('liveAltMobile', num(gps.alt) ? fmt(gps.alt) : '--');
  set('liveFix', gps.fix ? 'VALID' : 'INVALID');
  set('liveFixMobile', gps.fix ? 'VALID' : 'INVALID');
  set('liveTilt', fmt(d.tilt) + ' deg');
  set('liveTiltMobile', fmt(d.tilt));
  set('liveAmps', acs.ok ? fmt(acs.amps, 2) : 'ERR');
  set('liveAmpsMobile', acs.ok ? fmt(acs.amps, 2) : 'ERR');
  set('hudSpeed', fmt(gps.kmh));

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
  set('vAmps', acs.ok ? fmt(acs.amps, 2) : 'ERR');
  set('vPeak', fmt(d.peakA, 2)); set('vSv', fmt(acs.v, 3)); set('vZv', fmt(acs.zero, 3));

  // GPS values
  set('gSat', num(gps.sats) ? gps.sats : '--');
  set('liveSats', num(gps.sats) ? gps.sats : '--');
  set('liveSatsMobile', num(gps.sats) ? gps.sats : '--');
  set('liveHdop', num(gps.hdop) ? gps.hdop.toFixed(2) : '--');
  set('liveHdopMobile', num(gps.hdop) ? gps.hdop.toFixed(2) : '--');
  set('gLat', fmt(gps.lat, 6)); set('gLng', fmt(gps.lng, 6));
  set('gAlt', num(gps.alt) ? fmt(gps.alt) + ' m' : '--');
  set('gSpd', num(gps.kmh) ? fmt(gps.kmh) + ' km/h' : '--');

  // Map HUD - position
  set('hudLat', fmt(gps.lat, 6)); set('hudLng', fmt(gps.lng, 6));
  set('hudAlt', num(gps.alt) ? fmt(gps.alt) + ' m' : '--');

  // Device values
  set('sUp', num(d.up) ? uptime(d.up) : '--');
  set('sUpMobile', num(d.up) ? uptime(d.up) : '--');
  set('sRssi', num(sys.rssi) ? sys.rssi + ' dBm' : '--');
  set('sRssiMobile', num(sys.rssi) ? sys.rssi + ' dBm' : '--');
  set('sHeap', num(sys.heap) ? Math.round(sys.heap / 1024) + ' KB' : '--');

  // WiFi tab values (desktop)
  set('wifiUp', num(d.up) ? uptime(d.up) : '--');
  set('wifiRssi', num(sys.rssi) ? sys.rssi + ' dBm' : '--');
  set('wifiHeap', num(sys.heap) ? Math.round(sys.heap / 1024) + ' KB' : '--');
  set('wifiLast', new Date().toLocaleTimeString());

  // WiFi connection info - sys object should have wifi data
  const wifi = sys.wifi || {};
  set('wifiSsid', wifi.ssid || '--');
  set('wifiBssid', wifi.bssid || '--');
  set('wifiChan', wifi.channel || '--');
  set('wifiStatus', wifi.status || (num(sys.rssi) ? 'Connected' : 'Disconnected'));
  set('wifiIp', wifi.ip || '--');
  set('wifiMac', wifi.mac || '--');

  // WiFi tab values (mobile)
  set('wifiUpMobile', num(d.up) ? uptime(d.up) : '--');
  set('wifiRssiMobile', num(sys.rssi) ? sys.rssi + ' dBm' : '--');
  set('wifiHeapMobile', num(sys.heap) ? Math.round(sys.heap / 1024) + ' KB' : '--');
  set('wifiLastMobile', new Date().toLocaleTimeString());
  set('wifiSsidMobile', wifi.ssid || '--');
  set('wifiBssidMobile', wifi.bssid || '--');
  set('wifiChanMobile', wifi.channel || '--');
  set('wifiStatusMobile', wifi.status || (num(sys.rssi) ? 'Connected' : 'Disconnected'));
  set('wifiIpMobile', wifi.ip || '--');
  set('wifiMacMobile', wifi.mac || '--');

  // MPU6050 tab values (mobile)
  set('tTempMobile', num(d.temp) ? fmt(d.temp) + ' C' : '--');
  set('mpuRollMobile', fmt(d.roll));
  set('mpuPitchMobile', fmt(d.pitch));
  set('mpuYawMobile', fmt(d.yaw));
  set('mpuMaxTiltMobile', fmt(d.maxTilt));
  set('mpuAxMobile', fmt(d.ax, 2));
  set('mpuAyMobile', fmt(d.ay, 2));
  set('mpuAzMobile', fmt(d.az, 2));
  set('mpuTiltMobile', fmt(d.tilt));
  set('mpuWarnMobile', d.warn);
  set('mpuDangerMobile', d.danger);

  // Danger LEDs — solid blocks
  const lvl = d.lvl;
  $('ledB').classList.toggle('on', ok && lvl === 0);
  $('ledW').classList.toggle('on', ok && lvl === 1);
  $('ledR').classList.toggle('on', ok && lvl === 2);

  // Heading badge
  const hb = $('liveHeadingBadge');
  if (hb && typeof MAP !== 'undefined' && MAP.isReady()) {
    const h = MAP.getHeading();
    const conf = Math.round(h.confidence * 100);
    hb.textContent = 'HDG: ' + h.source + ' ' + conf + '%';
    hb.style.background = lvl >= 2 ? varRed() : (lvl >= 1 ? varYellow() : varGreen());
  }
}

const varRed = () => getComputedStyle(document.documentElement).getPropertyValue('--red').trim() || '#ff3b1f';
const varYellow = () => getComputedStyle(document.documentElement).getPropertyValue('--yellow').trim() || '#ffe600';
const varGreen = () => getComputedStyle(document.documentElement).getPropertyValue('--green').trim() || '#00e676';

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

  // Stale / no-fix handling for map marker
  if (typeof MAP !== 'undefined' && MAP.isReady()) {
    const staleFix = lastFixPos && lastFixTs > 0 && (Date.now() - lastFixTs) > 2000;
    if (staleFix && lastFixPos) {
      MAP.setVehicle(lastFixPos.lng, lastFixPos.lat, 0, 0, null, false, Date.now());
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
    sub.textContent = "tilt " + fmt(last.tilt, 0) + " deg  |  warn " + last.warn + "  danger " + last.danger;
  }

  setPill($('pLink'), linkState === "connected" ? "BROKER OK" : "BROKER ...", linkState === "connected" ? "ok" : "wait");
  if (deviceState === "offline") setPill($('pDev'), "DEVICE OFFLINE", "bad");
  else if (live) setPill($('pDev'), "DEVICE LIVE", "ok");
  else setPill($('pDev'), last ? "NO SIGNAL" : "DEVICE ...", last ? "bad" : "wait");

  if ($('lState')) $('lState').textContent = linkState.toUpperCase();
  if ($('sState')) $('sState').textContent = live ? "LIVE" : "NOT LIVE";
  if ($('sAge')) $('sAge').textContent = lastLiveAt ? Math.round(age / 1000) + " s ago" : "--";
  if ($('fTime')) $('fTime').textContent = new Date().toLocaleTimeString();

  // Heading readout
  if (typeof MAP !== 'undefined' && MAP.isReady()) {
    const h = MAP.getHeading();
    const conf = Math.round(h.confidence * 100);
    if ($('hudHeading')) $('hudHeading').textContent = Math.round(h.heading) + '\u00B0  [' + h.source + ' ' + conf + '%]';
    if ($('liveCog')) $('liveCog').textContent = Math.round(h.heading);
    if ($('liveCogMobile')) $('liveCogMobile').textContent = Math.round(h.heading);
    if (GPS.lastPoint && $('hudSource')) {
      $('hudSource').textContent = GPS.lastPoint.lat.toFixed(4) + ', ' + GPS.lastPoint.lng.toFixed(4);
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

  last = d;

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
      // Find target panel within the same container (desktop or mobile)
      const container = btn.closest('.side-panel, .mobile-sheet');
      let target = container ? container.querySelector('#tab-' + btn.dataset.tab) : null;
      if (!target) target = $('tab-' + btn.dataset.tab + '-mobile');
      if (!target) target = $('tab-' + btn.dataset.tab);
      if (target) target.classList.add('active');
    });
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

  const btnCompass = $('btnCompass');
  let compassPressTimer = null;
  let northLocked = false;
  if (btnCompass && typeof MAP !== 'undefined') {
    btnCompass.innerHTML = 'N↑';
    btnCompass.className = 'map-btn';
    btnCompass.title = 'Reset north / Lock north';
    const startPress = () => { compassPressTimer = setTimeout(() => {
      northLocked = !northLocked;
      btnCompass.innerHTML = northLocked ? 'N↓' : 'N↑';
      MAP.setLockNorth(northLocked);
    }, 600); };
    const endPress = () => { if (compassPressTimer) { clearTimeout(compassPressTimer); compassPressTimer = null; } else { MAP.resetNorth(); northLocked = false; btnCompass.innerHTML = 'N↑'; } };
    btnCompass.addEventListener('mousedown', (e) => { e.preventDefault(); startPress(); });
    btnCompass.addEventListener('touchstart', (e) => { e.preventDefault(); startPress(); }, { passive: false });
    btnCompass.addEventListener('mouseup', endPress);
    btnCompass.addEventListener('mouseleave', endPress);
    btnCompass.addEventListener('touchend', endPress);
  }

  // ---- Keyboard shortcuts -------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (k === 'c' && typeof MAP !== 'undefined') { e.preventDefault(); MAP.recenterNow(); }
    else if (k === 'n' && typeof MAP !== 'undefined') { e.preventDefault(); MAP.resetNorth(); }
  });

  setInterval(renderBanner, 500);
  window.addEventListener('resize', () => { if (typeof MAP !== 'undefined') MAP.resize(); });
}

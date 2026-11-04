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
const STALE_AFTER_MS = 6000;
const N = 120;

// ---- helpers --------------------------------------------------------------
const $ = id => document.getElementById(id);
const C = { ink: "#000", blue: "#2447ff", red: "#ff3b1f", green: "#00e676", yellow: "#ffe600" };
const fmt = (v, d = 1) => (typeof v !== "number" || Number.isNaN(v)) ? "--" : v.toFixed(d);
const setPill = (el, text, cls) => { el.textContent = text; el.className = "pill " + cls; };
const uptime = s => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
  .map(n => String(n).padStart(2, "0")).join(":");

// ---- topic key ------------------------------------------------------------
function readKey() {
  const raw = location.hash.slice(1);
  const key = raw.startsWith("t=") ? raw.slice(2) : raw;
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
  if (el('vAvgSpd')) el('vAvgSpd').textContent = avgSpd.toFixed(1);
  if (el('vMaxSpd')) el('vMaxSpd').textContent = GPS.maxSpeed.toFixed(1);
  if (el('liveMaxSpd')) el('liveMaxSpd').textContent = GPS.maxSpeed.toFixed(1);
  if (el('vMoveT')) el('vMoveT').textContent = Math.round(GPS.movingTime);
  if (el('vElevGain')) el('vElevGain').textContent = Math.round(GPS.elevGain);
  if (el('vElevLoss')) el('vElevLoss').textContent = Math.round(GPS.elevLoss);
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

  // Pills
  setPill($('pMpu'), ok ? "MPU OK" : "MPU FAIL", ok ? "ok" : "bad");
  setPill($('pAcs'), acs.ok ? "ACS OK" : "ACS CHECK", acs.ok ? "ok" : "bad");
  setPill($('pGps'), gps.fix ? "GPS FIX" : (gps.chars < 10 ? "GPS NO DATA" : "GPS WAIT"),
    gps.fix ? "ok" : (gps.chars < 10 ? "bad" : "wait"));

  // Telemetry readouts (LIVE tab + map HUD)
  const set = (id, val) => { const e = $(id); if (e) e.textContent = val; };
  set('liveSpeed', fmt(gps.kmh));
  set('liveAlt', num(gps.alt) ? fmt(gps.alt) : '--');
  set('liveFix', gps.fix ? 'VALID' : 'INVALID');
  set('liveTilt', fmt(d.tilt) + ' deg');
  set('liveAmps', acs.ok ? fmt(acs.amps, 2) : 'ERR');
  set('hudSpeed', fmt(gps.kmh));
  set('hudDanger', danger);

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
  set('gLat', fmt(gps.lat, 6)); set('gLng', fmt(gps.lng, 6));
  set('gAlt', num(gps.alt) ? fmt(gps.alt) + ' m' : '--');
  set('gSpd', num(gps.kmh) ? fmt(gps.kmh) + ' km/h' : '--');

  // Device values
  set('sUp', num(d.up) ? uptime(d.up) : '--');
  set('sRssi', num(sys.rssi) ? sys.rssi + ' dBm' : '--');
  set('sHeap', num(sys.heap) ? Math.round(sys.heap / 1024) + ' KB' : '--');

  // Danger LEDs — solid blocks
  const lvl = d.lvl;
  $('ledB').classList.toggle('on', ok && lvl === 0);
  $('ledW').classList.toggle('on', ok && lvl === 1);
  $('ledR').classList.toggle('on', ok && lvl === 2);

  // Heading badge
  const hb = $('liveHeadingBadge');
  if (hb && typeof MAP !== 'undefined') {
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
  if (typeof MAP !== 'undefined') {
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
  if ($('hudHeading') && typeof MAP !== 'undefined') {
    const h = MAP.getHeading();
    const conf = Math.round(h.confidence * 100);
    $('hudHeading').textContent = Math.round(h.heading) + '\u00B0  [' + h.source + ' ' + conf + '%]';
    $('hudSource').textContent = h.source;
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
  if (typeof MAP !== 'undefined' && d.gps && typeof d.gps.lat === 'number') {
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

  if (!retained) {
    lastLiveAt = Date.now();
    const now = Date.now();
    if (now - lastPush >= 1000) {
      lastPush = now;
      H.t.push(d.tilt); H.a.push(d.acs.ok && num(d.acs.amps) ? d.acs.amps : 0);
      if (H.t.length > N) { H.t.shift(); H.a.shift(); }
    }
  }
  renderData(d);
  renderBanner();
}

// ---- start ----------------------------------------------------------------
let KEY = readKey();
if (!KEY && DEV_MODE) {
  KEY = 'dev-test-1234';
  location.hash = 't=' + KEY;
}

const TOPIC_DATA = KEY ? TOPIC_ROOT + KEY + "/data" : "";
const TOPIC_STATUS = KEY ? TOPIC_ROOT + KEY + "/status" : "";

if (!KEY) {
  $('setup').style.display = 'block';
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
    MAP.loaded().then(() => { MAP.resize(); });
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
      const target = $('tab-' + btn.dataset.tab);
      if (target) target.classList.add('active');
    });
  });

  // ---- My-location / compass ---------------------------------------------
  const btnMyLocation = $('btnMyLocation');
  let followMode = false;
  if (btnMyLocation && typeof MAP !== 'undefined') {
    btnMyLocation.textContent = '\u25CF RECENTER';
    btnMyLocation.className = 'map-btn active';
    btnMyLocation.addEventListener('click', () => {
      followMode = !followMode;
      if (followMode) {
        btnMyLocation.textContent = '\u2197 FOLLOW';
        btnMyLocation.className = 'map-btn active';
        MAP.setFollowMode(true);
        if (vehicle.lat != null && vehicle.lng != null) {
          MAP.flyTo(vehicle.lng, vehicle.lat, 15, lockNorth ? 0 : fusedHeading, 0);
        }
      } else {
        btnMyLocation.textContent = '\u25CF RECENTER';
        btnMyLocation.className = 'map-btn';
        MAP.setFollowMode(false);
        if (vehicle.lat != null && vehicle.lng != null) {
          MAP.flyTo(vehicle.lng, vehicle.lat, 15, lockNorth ? 0 : fusedHeading, 0);
        }
      }
    });
  }

  const btnCompass = $('btnCompass');
  let compassPressTimer = null;
  let northLocked = false;
  if (btnCompass && typeof MAP !== 'undefined') {
    btnCompass.textContent = 'N';
    const startPress = () => { compassPressTimer = setTimeout(() => {
      northLocked = !northLocked;
      btnCompass.textContent = northLocked ? 'N \u271A' : 'N';
      MAP.setLockNorth(northLocked);
    }, 600); };
    const endPress = () => { if (compassPressTimer) { clearTimeout(compassPressTimer); compassPressTimer = null; } else { MAP.resetNorth(); northLocked = false; btnCompass.textContent = 'N'; } };
    btnCompass.addEventListener('mousedown', startPress);
    btnCompass.addEventListener('touchstart', (e) => { e.preventDefault(); startPress(); }, { passive: false });
    btnCompass.addEventListener('mouseup', endPress);
    btnCompass.addEventListener('mouseleave', endPress);
    btnCompass.addEventListener('touchend', endPress);
  }

  // ---- Heading source -----------------------------------------------------
  const btnHeadingSrc = $('btnHeadingSrc');
  const headingSrcLabels = { auto: 'HDG: AUTO', gps: 'HDG: GPS', phone: 'HDG: PHONE', mag: 'HDG: MAG' };
  const headingSrcOrder = ['auto', 'gps', 'phone', 'mag'];
  let headingSrcIdx = 0;
  if (btnHeadingSrc && typeof MAP !== 'undefined') {
    btnHeadingSrc.addEventListener('click', () => {
      headingSrcIdx = (headingSrcIdx + 1) % headingSrcOrder.length;
      const pref = headingSrcOrder[headingSrcIdx];
      MAP.setHeadingSource(pref);
      btnHeadingSrc.textContent = headingSrcLabels[pref];
      if (pref === 'phone' && typeof window.__requestPhoneCompass === 'function') {
        window.__requestPhoneCompass();
      }
    });
  }

  // ---- Keyboard shortcuts -------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (k === 'c' && typeof MAP !== 'undefined') { e.preventDefault(); MAP.recenterNow(); }
    else if (k === 'n' && typeof MAP !== 'undefined') { e.preventDefault(); MAP.resetNorth(); }
    else if (k === 'h' && typeof MAP !== 'undefined') { e.preventDefault(); if (btnHeadingSrc) btnHeadingSrc.click(); }
  });

  setInterval(renderBanner, 500);
  window.addEventListener('resize', () => { if (typeof MAP !== 'undefined') MAP.resize(); });
}

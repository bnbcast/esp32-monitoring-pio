"use strict";

// ---- settings -------------------------------------------------------------
const DEV_MODE = /(?:^|[?&])dev(?:&|$|#)/.test(location.search) || location.hostname === 'localhost';
if (DEV_MODE) document.body.classList.add('dev-mode');
const BROKER_URL = DEV_MODE ? 'ws://localhost:5003/mqtt' : 'wss://broker.hivemq.com:8884/mqtt';
const TOPIC_ROOT = "esp32-dash/";
const STALE_AFTER_MS = 6000;
const N = 120;

// ---- helpers --------------------------------------------------------------
const $ = id => document.getElementById(id);
const C = { ink: "#000", blue: "#2447ff", red: "#ff3b1f" };
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
  origin: null,           // {lat, lng} first valid fix
  trace: [],              // {x,y,z,lat,lng,alt,kmh,cog,hdop,distSegment,ts}
  maxPoints: 1500,
  totalDist: 0,           // from device (authoritative)
  elevGain: 0,
  elevLoss: 0,
  movingTime: 0,
  stoppedTime: 0,
  maxSpeed: 0,
  lastPoint: null,        // previous accepted point
  lastValidTs: 0,
  lastChars: 0,
  lastCharsTs: 0,
  lastCharsVal: 0
};
let warn = 30, danger = 50;
let last = null;
let lastFixPos = null;  // {lng, lat} last valid GPS fix
let lastFixTs = 0;      // timestamp of last valid fix

// Three.js scene
let scene3d, camera3d, renderer3d, line3d, marker3d;
let gpsPoints3d = [];
let replayIdx = 0;
let isReplaying = false;
let lastLiveAt = 0;
let lastPush = 0;
let linkState = "connecting";
let deviceState = "unknown";

// ---- GPS math helpers ----
function projectGPS(lat, lng, alt) {
  if (!GPS.origin) return { x: 0, y: alt, z: 0 };
  const cosLat = Math.cos(GPS.origin.lat * Math.PI / 180);
  return {
    x: (lng - GPS.origin.lng) * 111320 * cosLat,
    y: alt,
    z: (lat - GPS.origin.lat) * 110540
  };
}

function haversineM(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
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

// ---- canvas drawing -------------------------------------------------------
function fit(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = parseInt(c.getAttribute("height"), 10);
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const x = c.getContext("2d");
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { x, w, h };
}

function chart(c, arr, min, max, marks, color) {
  const { x, w, h } = fit(c);
  x.fillStyle = "#fff"; x.fillRect(0, 0, w, h);
  const Y = v => h - 4 - (Math.max(min, Math.min(max, v)) - min) / (max - min) * (h - 8);
  x.lineWidth = 2; x.strokeStyle = C.ink; x.setLineDash([6, 5]);
  marks.forEach(m => { x.beginPath(); x.moveTo(0, Y(m)); x.lineTo(w, Y(m)); x.stroke(); });
  x.setLineDash([]);
  if (arr.length > 1) {
    x.lineWidth = 4; x.strokeStyle = color; x.lineJoin = "miter"; x.beginPath();
    arr.forEach((v, i) => {
      const px = w - (arr.length - 1 - i) / (N - 1) * w;
      if (i) x.lineTo(px, Y(v)); else x.moveTo(px, Y(v));
    });
    x.stroke();
  }
  x.fillStyle = C.ink; x.font = "bold 12px monospace";
  x.fillText(max.toFixed(1), 6, 14); x.fillText(min.toFixed(1), 6, h - 6);
}

function drawLevel(roll, pitch, ok) {
  const c = $("cLevel"), { x, w, h } = fit(c);
  const cx = w / 2, cy = h / 2, half = Math.min(w, h) / 2 - 8, R = 60;
  x.fillStyle = "#fff"; x.fillRect(0, 0, w, h);
  [[danger, C.red], [warn, "#ffe600"]].forEach(([deg, col]) => {
    const s = deg / R * half;
    x.fillStyle = col; x.fillRect(cx - s, cy - s, s * 2, s * 2);
    x.lineWidth = 3; x.strokeStyle = C.ink; x.strokeRect(cx - s, cy - s, s * 2, s * 2);
  });
  const sw = warn / R * half;
  x.fillStyle = "#fff"; x.fillRect(cx - sw + 3, cy - sw + 3, sw * 2 - 6, sw * 2 - 6);
  x.lineWidth = 2; x.beginPath();
  x.moveTo(cx, cy - half); x.lineTo(cx, cy + half); x.moveTo(cx - half, cy); x.lineTo(cx + half, cy); x.stroke();
  if (ok) {
    const px = cx + Math.max(-R, Math.min(R, roll)) / R * half;
    const py = cy - Math.max(-R, Math.min(R, pitch)) / R * half;
    x.fillStyle = C.ink; x.fillRect(px - 9, py - 9, 18, 18);
    x.fillStyle = "#fff"; x.fillRect(px - 3, py - 3, 6, 6);
  }
}

// ---- GPS ingestion --------------------------------------------------------
function ingestGPS(g) {
  if (!isRecording || isReplaying) return;
  if (!g || !g.fix || typeof g.lat !== 'number' || typeof g.lng !== 'number') return;

  const now = Date.now();
  const pt = projectGPS(g.lat, g.lng, typeof g.alt === 'number' ? g.alt : 0);
  pt.lat = g.lat; pt.lng = g.lng; pt.alt = typeof g.alt === 'number' ? g.alt : 0;
  pt.kmh = typeof g.kmh === 'number' ? g.kmh : 0;
  pt.cog = typeof g.cog === 'number' ? g.cog : 0;
  pt.hdop = typeof g.hdop === 'number' ? g.hdop : null;
  pt.ts = now;

  // Jitter filter vs last accepted point
  if (GPS.lastPoint) {
    const d = haversineM(GPS.lastPoint.lat, GPS.lastPoint.lng, g.lat, g.lng);
    if (d < 2.0) return; // ignore sub-2m drift
    pt.distSegment = d;
  } else {
    pt.distSegment = 0;
    GPS.origin = { lat: g.lat, lng: g.lng };
    // re-project origin to (0,0,0)
    const o = projectGPS(g.lat, g.lng, pt.alt);
    pt.x = 0; pt.z = 0;
  }

  // Update totals from device (authoritative)
  if (typeof g.dist_m === 'number') GPS.totalDist = g.dist_m;

  // Elevation gain/loss from local y (altitude)
  if (GPS.lastPoint) {
    const dy = pt.alt - GPS.lastPoint.alt;
    if (dy > 0) GPS.elevGain += dy; else GPS.elevLoss -= dy;
  }

  // Moving time estimate: count seconds where speed > 1 km/h
  if (GPS.lastPoint) {
    const dt = (now - GPS.lastValidTs) / 1000;
    if (pt.kmh > 1) GPS.movingTime += dt; else GPS.stoppedTime += dt;
  }
  GPS.lastValidTs = now;

  GPS.lastPoint = { lat: g.lat, lng: g.lng, alt: pt.alt, ts: now };
  GPS.trace.push(pt);
  if (GPS.trace.length > GPS.maxPoints) GPS.trace.shift();

  // Chars/sec for data integrity
  if (typeof g.chars === 'number') {
    const dtC = (now - GPS.lastCharsTs) / 1000 || 1;
    GPS.lastChars = Math.round((g.chars - (GPS.lastCharsTs ? GPS.lastCharsVal : g.chars)) / dtC);
    GPS.lastCharsVal = g.chars;
    GPS.lastCharsTs = now;
  }

  // Max speed
  if (pt.kmh > GPS.maxSpeed) GPS.maxSpeed = pt.kmh;

  update3DTrace();
  drawElevation();
  updateStatsDOM();
  updateSignalDOM();
  updateCompass();

  $('tGps3d').textContent = `FIX • ${GPS.trace.length} pts`;
}

function update3DTrace() {
  if (!scene3d) return;

  gpsPoints3d = GPS.trace.map(p => new THREE.Vector3(p.x, p.y, p.z));
  const pos = new Float32Array(gpsPoints3d.flatMap(p => [p.x, p.y, p.z]));
  line3d.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  line3d.geometry.computeBoundingSphere();

  // Color by HDOP: green -> yellow -> red
  const last = GPS.trace[GPS.trace.length - 1];
  let h = 120; // green
  if (last.hdop != null) {
    if (last.hdop > 3) h = 0;      // red
    else if (last.hdop > 1.5) h = 60; // yellow
  }
  line3d.material.color.setHSL(h / 360, 0.8, 0.5);

  // Update position marker cone
  if (marker3d && last) {
    marker3d.position.set(last.x, last.y, last.z);
    // Point cone along COG (approximate: rotate around Y)
    marker3d.rotation.y = (last.cog || 0) * Math.PI / 180;
  }

  // Replay head
  if (isReplaying && replayIdx < gpsPoints3d.length) {
    const rp = gpsPoints3d[replayIdx];
    // (replay visual handled in animate loop)
  }
}

function drawElevation() {
  const c = $('elevChart');
  if (!c || !GPS.trace.length) return;
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(c.clientWidth * dpr);
  c.height = Math.round(160 * dpr);
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = c.clientWidth, h = 160;

  ctx.fillStyle = '#f0f6fd'; ctx.fillRect(0, 0, w, h);

  // Accumulated distance for X axis
  let dist = 0;
  const xs = [], ys = [];
  GPS.trace.forEach((p, i) => {
    if (i > 0) dist += p.distSegment || 0;
    xs.push(dist / 1000); // km
    ys.push(p.alt);
  });

  const minX = Math.min(...xs), maxX = Math.max(...xs) || 1;
  const minY = Math.min(...ys), maxY = Math.max(...ys) || (minY + 10);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 10;

  ctx.fillStyle = '#bfdbfe';
  ctx.beginPath();
  ctx.moveTo(0, h - 10);
  xs.forEach((x, i) => {
    const px = (x - minX) / rangeX * (w - 20) + 10;
    const py = h - 10 - (ys[i] - minY) / rangeY * (h - 20);
    if (i === 0) ctx.moveTo(px, h - 10);
    ctx.lineTo(px, py);
  });
  ctx.lineTo(w - 10, h - 10);
  ctx.fill();

  ctx.strokeStyle = '#1e3a8a'; ctx.lineWidth = 2; ctx.beginPath();
  xs.forEach((x, i) => {
    const px = (x - minX) / rangeX * (w - 20) + 10;
    const py = h - 10 - (ys[i] - minY) / rangeY * (h - 20);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.stroke();

  ctx.fillStyle = '#1e3a8a'; ctx.font = 'bold 11px monospace';
  ctx.fillText('ELEV (m)', 6, 14);
  ctx.fillText(Math.round(maxY).toString(), 6, h - 8);
  $('tElev').textContent = (dist / 1000).toFixed(2) + ' km • ' + Math.round(maxY - minY) + ' m range';
}

function updateStatsDOM() {
  const avgSpd = GPS.movingTime > 0 ? (GPS.totalDist / 1000) / (GPS.movingTime / 3600) : 0;
  $('vDist').textContent = GPS.totalDist.toFixed(1);
  $('vAvgSpd').textContent = avgSpd.toFixed(1);
  $('vMaxSpd').textContent = GPS.maxSpeed.toFixed(1);
  $('vMoveT').textContent = Math.round(GPS.movingTime);
  $('vElevGain').textContent = Math.round(GPS.elevGain);
  $('vElevLoss').textContent = Math.round(GPS.elevLoss);
}

function updateSignalDOM() {
  const last = GPS.trace[GPS.trace.length - 1];
  if (!last) return;
  $('vHdop').textContent = last.hdop != null ? last.hdop.toFixed(2) : '--';
  $('vSats').textContent = last.sats != null ? last.sats : '--';
  $('vFix').textContent = last.fix ? 'VALID' : 'INVALID';
  $('vChars').textContent = GPS.lastChars != null ? GPS.lastChars + '/s' : '--';
}

function updateCompass() {
  const last = GPS.trace[GPS.trace.length - 1];
  const needle = $('compassNeedle');
  const label = $('cogLabel');
  if (needle && label) {
    const cog = last && typeof last.cog === 'number' ? last.cog : 0;
    needle.setAttribute('transform', 'rotate(' + cog + ', 100, 100)');
    label.textContent = cog.toFixed(0) + '°';
    $('tCog').textContent = cog.toFixed(0) + '°';
  }
}

// ---- Three.js 3D GPS trace ------------------------------------------------
function initGps3D() {
  const container = $('gps3d-container');
  if (!container) return;

  scene3d = new THREE.Scene();
  scene3d.background = new THREE.Color(0xeef3f8);

  camera3d = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.1, 2000);
  camera3d.position.set(0, 60, 120);

  renderer3d = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer3d.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer3d.domElement);

  // Blueprint grid on ground plane
  const grid = new THREE.GridHelper(400, 40, 0xbfdbfe, 0x9dc3e6);
  scene3d.add(grid);

  // Ambient light
  scene3d.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(50, 100, 50);
scene3d.add(dirLight);

  // Trace line
  const material = new THREE.LineBasicMaterial({ color: 0x1e3a8a });
  const geometry = new THREE.BufferGeometry();
  line3d = new THREE.Line(geometry, material);
  scene3d.add(line3d);

  // Position marker (cone)
  const coneGeo = new THREE.ConeGeometry(4, 12, 8);
  coneGeo.rotateX(Math.PI / 2);
  const coneMat = new THREE.MeshBasicMaterial({ color: 0xdc2626 });
  marker3d = new THREE.Mesh(coneGeo, coneMat);
  marker3d.visible = false;
  scene3d.add(marker3d);

  window.addEventListener('resize', () => {
    if (!renderer3d) return;
    renderer3d.setSize(container.clientWidth, container.clientHeight);
    camera3d.aspect = container.clientWidth / container.clientHeight;
    camera3d.updateProjectionMatrix();
  });

  animate3d();
}

function animate3d() {
  requestAnimationFrame(animate3d);
  if (!scene3d) return;

  // Slow orbit around trace center
  const t = Date.now() * 0.001;
  const radius = 160;
  camera3d.position.x = Math.sin(t * 0.2) * radius;
  camera3d.position.z = Math.cos(t * 0.2) * radius;

  // If we have trace points, look at the latest point
  const last = GPS.trace[GPS.trace.length - 1];
  if (last) {
    camera3d.lookAt(last.x, last.y, last.z);
    if (marker3d) marker3d.visible = true;
  } else {
    camera3d.lookAt(0, 0, 0);
    if (marker3d) marker3d.visible = false;
  }

  // Replay head movement
  if (isReplaying && gpsPoints3d.length > 0) {
    replayIdx += 0.5 * replaySpeed;
    if (replayIdx >= gpsPoints3d.length) replayIdx = 0;
    const rp = gpsPoints3d[Math.floor(replayIdx)];
    if (rp) camera3d.lookAt(rp.x, rp.y, rp.z);
  }

  renderer3d.render(scene3d, camera3d);
}

// ---- controls -------------------------------------------------------------
let isRecording = true;
let replaySpeed = 1;

function toggleRecord() {
  isRecording = !isRecording;
  const btn = $('btnRecord');
  btn.textContent = isRecording ? 'RECORD' : 'PAUSE';
  btn.style.background = isRecording ? 'var(--yellow)' : 'var(--red)';
}

function toggleReplay() {
  isReplaying = !isReplaying;
  const btn = $('btnReplay');
  btn.textContent = isReplaying ? 'STOP' : 'REPLAY';
  btn.style.background = isReplaying ? 'var(--red)' : 'var(--yellow)';
  replayIdx = 0;
}

function clearTrace() {
  GPS.trace = [];
  GPS.origin = null;
  GPS.totalDist = 0;
  GPS.elevGain = 0;
  GPS.elevLoss = 0;
  GPS.movingTime = 0;
  GPS.stoppedTime = 0;
  GPS.maxSpeed = 0;
  GPS.lastPoint = null;
  gpsPoints3d = [];
  if (line3d) line3d.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
  drawElevation();
  updateStatsDOM();
  updateSignalDOM();
  updateCompass();
}

// ---- message validation ---------------------------------------------------
const num = v => typeof v === "number" && Number.isFinite(v);
function validData(d) {
  return d && typeof d === "object" &&
    num(d.tilt) && num(d.roll) && num(d.pitch) && num(d.yaw) && num(d.lvl) && d.lvl >= 0 && d.lvl <= 2 &&
    num(d.warn) && num(d.danger) &&
    d.acs && typeof d.acs === "object" && d.gps && typeof d.gps === "object" &&
    d.sys && typeof d.sys === "object";
}

// ---- rendering ------------------------------------------------------------
function renderBanner() {
  const b = $("banner"), sub = $("bannerSub");
  const age = Date.now() - lastLiveAt;
  const live = lastLiveAt > 0 && age < STALE_AFTER_MS;
  const set = (cls, text, small) => { b.className = "banner " + cls; b.firstChild.nodeValue = text; sub.textContent = small; };

  document.body.classList.toggle("stale", !live);

  // Stale / no-fix: grey out the last vehicle position and keep it faded (>2 s).
  if (typeof MAP !== 'undefined') {
    const staleFix = lastFixPos && lastFixTs > 0 && (Date.now() - lastFixTs) > 2000;
    if (staleFix && lastFixPos) {
      MAP.setVehicle(lastFixPos.lng, lastFixPos.lat, 0, 0, null, false, Date.now());
    }
  }

  if (linkState !== "connected") {
    set("lx", "CONNECTING", "opening link to broker");
  } else if (deviceState === "offline") {
    set("lx", "DEVICE OFFLINE", last ? "showing last known values" : "waiting for the ESP32 to come online");
  } else if (!live) {
    set("lx", last ? "NO SIGNAL" : "WAITING", last ? "no live data, showing last known values" : "waiting for first reading");
  } else if (!last.mpu) {
    set("lx", "NO MPU DATA", "check MPU6050 wiring");
  } else {
    set("l" + last.lvl, ["SAFE", "WARNING", "DANGER"][last.lvl],
      "tilt " + fmt(last.tilt, 0) + " deg  |  warn " + last.warn + "  danger " + last.danger);
  }

  setPill($("pLink"), linkState === "connected" ? "BROKER OK" : "BROKER ...", linkState === "connected" ? "ok" : "wait");
  if (deviceState === "offline") setPill($("pDev"), "DEVICE OFFLINE", "bad");
  else if (live) setPill($("pDev"), "DEVICE LIVE", "ok");
  else setPill($("pDev"), last ? "NO SIGNAL" : "DEVICE ...", last ? "bad" : "wait");

  $("lState").textContent = linkState.toUpperCase();
  $("sState").textContent = live ? "LIVE" : "NOT LIVE";
  $("sAge").textContent = lastLiveAt ? Math.round(age / 1000) + " s ago" : "--";
  $("fTime").textContent = new Date().toLocaleTimeString();
}

function renderData(d) {
  warn = d.warn; danger = d.danger;
  const ok = !!d.mpu, acs = d.acs, gps = d.gps, sys = d.sys;

  setPill($("pMpu"), ok ? "MPU OK" : "MPU FAIL", ok ? "ok" : "bad");
  setPill($("pAcs"), acs.ok ? "ACS OK" : "ACS CHECK", acs.ok ? "ok" : "bad");
  setPill($("pGps"), gps.fix ? "GPS FIX" : (gps.chars < 10 ? "GPS NO DATA" : "GPS WAIT"),
    gps.fix ? "ok" : (gps.chars < 10 ? "bad" : "wait"));

  $("vRoll").textContent = fmt(d.roll); $("vPitch").textContent = fmt(d.pitch); $("vYaw").textContent = fmt(d.yaw);
  $("vMax").textContent = fmt(d.maxTilt, 0); $("vTilt").textContent = fmt(d.tilt) + " deg";
  $("vAx").textContent = fmt(d.ax, 2) + " g"; $("vAy").textContent = fmt(d.ay, 2) + " g"; $("vAz").textContent = fmt(d.az, 2) + " g";
  $("vWarn").textContent = d.warn + " deg"; $("vDanger").textContent = d.danger + " deg";
  $("tTemp").textContent = fmt(d.temp) + " C";
  $("ledB").classList.toggle("on", ok && d.lvl === 0);
  $("ledW").classList.toggle("on", ok && d.lvl === 1);
  $("ledR").classList.toggle("on", ok && d.lvl === 2);
  drawLevel(d.roll, d.pitch, ok);

  $("vAmps").textContent = acs.ok ? fmt(acs.amps, 2) : "ERR";
  $("vPeak").textContent = fmt(d.peakA, 2); $("vSv").textContent = fmt(acs.v, 3); $("vZv").textContent = fmt(acs.zero, 3);
  $("tCur").textContent = acs.ok ? "OK" : "CHECK WIRING";

  $("tFix").textContent = gps.fix ? "FIX OK" : "NO FIX";
  $("gSat").textContent = num(gps.sats) ? gps.sats : "--";
  $("gLat").textContent = fmt(gps.lat, 6); $("gLng").textContent = fmt(gps.lng, 6);
  $("gAlt").textContent = num(gps.alt) ? fmt(gps.alt) + " m" : "--";
  $("gSpd").textContent = num(gps.kmh) ? fmt(gps.kmh) + " km/h" : "--";
  const m = $("gMap");
  if (gps.fix && num(gps.lat) && num(gps.lng)) {
    m.href = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(gps.lat + "," + gps.lng);
    m.hidden = false;
  } else m.hidden = true;

  $("sUp").textContent = num(d.up) ? uptime(d.up) : "--";
  $("sRssi").textContent = num(sys.rssi) ? sys.rssi + " dBm" : "--";
  $("sHeap").textContent = num(sys.heap) ? Math.round(sys.heap / 1024) + " KB" : "--";

  redrawCharts();
}

function redrawCharts() {
  chart($("cTilt"), H.t, 0, 90, [warn, danger], C.blue);
  const span = Math.max(0.5, ...H.a.map(Math.abs)) * 1.2;
  chart($("cAmps"), H.a, -span, span, [0], C.red);
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

  // Feed live GPS into the map (no-op until the MapLibre view is opened)
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
  }

  // GPS ingestion (independent of retained flag)
  if (d.gps && typeof d.gps === 'object') {
    ingestGPS(d.gps);
  }

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

// In dev mode, auto-generate a topic key if none provided
if (!KEY && DEV_MODE) {
  KEY = 'dev-test-1234';
  location.hash = 't=' + KEY;
}

const TOPIC_DATA = KEY ? TOPIC_ROOT + KEY + "/data" : "";
const TOPIC_STATUS = KEY ? TOPIC_ROOT + KEY + "/status" : "";

if (!KEY) {
  $("setup").style.display = "block";
  $("grid").style.display = "none";
  $("banner").style.display = "none";
  $("keyForm").addEventListener("submit", e => {
    e.preventDefault();
    const v = $("keyInput").value.trim();
    if (/^[A-Za-z0-9_-]{8,64}$/.test(v)) { location.hash = "t=" + v; location.reload(); }
    else $("keyInput").setCustomValidity("Use 8-64 letters, digits, - or _");
  });
  $("keyInput").addEventListener("input", () => $("keyInput").setCustomValidity(""));
} else {
  $("lKey").textContent = KEY.slice(0, 4) + "..." + KEY.slice(-2);
  renderBanner();
  const client = new MiniMqtt({
    url: BROKER_URL,
    topics: [TOPIC_DATA, TOPIC_STATUS],
    onMessage,
    onState: s => { linkState = s; if (s !== "connected") deviceState = "unknown"; renderBanner(); }
  });
  client.start();
  initGps3D();

  // ---- Blueprint / Map view toggle (Stage 1) -------------------------------
  let mapView = 'blueprint'; // 'blueprint' | 'map'
  let mapReady = false;

  function showView(view) {
    mapView = view;
    const three = $('gps3d-container');
    const map = $('map-container');
    const bBtn = $('btnViewBlueprint');
    const mBtn = $('btnViewMap');
    if (!three || !map) return;
    if (view === 'map') {
      three.style.display = 'none';
      map.style.display = '';
      if (bBtn) bBtn.classList.remove('active');
      if (mBtn) mBtn.classList.add('active');
      if (!mapReady && typeof MAP !== 'undefined') {
        MAP.create('map-container');
        MAP.loaded().then(() => { mapReady = true; MAP.resize(); });
        mapReady = true;
      } else if (mapReady) {
        MAP.resize();
        MAP.show();
      }
      MAP.set3D(is3DMode());
    } else {
      map.style.display = 'none';
      three.style.display = '';
      if (bBtn) bBtn.classList.add('active');
      if (mBtn) mBtn.classList.remove('active');
    }
  }

  // 2D / 3D
  function is3DMode() { return $('btnDim3D') && $('btnDim3D').classList.contains('active'); }
  function setDim3D(on) {
    const d2 = $('btnDim2D'), d3 = $('btnDim3D');
    if (d2) d2.classList.toggle('active', !on);
    if (d3) d3.classList.toggle('active', on);
    if (mapReady) MAP.set3D(on);
  }

  const btnViewBlueprint = $('btnViewBlueprint');
  const btnViewMap = $('btnViewMap');
  if (btnViewBlueprint) btnViewBlueprint.addEventListener('click', () => showView('blueprint'));
  if (btnViewMap) btnViewMap.addEventListener('click', () => showView('map'));
  const btnDim2D = $('btnDim2D');
  const btnDim3D = $('btnDim3D');
  if (btnDim2D) btnDim2D.addEventListener('click', () => setDim3D(false));
  if (btnDim3D) btnDim3D.addEventListener('click', () => setDim3D(true));

  // Style switcher (CartoDB: DARK = spectacle/racing, LIGHT = daytime)
  const styleLabels = { dark: 'DARK', light: 'LIGHT' };
  let curStyle = 'dark';
  const btnStyle = $('btnStyle');
  if (btnStyle && typeof MAP !== 'undefined') {
    btnStyle.addEventListener('click', () => {
      curStyle = curStyle === 'dark' ? 'light' : 'dark';
      btnStyle.textContent = 'STYLE: ' + styleLabels[curStyle];
      MAP.setStyle(curStyle);
    });
  }

  setInterval(renderBanner, 500);
  window.addEventListener("resize", () => { if (last) renderData(last); else redrawCharts(); });
  redrawCharts();
  drawLevel(0, 0, false);

  // GPS control buttons
  const btnRecord = $('btnRecord');
  const btnReplay = $('btnReplay');
  const btnClear = $('btnClear');
  if (btnRecord) btnRecord.addEventListener('click', toggleRecord);
  if (btnReplay) btnReplay.addEventListener('click', toggleReplay);
  if (btnClear) btnClear.addEventListener('click', clearTrace);

  // ---- My-location mode button (Stage 3): recenter -> follow -> compass -> north ----
  const btnMyLocation = $('btnMyLocation');
  const myLocLabels = { recenter: '● RECENTER', follow: '↗ FOLLOW', compass: '↻ COMPASS', north: '↑ NORTH' };
  if (btnMyLocation && typeof MAP !== 'undefined') {
    btnMyLocation.addEventListener('click', () => {
      const m = MAP.cycleMyLocation();
      btnMyLocation.textContent = myLocLabels[m];
      btnMyLocation.className = 'ml-btn ' + { recenter: 'ml-state-recenter', follow: 'ml-state-follow', compass: 'ml-state-compass', north: 'ml-state-north' }[m];
    });
  }

  // ---- Compass button: tap reset north, long-press lock north ----
  const btnCompass = $('btnCompass');
  let compassPressTimer = null;
  if (btnCompass && typeof MAP !== 'undefined') {
    const startPress = () => {
      compassPressTimer = setTimeout(() => {
        const locked = MAP.toggleLockNorth();
        btnCompass.textContent = locked ? 'N ✚' : 'N';
        btnCompass.classList.toggle('compass-locked', locked);
      }, 600);
    };
    const endPress = () => {
      if (compassPressTimer) { clearTimeout(compassPressTimer); compassPressTimer = null; }
      else MAP.resetNorth();
    };
    btnCompass.addEventListener('mousedown', startPress);
    btnCompass.addEventListener('touchstart', (e) => { e.preventDefault(); startPress(); }, { passive: false });
    btnCompass.addEventListener('mouseup', endPress);
    btnCompass.addEventListener('mouseleave', endPress);
    btnCompass.addEventListener('touchend', endPress);
    btnCompass.addEventListener('click', (e) => { if (!compassPressTimer) endPress(); });
  }

  // ---- Heading source selector (Stage 1) ----
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
      btnHeadingSrc.className = 'heading-src-btn ' + pref;
      if (pref === 'phone' && typeof window.__requestPhoneCompass === 'function') {
        window.__requestPhoneCompass();
      }
    });
  }

  // ---- Keyboard shortcuts: C=recenter, N=reset north, H=cycle heading source ----
  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (k === 'c' && typeof MAP !== 'undefined') { e.preventDefault(); MAP.recenterNow(); }
    else if (k === 'n' && typeof MAP !== 'undefined') { e.preventDefault(); MAP.resetNorth(); }
    else if (k === 'h' && typeof MAP !== 'undefined') { e.preventDefault();
      if (btnHeadingSrc) btnHeadingSrc.click(); }
  });

  // ---- Live heading readout in the banner/HUD area (called at end of renderBanner) ----
  function renderHeading() {
    if (typeof MAP === 'undefined') return;
    const h = MAP.getHeading();
    let el = $('hudHeading');
    if (!el) {
      el = document.createElement('div');
      el.id = 'hudHeading';
      el.style.fontFamily = 'Courier New, monospace';
      el.style.fontWeight = '700';
      el.style.fontSize = '.9rem';
      el.style.textTransform = 'uppercase';
      const banner = $('banner');
      if (banner) banner.parentNode.insertBefore(el, banner.nextSibling);
    }
    const conf = Math.round(h.confidence * 100);
    el.textContent = 'HEADING ' + Math.round(h.heading) + '°  [' + h.source + ' ' + conf + '%]';
    el.style.color = h.confidence > 0.6 ? '#06b6d4' : (h.confidence > 0.3 ? '#ffe600' : '#dc2626');
  }
  renderBanner = (function(orig) {
    return function() {
      orig.apply(this, arguments);
      renderHeading();
    };
  })(renderBanner);
}

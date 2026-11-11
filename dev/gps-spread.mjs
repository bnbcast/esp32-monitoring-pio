// Analyse a broker capture: is the GPS actually jumping, or is the map wrong?
// usage: node dev/gps-spread.mjs <capture.jsonl>
const fs = require('fs');
const file = process.argv[2];
const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const fixes = rows.map(r => r.payload).filter(p => p && p.gps && p.gps.fix);

const R = 6371000;
function dist(a, b) {
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

if (!fixes.length) {
  console.log('no fixes in capture');
  process.exit(0);
}

const pts = fixes.map(p => ({ lat: p.gps.lat, lng: p.gps.lng, hdop: p.gps.hdop, sats: p.gps.sats, t: p.ts }));
const lats = pts.map(p => p.lat).sort((a, b) => a - b);
const lngs = pts.map(p => p.lng).sort((a, b) => a - b);
const hdops = pts.map(p => p.hdop).sort((a, b) => a - b);
const sats = pts.map(p => p.sats).sort((a, b) => a - b);
const medLat = lats[Math.floor(lats.length / 2)];
const medLng = lngs[Math.floor(lngs.length / 2)];

const dists = pts.map(p => dist({ lat: medLat, lng: medLng }, p));
dists.sort((a, b) => a - b);

let worstStep = { m: 0 };
for (let i = 1; i < pts.length; i++) {
  const d = dist(pts[i - 1], pts[i]);
  if (d > worstStep.m) worstStep = { m: d, i, dt: pts[i].t - pts[i - 1].t };
}

function pct(arr, q) { return arr[Math.min(arr.length - 1, Math.floor(q * arr.length))]; }

console.log(JSON.stringify({
  frames: rows.length,
  fixes: pts.length,
  windowS: pts[pts.length - 1].t - pts[0].t,
  hdop: { min: hdops[0], median: pct(hdops, 0.5), max: hdops[hdops.length - 1] },
  sats: { min: sats[0], median: pct(sats, 0.5), max: sats[sats.length - 1] },
  spreadFromMedianM: {
    p50: Math.round(pct(dists, 0.5)),
    p90: Math.round(pct(dists, 0.9)),
    max: Math.round(dists[dists.length - 1])
  },
  worstStep: { m: Math.round(worstStep.m), seconds: worstStep.dt, kmh: Math.round((worstStep.m / Math.max(1, worstStep.dt)) * 3.6) },
  lastFive: pts.slice(-5).map(p => ({ lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6), hdop: p.hdop, sats: p.sats }))
}, null, 2));

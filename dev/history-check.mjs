#!/usr/bin/env node
/*
 * dev/history-check.mjs - summarise what the history API actually stored.
 *
 *   node dev/history-check.mjs                                  # last 60 min
 *   node dev/history-check.mjs --minutes 1440 --url https://...
 *   node dev/history-check.mjs --from 1794200000 --to 1794210000
 *
 * Prints the count, the covered window, total track length, speed range and the
 * largest time gap, so a drive capture can be judged at a glance instead of by
 * eyeballing JSON.
 */
const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const url = arg('url', 'https://race-tracker-history.pages.dev');
const now = Math.floor(Date.now() / 1000);
const from = Number(arg('from', now - Number(arg('minutes', 60)) * 60));
const to = Number(arg('to', now + 60));

const res = await fetch(`${url}/history?from=${from}&to=${to}&limit=5000`);
if (!res.ok) {
  console.error(`HTTP ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const body = await res.json();
const pts = body.points || [];

function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLng = (b[2] - a[2]) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

let dist = 0, maxGap = 0, maxGapAt = null;
for (let i = 1; i < pts.length; i++) {
  dist += haversine(pts[i - 1], pts[i]);
  const gap = pts[i][0] - pts[i - 1][0];
  if (gap > maxGap) { maxGap = gap; maxGapAt = pts[i][0]; }
}
const speeds = pts.map(p => p[3]).filter(v => typeof v === 'number');

console.log(`url        ${url}`);
console.log(`window     ${new Date(from * 1000).toISOString()} .. ${new Date(to * 1000).toISOString()}`);
console.log(`points     ${body.count}${body.sampled ? ` (sampled 1 in ${body.step}, ${body.total} total)` : ''}${body.truncated ? ' (truncated at the limit)' : ''}`);
if (pts.length) {
  console.log(`first/last ${new Date(pts[0][0] * 1000).toISOString()} .. ${new Date(pts[pts.length - 1][0] * 1000).toISOString()}`);
  console.log(`track      ${(dist / 1000).toFixed(2)} km`);
  console.log(`speed      ${speeds.length ? `${Math.min(...speeds)} .. ${Math.max(...speeds)} km/h` : 'n/a'}`);
  console.log(`max gap    ${maxGap}s${maxGapAt ? ` at ${new Date(maxGapAt * 1000).toISOString()}` : ''}`);
  const bad = pts.filter(p => p[1] < -90 || p[1] > 90 || p[2] < -180 || p[2] > 180);
  console.log(`bad coords ${bad.length}`);
} else {
  console.log('nothing stored in that window');
}

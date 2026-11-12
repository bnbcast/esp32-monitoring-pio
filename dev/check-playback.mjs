/*
 * dev/check-playback.mjs - Playwright gate for session replay and the chart.
 *
 * Serves web/ from a throwaway static server, answers /history with one fixed
 * session, then checks:
 *   - selecting a session enables the transport and paints a real chart
 *   - Play advances the scrubber and drops the marker on the map
 *   - Pause stops it; scrubbing jumps; Reset returns to the start
 *   - replay stops itself at the last point
 *   - no page error and no CSP violation
 *
 * Usage: node dev/check-playback.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(here, '..', 'web');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

const now = Math.floor(Date.now() / 1000);
const points = [];
for (let i = 0; i < 40; i++) {
  const hdop = (i >= 20 && i <= 23) ? 4.6 : 0.8;
  points.push([
    now - 120 + i * 2,
    -6.2 + i * 0.0001,
    106.8 + i * 0.00012,
    20 + (i % 7),
    90,
    hdop,
    (i % 2 ? -12.0 : 8.0),
    (i % 3 ? 3.5 : -4.0),
    42
  ]);
}
const body = {
  ok: true, device: 'esp32-01', from: now - 86400, to: now,
  count: points.length, total: points.length, step: 1, sampled: false,
  maxGap: 2, truncated: false, points, laps: []
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.join(WEB, path.normalize(file).replace(/^([/\\])+/, ''));
  if (!full.startsWith(WEB) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1250 } });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => {
  if (m.type() === 'error' && /content security policy|refused to/i.test(m.text())) {
    errors.push('csp: ' + m.text());
  }
});

await page.route('https://race-tracker-history.pages.dev/**', route => {
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body)
  });
});

await page.goto(base + '#t=race-tracker', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof MAP !== 'undefined' && MAP.isReady(),
  null, { timeout: 40000 }).catch(() => { throw new Error('map never became ready'); });

// Opening HIST already requests the default 24 h window; a second range click
// would start an overlapping fetch and make the probe race its own selection.
await page.click('.tab-btn[data-tab="history"]');
await page.waitForFunction(() => {
  const el = document.getElementById('histPoints');
  const row = document.querySelector('#histList .hist-session[data-i="0"]');
  return el && el.textContent.trim() !== '--' && row;
}, null, { timeout: 20000 }).catch(() => { throw new Error('history never loaded'); });

await page.click('#histList .hist-session[data-i="0"]');
await page.waitForTimeout(500);

const enabled = await page.$eval('#btnPlay', el => !el.disabled);
const max = await page.$eval('#pbSlider', el => Number(el.max));
const ink = await page.evaluate(() => {
  const c = document.getElementById('histChart');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
});
const startRead = (await page.textContent('#pbRead')).trim();

await page.selectOption('#pbSpeed', '30');
await page.click('#btnPlay');
await page.waitForTimeout(1100);
const playingText = (await page.textContent('#btnPlay')).trim();
await page.click('#btnPlay');            // pause before measuring the marker
await page.waitForTimeout(250);
const playingValue = await page.$eval('#pbSlider', el => Number(el.value));
const dot = await page.evaluate(() => {
  const f = MAP.getMap().getSource('playbackDot')._data.features;
  return f.length ? f[0].geometry.coordinates : null;
});
const linePts = await page.evaluate(() => {
  const f = MAP.getMap().getSource('playbackLine')._data.features;
  return f.length ? f[0].geometry.coordinates.length : 0;
});

const pausedA = playingValue;
await page.waitForTimeout(700);
const pausedB = await page.$eval('#pbSlider', el => Number(el.value));

// Evidence shot: the whole playback card, mid-session, with the marker and the
// travelled line visible. Taken before the end-scrub so the chart shows a
// playhead rather than a finished replay.
await page.$eval('#histChart', el => el.scrollIntoView({ block: 'center' }));
await page.waitForTimeout(900);   // let map tiles finish after the fit/scroll
await page.screenshot({ path: path.join(os.tmpdir(), 'playback.png') });

await page.$eval('#pbSlider', el => {
  el.value = el.max;
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(250);
const endValue = await page.$eval('#pbSlider', el => Number(el.value));
const endDot = await page.evaluate(() => {
  const f = MAP.getMap().getSource('playbackDot')._data.features;
  return f.length ? f[0].geometry.coordinates : null;
});
const endRead = (await page.textContent('#pbRead')).trim();

await page.click('#btnPlayReset');
await page.waitForTimeout(250);
const resetValue = await page.$eval('#pbSlider', el => Number(el.value));
const resetDot = await page.evaluate(() => {
  const f = MAP.getMap().getSource('playbackDot')._data.features;
  return f.length ? f[0].geometry.coordinates : null;
});

// Near the end, Play must stop itself instead of running past the last point.
await page.$eval('#pbSlider', el => {
  el.value = String(Number(el.max) - 2);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.selectOption('#pbSpeed', '30');
await page.click('#btnPlay');
await page.waitForTimeout(1200);
const autoStopValue = await page.$eval('#pbSlider', el => Number(el.value));
const autoStopText = (await page.textContent('#btnPlay')).trim();

await browser.close();
server.close();

const first = points[0], last = points[points.length - 1];
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const fails = [];
if (!enabled) fails.push('Play stayed disabled after selecting a session');
if (max !== points.length - 1) fails.push(`slider max ${max}, expected ${points.length - 1}`);
if (!(ink > 500)) fails.push(`chart looks empty: ${ink} painted pixels`);
if (playingValue < 5) fails.push(`Play did not advance the scrubber: ${playingValue}`);
if (!/pause/i.test(playingText)) fails.push(`Play button says ${JSON.stringify(playingText)} while running`);if (!dot || !near(dot[0], points[playingValue][2], 1e-6) || !near(dot[1], points[playingValue][1], 1e-6)) {
  fails.push(`marker at ${JSON.stringify(dot)} does not match point ${playingValue}`);
}
if (linePts < 3) fails.push(`travelled line has ${linePts} points`);
if (pausedA !== pausedB) fails.push(`Pause did not stop the scrubber: ${pausedA} -> ${pausedB}`);
if (endValue !== points.length - 1) fails.push(`scrub to end landed on ${endValue}`);
if (!endDot || !near(endDot[0], last[2], 1e-6) || !near(endDot[1], last[1], 1e-6)) {
  fails.push(`end marker at ${JSON.stringify(endDot)}`);
}
if (!/\d+ km\/h/.test(endRead)) fails.push(`end readout: ${JSON.stringify(endRead)}`);
if (resetValue !== 0) fails.push(`Reset landed on ${resetValue}`);
if (!resetDot || !near(resetDot[0], first[2], 1e-6) || !near(resetDot[1], first[1], 1e-6)) {
  fails.push(`reset marker at ${JSON.stringify(resetDot)}`);
}
if (autoStopValue !== points.length - 1) fails.push(`replay ran past the end: ${autoStopValue}`);
if (!/^play$/i.test(autoStopText)) fails.push(`button after auto-stop: ${JSON.stringify(autoStopText)}`);
if (errors.length) fails.push(...errors);

console.log(`enabled   ${enabled}, max index ${max}`);
console.log(`chart ink ${ink} pixels`);
console.log(`start     ${startRead}`);
console.log(`playing   index ${playingValue}, line ${linePts} pts, marker ${JSON.stringify(dot)}`);
console.log(`paused    ${pausedA} -> ${pausedB}`);
console.log(`end       index ${endValue}, read ${endRead}, marker ${JSON.stringify(endDot)}`);
console.log(`reset     index ${resetValue}, marker ${JSON.stringify(resetDot)}`);
console.log(`auto-stop index ${autoStopValue}, button ${autoStopText}`);
console.log(`shots     ${path.join(os.tmpdir(), 'playback.png')}`);

if (fails.length) {
  console.error('FAIL ' + fails.join('\nFAIL '));
  process.exit(1);
}
console.log('PASS playback');

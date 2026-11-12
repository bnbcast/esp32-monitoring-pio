/*
 * dev/check-timeline.mjs - Playwright gate for the HIST tab as a timeline.
 *
 * Serves web/ from a throwaway static server, answers /history with three
 * synthetic sessions (so the result is deterministic and needs no live data),
 * then checks:
 *   - one row per session, with a day header and a summary line
 *   - tapping a row draws only that session and frames it on the map
 *   - tapping it again returns to the whole window
 *   - no page error and no CSP violation
 * Writes two screenshots to the temp directory.
 *
 * Usage: node dev/check-timeline.mjs
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

// ---- fixture: three runs, each with a 2 s publish interval -----------------
const now = Math.floor(Date.now() / 1000);
function run(minutesAgo, n, lat, lon, kmh) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    pts.push([now - minutesAgo * 60 + i * 2, lat + i * 0.0001, lon + i * 0.00012, kmh + (i % 5)]);
  }
  return pts;
}
const points = [
  ...run(600, 40, -6.2000, 106.8000, 20),
  ...run(300, 30, -6.1900, 106.8100, 45),
  ...run(60, 25, -6.2100, 106.7900, 8)
];
const body = {
  ok: true, device: 'esp32-01', from: now - 86400, to: now,
  count: points.length, total: points.length, step: 1, sampled: false,
  maxGap: 300, truncated: false, points
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
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

await page.click('.tab-btn[data-tab="history"]');
await page.click('.hist-btn[data-min="1440"]');
await page.waitForFunction(() => {
  const el = document.getElementById('histPoints');
  return el && el.textContent.trim() !== '--';
}, null, { timeout: 20000 }).catch(() => { throw new Error('timeline never loaded'); });

const rows = await page.$$eval('#histList .hist-session', els => els.map(el => el.textContent));
const summary = (await page.textContent('#histSummary')).trim();
const status = (await page.textContent('#histStatus')).trim();
const heads = await page.$$eval('#histList .hist-day', els => els.map(el => el.textContent));

// Zoom out first, so "framed the session" is a measurable change.
await page.evaluate(() => MAP.getMap().jumpTo({ center: [106.8, -6.2], zoom: 5 }));
const before = await page.evaluate(() => {
  const m = MAP.getMap();
  return { zoom: m.getZoom(), lines: m.getSource('history')._data.features.length };
});

await page.click('#histList .hist-session[data-i="1"]');
await page.waitForTimeout(1200);
const after = await page.evaluate(() => {
  const m = MAP.getMap();
  return { zoom: m.getZoom(), lines: m.getSource('history')._data.features.length };
});
const selStatus = (await page.textContent('#histStatus')).trim();
await page.screenshot({ path: path.join(os.tmpdir(), 'timeline-desktop.png') });

await page.click('#histList .hist-session[data-i="1"]');
await page.waitForTimeout(300);
const backStatus = (await page.textContent('#histStatus')).trim();
const backLines = await page.evaluate(() =>
  MAP.getMap().getSource('history')._data.features.length);

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(os.tmpdir(), 'timeline-phone.png') });

await browser.close();
server.close();

const fails = [];
if (rows.length !== 3) fails.push(`expected 3 session rows, got ${rows.length}: ${JSON.stringify(rows)}`);
if (!/^3 sessions · /.test(summary)) fails.push(`summary: ${JSON.stringify(summary)}`);
if (!/drawn as \d+ line/.test(status)) fails.push(`status: ${JSON.stringify(status)}`);
if (heads.length < 1) fails.push('no day header rendered');
if (!/^session 2 of 3, drawn as \d+ line/.test(selStatus)) fails.push(`selection status: ${JSON.stringify(selStatus)}`);
if (!(after.zoom > before.zoom)) fails.push(`session not framed: zoom ${before.zoom} -> ${after.zoom}`);
if (!(after.lines < before.lines)) fails.push(`selection did not redraw: ${before.lines} -> ${after.lines} lines`);
if (!/^whole window, drawn as/.test(backStatus)) fails.push(`deselect status: ${JSON.stringify(backStatus)}`);
if (backLines !== before.lines) fails.push(`deselect did not restore ${before.lines} lines, got ${backLines}`);
if (errors.length) fails.push(...errors);

console.log(`rows      ${rows.length}`);
console.log(`days      ${heads.join(' | ')}`);
console.log(`summary   ${summary}`);
console.log(`status    ${status}`);
console.log(`select    ${selStatus}  (zoom ${before.zoom} -> ${after.zoom}, lines ${before.lines} -> ${after.lines})`);
console.log(`deselect  ${backStatus}  (lines ${backLines})`);
console.log(`shots     ${path.join(os.tmpdir(), 'timeline-desktop.png')}`);
console.log(`          ${path.join(os.tmpdir(), 'timeline-phone.png')}`);

if (fails.length) {
  console.error('FAIL ' + fails.join('\nFAIL '));
  process.exit(1);
}
console.log('PASS timeline');

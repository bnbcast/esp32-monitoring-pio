/*
 * dev/check-laps-export.mjs - Playwright gate for the lap log, lean/quality
 * readouts, the poor-HDOP overlay and the GPX/CSV export.
 *
 * Serves web/ from a throwaway static server and answers /history with a fixed
 * fixture (two laps, one shaky stretch), then checks:
 *   - one chip per lap, with the best/last summary
 *   - selecting a session narrows the lap list
 *   - quality and max lean are filled from the points
 *   - the red historyPoor overlay has features where HDOP > 3
 *   - Export GPX / Export CSV really download a parseable file
 *
 * Usage: node dev/check-laps-export.mjs
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
// Two sessions 348 s apart so the timeline has two rows and selection can
// narrow the lap list. hdop is poor on the four fixes in the second session,
// so the red overlay has something to draw.
function addRun(start, n) {
  for (let i = 0; i < n; i++) {
    const g = points.length;
    const hdop = (g >= 14 && g <= 17) ? 4.8 : 0.8;
    points.push([
      start + i * 2,
      -6.2 + g * 0.0001,
      106.8 + g * 0.00012,
      30 + (g % 5),
      90,
      hdop,
      (g % 2 ? -14.4 : 6.0),
      (g % 3 ? 1.5 : -2.0),
      7
    ]);
  }
}
addRun(now - 600, 12);
addRun(now - 240, 12);
const laps = [
  [points[6][0], 1, 61234, 61234],
  [points[16][0], 2, 60000, 60000]
];
const body = {
  ok: true, device: 'esp32-01', from: now - 86400, to: now,
  count: points.length, total: points.length, step: 1, sampled: false,
  maxGap: 348, truncated: false, points, laps
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
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  acceptDownloads: true
});
const page = await context.newPage();
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
}, null, { timeout: 20000 }).catch(() => { throw new Error('history never loaded'); });

const chips = await page.$$eval('#histLaps .lap-chip', els => els.map(el => el.textContent.replace(/\s+/g, ' ').trim()));
const head = (await page.textContent('#histLaps .lap-head')).trim();
const quality = (await page.textContent('#histQuality')).trim();
const lean = (await page.textContent('#histLean')).trim();
const poor = await page.evaluate(() =>
  MAP.getMap().getSource('historyPoor')._data.features.length);
const gpxName = await page.evaluate(() => document.getElementById('btnExportGpx') && true);

// ---- GPX download ----------------------------------------------------------
const [gpxDl] = await Promise.all([
  page.waitForEvent('download', { timeout: 10000 }),
  page.click('#btnExportGpx')
]);
const gpxPath = path.join(os.tmpdir(), 'probe-export.gpx');
await gpxDl.saveAs(gpxPath);
const gpx = fs.readFileSync(gpxPath, 'utf8');

// ---- CSV download ----------------------------------------------------------
const [csvDl] = await Promise.all([
  page.waitForEvent('download', { timeout: 10000 }),
  page.click('#btnExportCsv')
]);
const csvPath = path.join(os.tmpdir(), 'probe-export.csv');
await csvDl.saveAs(csvPath);
const csv = fs.readFileSync(csvPath, 'utf8');

// ---- selecting a session narrows the lap list ------------------------------
await page.click('#histList .hist-session[data-i="0"]');
await page.waitForTimeout(400);
const selChips = await page.$$eval('#histLaps .lap-chip', els => els.length);
const selStatus = (await page.textContent('#histStatus')).trim();
await page.screenshot({ path: path.join(os.tmpdir(), 'laps-export.png') });

await browser.close();
server.close();

const csvLines = csv.trim().split(/\r?\n/);
const fails = [];
if (chips.length !== 2) fails.push(`expected 2 lap chips, got ${chips.length}: ${JSON.stringify(chips)}`);
if (!/^2 laps · best 60\.00 s · last 60\.00 s$/.test(head)) fails.push(`lap head: ${JSON.stringify(head)}`);
if (!/hdop 1\.47 · 17% poor/.test(quality)) fails.push(`quality: ${JSON.stringify(quality)}`);
if (lean !== '14.4') fails.push(`max lean: ${JSON.stringify(lean)}`);
if (!(poor > 0)) fails.push(`poor-HDOP overlay has ${poor} features`);
if (!gpxName) fails.push('export GPX button missing');
if (!/<gpx version="1\.1"/.test(gpx)) fails.push('GPX is not 1.1');
if ((gpx.match(/<trkpt /g) || []).length !== points.length) {
  fails.push(`GPX has ${(gpx.match(/<trkpt /g) || []).length} trkpts, expected ${points.length}`);
}
if (!/<name>race-tracker-\d{8}-\d{4}<\/name>/.test(gpx)) fails.push('GPX track has no label');
if (csvLines[0] !== 'ts,iso,lat,lon,kmh,cog,hdop,roll,pitch') fails.push(`CSV header: ${csvLines[0]}`);
if (csvLines.length !== points.length + 1) fails.push(`CSV has ${csvLines.length - 1} rows, expected ${points.length}`);
if (selChips !== 1) fails.push(`session 1 should hold 1 lap, got ${selChips}`);
if (!/^session 1 of 2, drawn as/.test(selStatus)) fails.push(`selection status: ${JSON.stringify(selStatus)}`);
if (errors.length) fails.push(...errors);

console.log(`chips     ${chips.join(' | ')}`);
console.log(`head      ${head}`);
console.log(`quality   ${quality}`);
console.log(`mean lean ${lean} deg`);
console.log(`poor      ${poor} red line(s)`);
console.log(`gpx       ${(gpx.match(/<trkpt /g) || []).length} points, ${gpx.length} B`);
console.log(`csv       ${csvLines.length - 1} rows, ${csv.length} B`);
console.log(`select    ${selStatus} -> ${selChips} lap chip(s)`);
console.log(`shots     ${path.join(os.tmpdir(), 'laps-export.png')}`);

if (fails.length) {
  console.error('FAIL ' + fails.join('\nFAIL '));
  process.exit(1);
}
console.log('PASS laps export');

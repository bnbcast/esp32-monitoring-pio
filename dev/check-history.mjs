/*
 * dev/check-history.mjs - Playwright gate for the dashboard's HIST tab.
 *
 * Opens the page against a local static server (or any base URL), clicks the
 * HIST tab, asks for the last hour, and asserts that the stored points really
 * reached the panel and the map. Fails on any JS error or CSP violation.
 *
 * Usage:
 *   node dev/check-history.mjs                                  # http://localhost:5010/
 *   node dev/check-history.mjs https://bnbcast.github.io/esp32-monitoring-pio/ race-tracker 20
 *
 * Args: [baseUrl] [topicKey] [expectedPoints]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:5010/';
const KEY = process.argv[3] || 'race-tracker';
const EXPECT = Number(process.argv[4] || 3);
const url = BASE.includes('#') ? BASE : BASE + '#t=' + KEY;

const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/content security policy|refused to connect/i.test(t)) errors.push('csp: ' + t);
});
page.on('requestfailed', r => {
  const u = r.url();
  if (/race-tracker-history/.test(u)) errors.push('history fetch failed: ' + u);
});

function fail(msg) {
  console.error('FAIL ' + msg);
}

await page.goto(url, { waitUntil: 'domcontentloaded' });

// Wait for the map module to be ready before touching the tab bar: setHistory
// is a no-op until the style has loaded.
// MAP and LOCK are top-level `const`s in classic scripts, so they live in the
// global lexical scope rather than on `window`. Reference them by name.
await page.waitForFunction(() => typeof MAP !== 'undefined' && MAP.isReady(), null, { timeout: 30000 })
  .catch(() => { throw new Error('map never became ready'); });

await page.click('.tab-btn[data-tab="history"]');
await page.click('.hist-btn[data-min="60"]');

await page.waitForFunction(
  (n) => document.getElementById('histPoints') &&
    document.getElementById('histPoints').textContent.trim() !== '--',
  EXPECT,
  { timeout: 30000 }
).catch(() => { throw new Error('histPoints never left --'); });

const points = (await page.textContent('#histPoints')).trim();
const status = (await page.textContent('#histStatus')).trim();
const dist = (await page.textContent('#histDist')).trim();
const gap = (await page.textContent('#histGap')).trim();
const win = (await page.textContent('#histWindow')).trim();

const layer = await page.evaluate(() => {
  const map = MAP.getMap();
  const src = map && map.getSource('history');
  const data = src && src._data;
  return data ? data.features.length : -1;
});

const got = Number(points);
if (!Number.isFinite(got)) fail(`histPoints is not a number: ${JSON.stringify(points)}`);
else if (got !== EXPECT) fail(`histPoints ${got} != expected ${EXPECT}`);
if (!/drawn as \d+ line/.test(status)) fail(`status does not report drawn lines: ${JSON.stringify(status)}`);
if (layer !== 1) fail(`history source has ${layer} feature(s), expected 1 polyline`);

console.log(`points   ${points}`);
console.log(`distance ${dist} km`);
console.log(`max gap  ${gap} s`);
console.log(`window   ${win}`);
console.log(`status   ${status}`);
console.log(`features ${layer}`);
console.log(`errors   ${errors.length ? errors.join(' | ') : 'none'}`);

await browser.close();

if (errors.length) { fail(errors.join(' | ')); process.exit(1); }
if (got !== EXPECT || layer !== 1) process.exit(1);
console.log('PASS history tab');

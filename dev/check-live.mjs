/*
 * dev/check-live.mjs - Playwright gate for the deployed dashboard.
 *
 * Verifies that the page loads, the MQTT link to the broker comes up, the map
 * renders, and that no asset 404s / CSP violations / JS errors occur.
 * Works against the live GitHub Pages site, a local static server, or the dev
 * server.
 *
 * Usage:
 *   node dev/check-live.mjs                                     # live Pages site
 *   node dev/check-live.mjs http://localhost:5003/?dev&t=dev-test-1234
 *   node dev/check-live.mjs https://bnbcast.github.io/esp32-monitoring-pio/ race-tracker 20000
 *
 * Args: [baseUrl] [topicKey] [waitMs]
 * Exit code 0 = pass, 1 = a hard error (JS error, 4xx asset, CSP violation,
 * broker never connected).
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'https://bnbcast.github.io/esp32-monitoring-pio/';
const KEY = process.argv[3] || 'race-tracker';
const WAIT = Number(process.argv[4] || 15000);
const url = BASE.includes('?') ? BASE : BASE + '#t=' + KEY;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleMsgs = [], pageErrors = [], failed = [], csp = [];
page.on('console', m => {
  consoleMsgs.push(`[${m.type()}] ${m.text()}`);
  if (/Content Security Policy|Refused to/i.test(m.text())) csp.push(m.text());
});
page.on('pageerror', e => pageErrors.push(String((e && e.stack) || e)));
page.on('requestfailed', r => {
  const err = (r.failure() || {}).errorText || '';
  // Tiles still in flight when the page closes abort with ERR_ABORTED. That is
  // teardown noise, not a broken asset, and counting it made this gate cry wolf.
  if (err === 'net::ERR_ABORTED') return;
  failed.push(`${r.url()} :: ${err}`);
});
page.on('response', r => { if (r.status() >= 400) failed.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(WAIT);

const state = await page.evaluate(() => {
  const txt = id => { const e = document.getElementById(id); return e ? e.textContent.trim() : null; };
  const pill = id => { const e = document.getElementById(id); return e ? e.className : null; };
  const canvas = document.querySelector('#map-container canvas');
  return {
    hash: location.hash,
    setupVisible: !!(document.getElementById('setup') && getComputedStyle(document.getElementById('setup')).display !== 'none'),
    simBadge: !!(document.getElementById('sim-badge') && getComputedStyle(document.getElementById('sim-badge')).display !== 'none'),
    link: txt('pLink'), linkCls: pill('pLink'),
    device: txt('pDev'), status: txt('statusText'), statusSub: txt('statusSub'),
    mpu: txt('pMpu'), gps: txt('pGps'), acs: txt('pAcs'),
    speed: txt('liveSpeed'), sats: txt('liveSats'), hdop: txt('liveHdop'), fix: txt('liveFix'),
    lat: txt('gLat'), dist: txt('liveDist'), uptime: txt('sUp'),
    hudHeading: txt('hudHeading'), hudSource: txt('hudSource'),
    mapCanvas: canvas ? canvas.width + 'x' + canvas.height : null,
    mapReady: typeof MAP !== 'undefined' && MAP.isReady ? MAP.isReady() : 'no MAP',
    docScrolls: document.documentElement.scrollHeight > window.innerHeight + 2
  };
});

const report = {
  state,
  pageErrors,
  failedRequests: [...new Set(failed)],
  cspViolations: csp,
  consoleErrors: consoleMsgs.filter(m => m.startsWith('[error]'))
};
console.log(JSON.stringify(report, null, 2));

const hardFail =
  pageErrors.length > 0 ||
  report.failedRequests.length > 0 ||
  csp.length > 0 ||
  !state.link || !state.link.startsWith('BROKER OK') ||
  !state.mapCanvas ||
  state.setupVisible;

await browser.close();
console.log(hardFail ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(hardFail ? 1 : 0);

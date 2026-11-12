/*
 * dev/check-live-charts.mjs - browser gate for the LIVE/WIFI/MPU charts.
 *
 * Starts the simulator (dev/server.js) on its fixed local port, opens the
 * dashboard in dev mode, and checks that each new history buffer is fed and
 * painted:
 *   - LIVE  : speed chart + moving/stopped/peak numbers
 *   - WIFI  : RSSI/heap chart + link, message rate and largest gap
 *   - MPU   : acceleration chart + current/peak |a| and peak tilt
 *
 * Usage: node dev/check-live-charts.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 5003;
const URL = `http://localhost:${PORT}/?dev&t=dev-test-1234`;

async function reachable(url, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(800) });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

let child = null;
if (!await reachable(`http://localhost:${PORT}/`, 600)) {
  child = spawn(process.execPath, [path.join(here, 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', b => process.stderr.write('[sim] ' + b));
  if (!await reachable(`http://localhost:${PORT}/`, 10000)) {
    child.kill();
    throw new Error('dev server never answered on ' + PORT);
  }
}

const ink = (page, id) => page.evaluate(canvasId => {
  const c = document.getElementById(canvasId);
  if (!c) return -1;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
}, id);

const read = (page, id) => page.textContent('#' + id).then(t => t.trim());

const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1250 } });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => {
  if (m.type() === 'error' && /content security policy|refused to/i.test(m.text())) {
    errors.push('csp: ' + m.text());
  }
});

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof MAP !== 'undefined' && MAP.isReady(),
  null, { timeout: 40000 }).catch(() => { throw new Error('map never became ready'); });

// ---- LIVE ----------------------------------------------------------------
await page.waitForFunction(() => {
  const el = document.getElementById('liveAvg');
  return el && el.textContent.trim() !== '--';
}, null, { timeout: 20000 }).catch(() => { throw new Error('LIVE chart never received a fix'); });
await page.waitForTimeout(700);
const live = {
  avg: await read(page, 'liveAvg'),
  stopped: await read(page, 'liveStopped'),
  peak: await read(page, 'livePeak'),
  ink: await ink(page, 'liveChart')
};
await page.$eval('#liveChart', el => el.scrollIntoView({ block: 'center' }));
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(os.tmpdir(), 'live-charts.png') });

// ---- WIFI ----------------------------------------------------------------
await page.click('.tab-btn[data-tab="wifi"]');
await page.waitForFunction(() => {
  const r = document.getElementById('wifiRate');
  const q = document.getElementById('wifiQuality');
  return r && q && r.textContent.trim() !== '--' && q.textContent.trim() !== '--';
}, null, { timeout: 20000 }).catch(() => { throw new Error('WIFI chart never received a frame'); });
await page.waitForTimeout(700);
const wifi = {
  quality: await read(page, 'wifiQuality'),
  rate: await read(page, 'wifiRate'),
  gap: await read(page, 'wifiGap'),
  rssi: await read(page, 'wifiRssi'),
  ssid: await read(page, 'wifiSsid'),
  ink: await ink(page, 'wifiChart')
};
await page.$eval('#wifiChart', el => el.scrollIntoView({ block: 'center' }));
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(os.tmpdir(), 'wifi-charts.png') });

// ---- MPU -----------------------------------------------------------------
await page.click('.tab-btn[data-tab="mpu"]');
await page.waitForFunction(() => {
  const a = document.getElementById('mpuAccel');
  const p = document.getElementById('mpuPeak');
  return a && p && a.textContent.trim() !== '--' && p.textContent.trim() !== '--';
}, null, { timeout: 20000 }).catch(() => { throw new Error('MPU chart never received a frame'); });
await page.waitForTimeout(700);
const mpu = {
  accel: await read(page, 'mpuAccel'),
  peak: await read(page, 'mpuPeak'),
  peakTilt: await read(page, 'mpuPeakTilt'),
  tiltInk: await ink(page, 'tiltChart'),
  ink: await ink(page, 'accelChart')
};
await page.$eval('#accelChart', el => el.scrollIntoView({ block: 'center' }));
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(os.tmpdir(), 'mpu-charts.png') });

await browser.close();
if (child) child.kill();

const fails = [];
const num = v => Number(String(v).replace(/[^\d.-]/g, ''));
if (!(num(live.avg) > 0)) fails.push(`LIVE avg: ${JSON.stringify(live.avg)}`);
if (!(num(live.stopped) >= 0 && num(live.stopped) <= 100)) fails.push(`LIVE stopped: ${JSON.stringify(live.stopped)}`);
if (!(num(live.peak) > 0)) fails.push(`LIVE peak: ${JSON.stringify(live.peak)}`);
if (!(live.ink > 1000)) fails.push(`LIVE chart ink: ${live.ink}`);
if (!/strong|fair|weak/.test(wifi.quality)) fails.push(`WIFI quality: ${JSON.stringify(wifi.quality)}`);
if (!(num(wifi.rate) > 0.5)) fails.push(`WIFI rate: ${JSON.stringify(wifi.rate)}`);
if (!(num(wifi.gap) >= 0)) fails.push(`WIFI gap: ${JSON.stringify(wifi.gap)}`);
if (!/dBm/.test(wifi.rssi)) fails.push(`WIFI rssi: ${JSON.stringify(wifi.rssi)}`);
if (wifi.ssid !== 'SIM-WIFI') fails.push(`WIFI ssid: ${JSON.stringify(wifi.ssid)}`);
if (!(wifi.ink > 1000)) fails.push(`WIFI chart ink: ${wifi.ink}`);
if (!(num(mpu.accel) > 0.5)) fails.push(`MPU accel: ${JSON.stringify(mpu.accel)}`);
if (!(num(mpu.peak) >= num(mpu.accel))) fails.push(`MPU peak ${mpu.peak} < current ${mpu.accel}`);
if (!(num(mpu.peakTilt) > 0)) fails.push(`MPU peak tilt: ${JSON.stringify(mpu.peakTilt)}`);
if (!(mpu.tiltInk > 500)) fails.push(`MPU tilt ink: ${mpu.tiltInk}`);
if (!(mpu.ink > 1000)) fails.push(`MPU accel ink: ${mpu.ink}`);
if (errors.length) fails.push(...errors);

console.log(`LIVE  avg ${live.avg} km/h, stopped ${live.stopped}%, peak ${live.peak} km/h, ink ${live.ink}`);
console.log(`WIFI  ${wifi.ssid}, ${wifi.rssi}, ${wifi.quality}, ${wifi.rate} msg/s, gap ${wifi.gap}s, ink ${wifi.ink}`);
console.log(`MPU   |a| ${mpu.accel} g, peak ${mpu.peak} g, peak tilt ${mpu.peakTilt} deg, ink ${mpu.ink} (tilt ${mpu.tiltInk})`);
console.log(`shots ${path.join(os.tmpdir(), 'live-charts.png')}`);
console.log(`      ${path.join(os.tmpdir(), 'wifi-charts.png')}`);
console.log(`      ${path.join(os.tmpdir(), 'mpu-charts.png')}`);

if (fails.length) {
  console.error('FAIL ' + fails.join('\nFAIL '));
  process.exit(1);
}
console.log('PASS live charts');

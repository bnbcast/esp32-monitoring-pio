/*
 * dev/check-mpu3d.mjs - Playwright gate for the MPU tab's 3D attitude view.
 *
 * Serves web/ locally, opens the MPU tab, then draws the canvas at three fixed
 * attitudes (level, tilted, offline) and checks that it is a real, non-blank
 * picture that changes with the angles. The canvas is software-rendered, so
 * getImageData can be read without a WebGL context.
 *
 * Usage: node dev/check-mpu3d.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(here, '..', 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png' };

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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => {
  if (m.type() === 'error' && /content security policy|refused to/i.test(m.text())) {
    errors.push('csp: ' + m.text());
  }
});

await page.goto(base + '#t=race-tracker', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof MPU3D !== 'undefined', null, { timeout: 30000 })
  .catch(() => { throw new Error('mpu3d.js never loaded'); });

await page.click('.tab-btn[data-tab="mpu"]');
await page.waitForTimeout(400);

const size = await page.evaluate(() => {
  const c = document.getElementById('mpu3d');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { bitmapW: c.width, bitmapH: c.height, cssW: Math.round(r.width), cssH: Math.round(r.height) };
});
if (!size) throw new Error('no #mpu3d canvas');

// Draw a fixed attitude and fingerprint the pixels. The checksum mixes the
// index with the channel values so a shifted board cannot collide with a
// recoloured one.
const paint = att => page.evaluate((a) => {
  const c = document.getElementById('mpu3d');
  MPU3D.draw(c, a);
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let ink = 0, sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 0) {
      ink++;
      sum = (sum + i * 31 + d[i] * 7 + d[i + 1] * 3 + d[i + 2]) % 1000000007;
    }
  }
  return { ink, sum };
}, att);

const level = await paint({ roll: 0, pitch: 0, yaw: 0, valid: true });
const tilted = await paint({ roll: 28, pitch: -14, yaw: 60, valid: true });

await page.locator('.mpu-3d').screenshot({ path: path.join(os.tmpdir(), 'mpu3d-desktop.png') });

const offline = await paint({ roll: 0, pitch: 0, yaw: 0, valid: false });

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
await page.evaluate(() => MPU3D.draw(document.getElementById('mpu3d'),
  { roll: -18, pitch: 22, yaw: 120, valid: true }));
await page.locator('.mpu-3d').screenshot({ path: path.join(os.tmpdir(), 'mpu3d-phone.png') });

await browser.close();
server.close();

console.log(`canvas     ${JSON.stringify(size)}`);
console.log(`level      ${level.ink} px, sum ${level.sum}`);
console.log(`tilted     ${tilted.ink} px, sum ${tilted.sum}`);
console.log(`offline    ${offline.ink} px, sum ${offline.sum}`);
console.log(`shots      ${path.join(os.tmpdir(), 'mpu3d-desktop.png')}`);
console.log(`           ${path.join(os.tmpdir(), 'mpu3d-phone.png')}`);

const fails = [];
if (!(size.cssW > 120)) fails.push(`canvas is only ${size.cssW}px wide`);
if (!(size.cssH > 100)) fails.push(`canvas is only ${size.cssH}px tall`);
if (size.bitmapW < size.cssW) fails.push(`bitmap ${size.bitmapW} < css ${size.cssW}`);
if (level.ink < 500) fails.push(`level view is nearly blank (${level.ink} px)`);
if (tilted.ink < 500) fails.push(`tilted view is nearly blank (${tilted.ink} px)`);
if (offline.ink < 200) fails.push(`offline view is nearly blank (${offline.ink} px)`);
if (level.sum === tilted.sum) fails.push('the picture did not change when the board tilted');
if (errors.length) fails.push(...errors);

if (fails.length) {
  console.error('FAIL ' + fails.join('\nFAIL '));
  process.exit(1);
}
console.log('PASS mpu3d');

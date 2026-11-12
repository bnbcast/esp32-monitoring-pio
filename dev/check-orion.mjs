/*
 * dev/check-orion.mjs - browser gate for the Orion rebrand.
 *
 * Serves web/ from a throwaway static server and checks the things a rename
 * usually breaks: the tab title, the wordmark and mascot, the favicon and
 * manifest links, the footer, the INFO intro, and that the icon files really
 * decode. Also captures desktop and phone screenshots.
 *
 * Usage: node dev/check-orion.mjs
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
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

const now = Math.floor(Date.now() / 1000);
const points = [];
for (let i = 0; i < 20; i++) {
  points.push([now - 60 + i * 2, -6.2 + i * 0.0001, 106.8 + i * 0.0001,
    18 + (i % 5), 90, 0.8, 6, -3, 42]);
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
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => {
  if (m.type() === 'error' && /content security policy|refused to|failed to load/i.test(m.text())) {
    errors.push('console: ' + m.text());
  }
});

await page.route('https://race-tracker-history.pages.dev/**', route => {
  route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body)
  });
});

await page.goto(base + '#t=orion-test', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof MAP !== 'undefined' && MAP.isReady(),
  null, { timeout: 40000 }).catch(() => { throw new Error('map never became ready'); });
await page.waitForFunction(() => {
  const img = document.querySelector('.brand-mascot');
  return img && img.complete && img.naturalWidth > 0;
}, null, { timeout: 20000 }).catch(() => { throw new Error('mascot never decoded'); });

const brand = await page.evaluate(() => {
  const h1 = document.querySelector('.top-bar h1');
  const img = document.querySelector('.brand-mascot');
  const icon = document.querySelector('link[rel="icon"][sizes="64x64"]');
  const apple = document.querySelector('link[rel="apple-touch-icon"]');
  const manifest = document.querySelector('link[rel="manifest"]');
  const styles = getComputedStyle(img);
  return {
    title: document.title,
    heading: h1 ? h1.textContent.replace(/\s+/g, ' ').trim() : '',
    mascot: { w: img.naturalWidth, h: img.naturalHeight, box: Math.round(img.getBoundingClientRect().height) },
    icon: icon ? icon.getAttribute('href') : null,
    apple: apple ? apple.getAttribute('href') : null,
    manifest: manifest ? manifest.getAttribute('href') : null,
    footer: (document.querySelector('footer span') || {}).textContent || '',
    theme: (document.querySelector('meta[name="theme-color"]') || {}).content || '',
    appName: (document.querySelector('meta[name="application-name"]') || {}).content || ''
  };
});

const infoIntro = await page.evaluate(() => {
  document.querySelector('.tab-btn[data-tab="info"]').click();
  return (document.getElementById('infoIntro') || {}).textContent || '';
});

const manifest = await (await fetch(base + 'manifest.webmanifest')).json();

const icons = [];
for (const size of [32, 64, 180, 192, 512]) {
  const res = await fetch(`${base}icons/orion-${size}.png`);
  const buf = Buffer.from(await res.arrayBuffer());
  // PNG IHDR: width and height are big-endian 32-bit at bytes 16 and 20.
  icons.push({
    n: size,
    status: res.status,
    w: buf.readUInt32BE(16),
    h: buf.readUInt32BE(20)
  });
}

await page.evaluate(() => document.querySelector('.tab-btn[data-tab="live"]').click());
await page.screenshot({ path: path.join(os.tmpdir(), 'orion-desktop.png') });

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(os.tmpdir(), 'orion-phone.png') });

await browser.close();
server.close();

const fails = [];
if (!/Orion/i.test(brand.title)) fails.push(`title: ${brand.title}`);
if (!/ORION/i.test(brand.heading) || !/LIVE/i.test(brand.heading)) fails.push(`heading: ${brand.heading}`);
if (!(brand.mascot.w > 100 && brand.mascot.h > 100)) fails.push(`mascot natural size: ${brand.mascot.w}x${brand.mascot.h}`);
if (!(brand.mascot.box >= 40)) fails.push(`mascot box: ${brand.mascot.box}px`);
if (!/icons\/orion-64\.png/.test(brand.icon || '')) fails.push(`favicon: ${brand.icon}`);
if (!/icons\/orion-180\.png/.test(brand.apple || '')) fails.push(`apple icon: ${brand.apple}`);
if (!/manifest\.webmanifest/.test(brand.manifest || '')) fails.push(`manifest link: ${brand.manifest}`);
if (!/ORION/.test(brand.footer)) fails.push(`footer: ${brand.footer}`);
if (brand.theme !== '#ffe600') fails.push(`theme-color: ${brand.theme}`);
if (brand.appName !== 'Orion Project') fails.push(`application-name: ${brand.appName}`);
if (!/Orion/.test(infoIntro)) fails.push(`INFO intro: ${infoIntro.slice(0, 80)}`);
if (manifest.name !== 'Orion Project') {
  fails.push(`manifest name: ${JSON.stringify(manifest.name)}`);
}
for (const i of icons) {
  if (i.status !== 200 || i.w !== i.n || i.h !== i.n) {
    fails.push(`icon ${i.n}: ${i.status} ${i.w}x${i.h}`);
  }
}
if (errors.length) fails.push(...errors);

console.log(`title    ${brand.title}`);
console.log(`heading  ${brand.heading} (mascot ${brand.mascot.w}x${brand.mascot.h}, box ${brand.mascot.box}px)`);
console.log(`icons    favicon ${brand.icon} · apple ${brand.apple}`);
console.log(`manifest ${manifest.name} / ${manifest.short_name}, ${manifest.icons.length} icons`);
console.log(`icons    ${icons.map(i => `${i.n}:${i.w}x${i.h}`).join(' ')}`);
console.log(`footer   ${brand.footer}`);
console.log(`shots    ${path.join(os.tmpdir(), 'orion-desktop.png')}`);
console.log(`         ${path.join(os.tmpdir(), 'orion-phone.png')}`);

if (fails.length) {
  console.error('FAIL ' + fails.join('\nFAIL '));
  process.exit(1);
}
console.log('PASS orion rebrand');

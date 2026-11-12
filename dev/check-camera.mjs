/*
 * dev/check-camera.mjs - what the map actually lets a desktop pointer do.
 *
 * Serves web/ locally, then drives a real browser and checks exactly what a
 * trackpad user complained about:
 *   - a plain drag pans, and the view stays where it was put (no snap-back)
 *   - a horizontal two-finger swipe (wheel deltaX) turns the map
 *   - a vertical wheel still zooms, and pinch (ctrl+wheel) is untouched
 *   - ctrl+drag still rotates and pitches, and the compass can be dragged
 *   - the camera lock is released by a click, a rotate and a pitch
 *
 * Usage: node dev/check-camera.mjs
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

await page.goto(base + '#t=race-tracker', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof MAP !== 'undefined' && MAP.isReady(),
  null, { timeout: 40000 }).catch(() => { throw new Error('map never became ready'); });
await page.waitForTimeout(1500);           // let the first fixes and follow settle

const state = () => page.evaluate(() => {
  const m = MAP.getMap();
  const c = m.getCenter();
  return {
    lng: +c.lng.toFixed(6), lat: +c.lat.toFixed(6),
    zoom: +m.getZoom().toFixed(3), bearing: +m.getBearing().toFixed(2),
    pitch: +m.getPitch().toFixed(2),
    moving: m.isMoving(),
    handlers: {
      dragPan: m.dragPan.isEnabled(),
      dragRotate: m.dragRotate.isEnabled(),
      scrollZoom: m.scrollZoom.isEnabled(),
      touchZoomRotate: m.touchZoomRotate.isEnabled(),
      keyboard: m.keyboard.isEnabled(),
      doubleClickZoom: m.doubleClickZoom.isEnabled()
    },
    maxPitch: m.getMaxPitch(),
    follow: MAP.isFollowing()
  };
});

const left = (a, b) => Math.hypot(a.lng - b.lng, a.lat - b.lat);
// Bearings wrap: 144 + 45 is reported as -171, not 189.
const turn = (from, to) => ((to - from + 540) % 360) - 180;

const before = await state();
const box = await page.locator('#map-container').boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

// ---- pan: a plain left-button drag -----------------------------------------
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 180, cy + 90, { steps: 15 });
await page.mouse.up();
await page.waitForTimeout(1200);
const afterPan = await state();
await page.waitForTimeout(3000);            // several fixes: does it snap back?
const afterPanWait = await state();

// ---- rotate: ctrl + drag is MapLibre's desktop rotate/pitch gesture ---------
await page.mouse.move(cx, cy);
const rotBefore = await state();
await page.keyboard.down('Control');
await page.mouse.down();
await page.mouse.move(cx + 120, cy - 40, { steps: 15 });
await page.mouse.up();
await page.keyboard.up('Control');
await page.waitForTimeout(700);
const afterRotate = await state();

// ---- trackpad rotate: horizontal wheel (deltaX) -----------------------------
await page.mouse.move(cx, cy);
const swipeBefore = await state();
await page.mouse.wheel(240, 0);
await page.waitForTimeout(500);
const afterSwipe = await state();

// ---- zoom: vertical wheel ---------------------------------------------------
await page.mouse.move(cx, cy);
await page.mouse.wheel(0, -240);
await page.waitForTimeout(700);
const afterWheel = await state();

// ---- pinching is ctrl+wheel: must still zoom, not rotate --------------------
await page.mouse.move(cx, cy);
const pinchBefore = await state();
await page.keyboard.down('Control');
await page.mouse.wheel(0, -240);
await page.keyboard.up('Control');
await page.waitForTimeout(700);
const afterPinch = await state();

// ---- compass drag rotates ---------------------------------------------------
const compass = await page.$('.maplibregl-ctrl-compass');
let compassBefore = null, compassAfter = null;
if (compass) {
  const b = await compass.boundingBox();
  const bx = b.x + b.width / 2, by = b.y + b.height / 2;
  compassBefore = (await state()).bearing;
  await page.mouse.move(bx, by);
  await page.mouse.down();
  await page.mouse.move(bx + 60, by, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  compassAfter = (await state()).bearing;
}

// ---- camera lock: every kind of gesture must release it --------------------
async function lockThen(action) {
  await page.evaluate(() => MAP.setFollow(true));
  await page.waitForTimeout(600);
  const was = (await state()).follow;
  await action();
  await page.waitForTimeout(600);
  return { was, now: (await state()).follow };
}

const lockDrag = await lockThen(async () => {
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 160, cy + 80, { steps: 12 });
  await page.mouse.up();
});

const lockClick = await lockThen(() => page.mouse.click(cx + 40, cy + 20));

const lockSwipe = await lockThen(() => page.mouse.wheel(200, 0));

const lockRotate = await lockThen(async () => {
  await page.mouse.move(cx, cy);
  await page.keyboard.down('Control');
  await page.mouse.down();
  await page.mouse.move(cx + 100, cy - 30, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up('Control');
});

const followUi = await page.evaluate(() => {
  const b = document.getElementById('btnFollow');
  return b ? { aria: b.getAttribute('aria-pressed'), cls: b.className } : null;
});

await page.screenshot({ path: path.join(os.tmpdir(), 'camera-controls.png') });

await browser.close();
server.close();

const out = [];
out.push(`handlers   ${JSON.stringify(before.handlers)}`);
out.push(`maxPitch   ${before.maxPitch}`);
out.push(`pan        moved ${(left(before, afterPan) * 1e5).toFixed(1)}e-5 deg, ` +
         `still moved after 3 s: ${(left(before, afterPanWait) * 1e5).toFixed(1)}e-5 deg`);
out.push(`ctrl+drag  bearing ${rotBefore.bearing} -> ${afterRotate.bearing}, ` +
         `pitch ${rotBefore.pitch} -> ${afterRotate.pitch}`);
out.push(`swipe      bearing ${swipeBefore.bearing} -> ${afterSwipe.bearing} ` +
         `(zoom ${swipeBefore.zoom} -> ${afterSwipe.zoom})`);
out.push(`wheel      zoom ${afterRotate.zoom} -> ${afterWheel.zoom}`);
out.push(`pinch      zoom ${pinchBefore.zoom} -> ${afterPinch.zoom}, ` +
         `bearing ${pinchBefore.bearing} -> ${afterPinch.bearing}`);
out.push(`compass    bearing ${compassBefore} -> ${compassAfter}`);
out.push(`lock drag  ${lockDrag.was} -> ${lockDrag.now}`);
out.push(`lock click ${lockClick.was} -> ${lockClick.now}`);
out.push(`lock swipe ${lockSwipe.was} -> ${lockSwipe.now}`);
out.push(`lock rot   ${lockRotate.was} -> ${lockRotate.now}`);
out.push(`follow ui  ${JSON.stringify(followUi)}`);
if (errors.length) out.push(`errors     ${errors.join(' | ')}`);
console.log(out.join('\n'));

const fails = [];
if (!before.handlers.dragPan) fails.push('dragPan is disabled');
if (!before.handlers.dragRotate) fails.push('dragRotate is disabled');
if (!before.handlers.scrollZoom) fails.push('scrollZoom is disabled');
if (left(before, afterPan) < 1e-4) fails.push('a left-button drag did not move the camera');
if (left(before, afterPanWait) < 1e-4) fails.push('the camera snapped back after the drag');
if (Math.abs(afterRotate.bearing - rotBefore.bearing) < 0.5 &&
    Math.abs(afterRotate.pitch - rotBefore.pitch) < 0.5) fails.push('ctrl+drag did not rotate or pitch');
if (Math.abs(turn(swipeBefore.bearing, afterSwipe.bearing)) < 5) {
  fails.push(`horizontal swipe did not rotate: ${swipeBefore.bearing} -> ${afterSwipe.bearing}`);
}
if (Math.abs(afterSwipe.zoom - swipeBefore.zoom) > 0.05) {
  fails.push(`horizontal swipe changed zoom: ${swipeBefore.zoom} -> ${afterSwipe.zoom}`);
}
if (afterWheel.zoom <= afterRotate.zoom) fails.push('vertical wheel did not zoom in');
if (afterPinch.zoom <= pinchBefore.zoom) fails.push('ctrl+wheel (pinch) did not zoom in');
if (Math.abs(turn(pinchBefore.bearing, afterPinch.bearing)) > 1) {
  fails.push(`ctrl+wheel rotated instead of zooming: ${pinchBefore.bearing} -> ${afterPinch.bearing}`);
}
if (compass && Math.abs(compassAfter - compassBefore) < 0.5) fails.push('compass drag did not rotate');

for (const [name, lock] of [['drag', lockDrag], ['click', lockClick],
                            ['swipe', lockSwipe], ['rotate', lockRotate]]) {
  if (!lock.was) fails.push(`could not turn the camera lock on before ${name}`);
  if (lock.now) fails.push(`a ${name} did not release the camera lock`);
}
if (followUi && followUi.aria !== 'false') fails.push(`follow button says ${followUi.aria}`);
if (errors.length) fails.push(...errors);

console.log(`shot       ${path.join(os.tmpdir(), 'camera-controls.png')}`);
if (fails.length) {
  console.error('FAIL ' + fails.join('\nFAIL '));
  process.exit(1);
}
console.log('PASS camera');

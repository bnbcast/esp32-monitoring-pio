/*
 * Tests for the MPU 3D attitude view.
 *
 * The projections live in web/ui/mpu3d.js, written to run both as a classic
 * browser script and under node, so these check the real maths the tab uses.
 *
 * Run with: node --test test/mpu3d.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const M = require(path.join(root, 'web', 'ui', 'mpu3d.js'));

const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const HTML = read('web/index.html');
const APP = read('web/ui/app.js');
const LAYOUT = read('web/css/layout.css');

const near = (a, b, eps) => Math.abs(a - b) < (eps == null ? 1e-9 : eps);

// ---- rotations ------------------------------------------------------------

test('no rotation leaves a point where it is', () => {
  const p = M.rotate([1, 2, 3], 0, 0, 0);
  assert.ok(near(p[0], 1) && near(p[1], 2) && near(p[2], 3));
});

test('yaw turns the board about the vertical axis', () => {
  const p = M.rotate([1, 0, 0], 0, 0, 90);
  assert.ok(near(p[0], 0, 1e-9), `x=${p[0]}`);
  assert.ok(near(p[1], 1, 1e-9), `y=${p[1]}`);
  assert.ok(near(p[2], 0, 1e-9), `z=${p[2]}`);
});

test('roll lifts the forward axis, pitch lifts the up axis forward', () => {
  const r = M.rotate([0, 1, 0], 90, 0, 0);
  assert.ok(near(r[0], 0, 1e-9) && near(r[1], 0, 1e-9) && near(r[2], 1, 1e-9),
    `roll 90 gave ${r}`);

  const q = M.rotate([0, 0, 1], 0, 90, 0);
  assert.ok(near(q[0], 1, 1e-9) && near(q[1], 0, 1e-9) && near(q[2], 0, 1e-9),
    `pitch 90 gave ${q}`);
});

test('a full turn and the angle it wraps to are the same', () => {
  const a = M.rotate([1, 0.5, 0.2], 12, -7, 10);
  const b = M.rotate([1, 0.5, 0.2], 12, -7, 370);
  assert.ok(near(a[0], b[0], 1e-9) && near(a[1], b[1], 1e-9) && near(a[2], b[2], 1e-9));
});

test('missing or junk angles do not produce NaN', () => {
  const cases = [
    [[1, 2, 3], undefined, undefined, undefined],
    [[1, 2, 3], null, null, null],
    [[1, 2, 3], 'x', NaN, undefined]
  ];
  for (const [p, r, t, y] of cases) {
    const out = M.rotate(p, r, t, y);
    assert.ok(out.every(Number.isFinite), `${JSON.stringify([r, t, y])} gave ${out}`);
  }
});

// ---- projection -----------------------------------------------------------

test('the origin projects to the middle of the model', () => {
  const o = M.project([0, 0, 0], 1);
  assert.ok(o.every(v => near(v, 0)), `origin gave ${o}`);
});

test('up is up on screen (canvas y is flipped)', () => {
  assert.ok(M.project([0, 0, 1], 1)[1] < 0);
});

test('a nearer point looks bigger than a far one', () => {
  const nearPt = Math.abs(M.project([1, 0, 1], 1)[0]);
  const farPt = Math.abs(M.project([1, 0, -1], 1)[0]);
  assert.ok(nearPt > farPt, `${nearPt} should exceed ${farPt}`);
});

test('scale multiplies the projected size and stays finite', () => {
  const a = M.project([1, 0, 0], 1);
  const b = M.project([1, 0, 0], 2);
  assert.ok(near(b[0], a[0] * 2, 1e-9));
  assert.ok(M.project([0, 0, 50], 1).every(Number.isFinite));
});

test('unit() normalises and survives a zero vector', () => {
  const v = M.unit([3, 4, 0]);
  assert.ok(near(Math.hypot(v[0], v[1], v[2]), 1));
  assert.ok(M.unit([0, 0, 0]).every(Number.isFinite));
});

// ---- page contract ---------------------------------------------------------

test('the page loads mpu3d.js before app.js at the same version', () => {
  const lib = HTML.indexOf('ui/mpu3d.js');
  const app = HTML.indexOf('ui/app.js');
  assert.ok(lib > 0, 'mpu3d.js is not loaded');
  assert.ok(lib < app, 'app.js calls MPU3D, so it must load after it');
  const versions = [...HTML.matchAll(/\?v=(\d+)/g)].map(m => m[1]);
  assert.strictEqual(new Set(versions).size, 1, `mixed asset versions: ${versions.join(', ')}`);
});

test('the MPU tab has a canvas with a fixed height', () => {
  assert.match(HTML, /id="tab-mpu"[\s\S]*id="mpu3d"/, 'no mpu3d canvas in the MPU tab');
  assert.match(HTML, /<canvas id="mpu3d"><\/canvas>/);
  assert.match(LAYOUT, /\.mpu-3d\s*{[\s\S]{0,120}height:\s*170px;/);
  assert.match(LAYOUT, /\.mpu-3d canvas\s*{[\s\S]{0,160}height:\s*100%\s*!important;/);
});

test('the dashboard feeds the last frame in and repaints on demand', () => {
  assert.match(APP, /MPU3D\.draw\(canvas, mpuAtt\)/);
  assert.match(APP, /mpuAtt\s*=\s*{[\s\S]{0,160}valid:/);
  assert.match(APP, /if \(name === 'mpu'\) drawMpu3d\(true\)/,
    'opening the tab must paint it: the canvas has no size while hidden');
  assert.match(APP, /drawMpu3d\(true\);/, 'a window resize must repaint it');
  // 1 Hz telemetry does not need a 60 Hz canvas.
  assert.match(APP, /now - mpuDrawnAt < 100/);
});

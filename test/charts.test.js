/*
 * Unit tests for the pure parts of web/ui/charts.js.
 *
 * The drawing needs a canvas, but axis rounding and gap/band merging are plain
 * functions and are what a chart gets wrong. Run with:
 *   node --test test/charts.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const C = require(path.join(__dirname, '..', 'web', 'ui', 'charts.js'));

test('autoMax ignores junk and never drops below the floor', () => {
  assert.strictEqual(C.autoMax([], 20), 20);
  assert.strictEqual(C.autoMax([1, 5, 12], 20), 20);
  assert.strictEqual(C.autoMax([1, 50, 12], 20), 50);
  assert.strictEqual(C.autoMax([null, undefined, NaN, 7], 0), 7);
  assert.strictEqual(C.autoMax(null, 3), 3);
});

test('niceMax rounds up to the requested step', () => {
  assert.strictEqual(C.niceMax(23, 10), 30);
  assert.strictEqual(C.niceMax(20, 10), 20);
  assert.strictEqual(C.niceMax(2.1, 0.5), 2.5);
  assert.strictEqual(C.niceMax(0, 10), 10);
  assert.strictEqual(C.niceMax(NaN, 5), 5);
});

test('bands merge adjacent bad samples into one block', () => {
  const pts = [
    [10, 0, 0.9], [11, 0, 4.2], [12, 0, 4.8], [13, 0, 0.8], [20, 0, 5.0]
  ];
  const out = C.bands(pts, p => p[2] > 3, 0.5);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out[0], [10.5, 12.5]);
  assert.deepStrictEqual(out[1], [19.5, 20.5]);
});

test('bands returns an empty list when nothing is bad', () => {
  const pts = [[1, 0, 0.8], [2, 0, 1.0]];
  assert.deepStrictEqual(C.bands(pts, p => p[2] > 3, 0.5), []);
  assert.deepStrictEqual(C.bands(null, () => true, 0.5), []);
});

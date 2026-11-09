/*
 * Unit tests for the live-frame plausibility gate (web/ui/guard.js).
 * Run with: node --test test/guard.test.js
 *
 * Every call passes an explicit "now" so the tests never depend on the machine
 * clock. The module takes nowMs as its second argument for exactly that reason.
 */
const test = require('node:test');
const assert = require('node:assert');
const GUARD = require('../web/ui/guard.js');

const BASE_MS = 1700000000000; // fixed clock

function frame(over, gps) {
  return Object.assign({
    seq: 1,
    up: 100,
    ts: Math.floor(BASE_MS / 1000),
    gps: Object.assign({
      fix: true, lat: -6.9, lng: 107.6, kmh: 20, hdop: 0.9, sats: 9
    }, gps || {})
  }, over || {});
}

// Accept a frame as if it arrived `dtMs` after BASE_MS.
function accept(f, dtMs) {
  return GUARD.accept(f, BASE_MS + (dtMs || 0));
}

test('accepts a normal frame', () => {
  GUARD.reset();
  assert.deepStrictEqual(accept(frame()), { ok: true });
});

test('rejects a frame with no gps block', () => {
  GUARD.reset();
  const f = frame();
  delete f.gps;
  assert.strictEqual(accept(f).reason, 'shape');
});

test('rejects a duplicate sequence number on the same boot', () => {
  GUARD.reset();
  assert.strictEqual(accept(frame()).ok, true);
  assert.strictEqual(accept(frame(), 1000).reason, 'duplicate');
});

test('rejects a sequence regression on the same boot', () => {
  GUARD.reset();
  accept(frame({ seq: 10 }));
  assert.strictEqual(accept(frame({ seq: 9 }), 1000).reason, 'seq-regression');
});

test('accepts a sequence restart after a reboot (uptime went backwards)', () => {
  GUARD.reset();
  accept(frame({ seq: 5000, up: 9000 }));
  assert.strictEqual(accept(frame({ seq: 1, up: 3 }), 1000).ok, true);
});

test('rejects impossible speed', () => {
  GUARD.reset();
  assert.strictEqual(accept(frame({}, { kmh: 400 })).reason, 'speed');
});

test('rejects out-of-range coordinates', () => {
  GUARD.reset();
  assert.strictEqual(accept(frame({}, { lat: 95 })).reason, 'range');
});

test('rejects a teleport the clock cannot explain', () => {
  GUARD.reset();
  accept(frame());
  // ~1.1 km north in one second is ~4000 km/h.
  assert.strictEqual(accept(frame({ seq: 2 }, { lat: -6.89 }), 1000).reason, 'teleport');
});

test('accepts real movement at race speed', () => {
  GUARD.reset();
  accept(frame({}, { kmh: 100 }));
  // ~30 m in one second at 100 km/h.
  assert.strictEqual(accept(frame({ seq: 2 }, { lat: -6.89973, kmh: 100 }), 1000).ok, true);
});

test('enforces the venue bbox only when one is configured', () => {
  GUARD.reset();
  GUARD.CONFIG.bbox = { minLat: -7.0, maxLat: -6.8, minLng: 107.5, maxLng: 107.7 };
  try {
    assert.strictEqual(accept(frame()).ok, true);
    GUARD.reset();
    assert.strictEqual(accept(frame({}, { lat: -6.5 })).reason, 'outside-area');
  } finally {
    GUARD.CONFIG.bbox = null;
  }
});

test('caps a flood at maxPerSecond attempts', () => {
  GUARD.reset();
  let accepted = 0;
  for (let i = 0; i < 25; i++) {
    if (accept(frame({ seq: i + 1 })).ok) accepted++;
  }
  assert.strictEqual(accepted, GUARD.CONFIG.maxPerSecond);
});

test('accepts frames with no device clock but rejects a month-old stamp', () => {
  GUARD.reset();
  assert.strictEqual(accept(frame({ ts: 0 })).ok, true);

  GUARD.reset();
  const old = Math.floor(BASE_MS / 1000) - 30 * 24 * 3600;
  assert.strictEqual(accept(frame({ ts: old })).reason, 'clock');
});

test('tolerates a small clock offset between device and browser', () => {
  GUARD.reset();
  const off = Math.floor(BASE_MS / 1000) + 600; // 10 minutes ahead
  assert.strictEqual(accept(frame({ ts: off })).ok, true);
});

test('accepts health-only frames while there is no fix', () => {
  GUARD.reset();
  assert.strictEqual(accept(frame({}, { fix: false, lat: null, lng: null })).ok, true);
});

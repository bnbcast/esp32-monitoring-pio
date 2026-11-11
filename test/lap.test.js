/*
 * Unit tests for the virtual finish line (see "FINISH LINE" in
 * src/mqtt_simple/mqtt_simple.cpp).
 *
 * The lap engine itself is C++ on the board, so this file mirrors the exact
 * geometry and interpolation from that source and checks it against known
 * crossings. It also reads the firmware to prove the mirror still matches:
 * if someone changes the direction test, the interpolation or a gate constant,
 * these tests fail instead of quietly measuring something else.
 *
 * Run with: node --test test/lap.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const CPP = fs.readFileSync(path.join(root, 'src', 'mqtt_simple', 'mqtt_simple.cpp'), 'utf8');

// ---- constants and shape of the real implementation -----------------------
const MIN_MS = Number(CPP.match(/#define LAP_MIN_MS\s+(\d+)UL/)[1]);
const MIN_KMH = Number(CPP.match(/#define LAP_MIN_KMH\s+([\d.]+)f/)[1]);

test('firmware and test agree on the gate constants', () => {
  assert.strictEqual(MIN_MS, 3000);
  assert.strictEqual(MIN_KMH, 5.0);
});

test('the firmware implements the geometry this test mirrors', () => {
  // Forward-only crossing of the cross product.
  assert.match(CPP, /if \(s0 < 0\.0 && s1 >= 0\.0\)/,
    'the forward crossing test changed - the lap test no longer matches the firmware');
  // Interpolation along P0 -> P1.
  assert.match(CPP, /const double frac = s0 \/ \(s0 - s1\);/,
    'the interpolation changed - the lap test no longer matches the firmware');
  assert.match(CPP, /const uint32_t crossMs = fixPrevMs \+ \(uint32_t\)\(frac \* \(double\)dt\);/,
    'the interpolated timestamp changed');
  // The gate is a segment, not an infinite line.
  assert.match(CPP, /const bool insideGate = \(a0 < 0\.0 && a1 >= 0\.0\) \|\| \(a0 >= 0\.0 && a1 < 0\.0\);/,
    'the gate segment test changed');
});

// ---- mirror of the firmware algorithm -------------------------------------
const KY = 110540.0;
const kx = lat => 111320.0 * Math.cos(lat * Math.PI / 180.0);

// Gate: two ends as [lat, lng].
function gateSide(gate, lat, lng) {
  const [[aLat, aLng], [bLat, bLng]] = gate;
  const midLat = (aLat + bLat) * 0.5;
  const k = kx(midLat);
  const gx = (bLng - aLng) * k;
  const gy = (bLat - aLat) * KY;
  return gx * ((lat - aLat) * KY) - gy * ((lng - aLng) * k);
}

// Feeds fixes into the same state machine the loop uses.
function makeEngine(gate) {
  const state = {
    prev: null,
    lapCrossMs: 0,
    lapCount: 0,
    lapLastMs: 0,
    lapBestMs: 0,
    crossings: []
  };

  function fix(lat, lng, tMs, kmh) {
    const s0 = state.prev ? gateSide(gate, state.prev.lat, state.prev.lng) : 0;
    const s1 = gateSide(gate, lat, lng);

    if (state.prev && s0 < 0 && s1 >= 0) {
      const [[aLat, aLng], [bLat, bLng]] = gate;
      const midLat = (aLat + bLat) * 0.5;
      const k = kx(midLat);
      const px = (lng - state.prev.lng) * k;
      const py = (lat - state.prev.lat) * KY;
      const a0 = px * ((aLat - state.prev.lat) * KY) - py * ((aLng - state.prev.lng) * k);
      const a1 = px * ((bLat - state.prev.lat) * KY) - py * ((bLng - state.prev.lng) * k);
      const inside = (a0 < 0 && a1 >= 0) || (a0 >= 0 && a1 < 0);

      if (inside) {
        const frac = s0 / (s0 - s1);
        const dt = tMs - state.prev.tMs;
        const crossMs = state.prev.tMs + Math.trunc(frac * dt);
        if (kmh >= MIN_KMH && (state.lapCrossMs === 0 || crossMs - state.lapCrossMs >= MIN_MS)) {
          state.crossings.push(crossMs);
          if (state.lapCrossMs !== 0) {
            state.lapLastMs = crossMs - state.lapCrossMs;
            if (state.lapBestMs === 0 || state.lapLastMs < state.lapBestMs) {
              state.lapBestMs = state.lapLastMs;
            }
            state.lapCount++;
          }
          state.lapCrossMs = crossMs;
        }
      }
    }

    state.prev = { lat, lng, tMs };
    return state;
  }

  return { fix, state };
}

// A finish line on the equator, 222 m wide, crossed by driving north.
const GATE = [[0.0, -0.001], [0.0, 0.001]];
const M_PER_DEG_LAT = KY;

test('a straight 5 Hz crossing is interpolated to the millisecond', () => {
  const e = makeEngine(GATE);
  // 100 km/h = 27.78 m/s; 5 Hz -> 5.556 m per fix. Approach from 20 m south,
  // with the crossing 1.5 intervals after the first sample.
  const step = M_PER_DEG_LAT * (27.78 / 5) / M_PER_DEG_LAT; // degrees
  let lat = -20 / M_PER_DEG_LAT;
  e.fix(lat, 0, 0, 100);
  // second sample 8 m south of the line, third 8 m north: crossing exactly
  // halfway, i.e. 100 ms after t=200 ms.
  e.fix(-8 / M_PER_DEG_LAT, 0, 200, 100);
  e.fix(8 / M_PER_DEG_LAT, 0, 400, 100);

  assert.deepStrictEqual(e.state.crossings, [300],
    'crossing should be exactly halfway in time between 200 ms and 400 ms');
  assert.strictEqual(e.state.lapCount, 0, 'the first crossing only arms the timer');
  assert.ok(Math.abs(step) > 0);
});

test('crossing the line backwards does not count', () => {
  const e = makeEngine(GATE);
  e.fix(-8 / M_PER_DEG_LAT, 0, 0, 100);   // south side (s < 0)
  e.fix(8 / M_PER_DEG_LAT, 0, 200, 100);  // north side
  assert.deepStrictEqual(e.state.crossings, [100]);
  e.fix(8 / M_PER_DEG_LAT, 0, 400, 100);
  e.fix(-8 / M_PER_DEG_LAT, 0, 600, 100); // back south: s0 >= 0, no lap
  assert.deepStrictEqual(e.state.crossings, [100], 'the reverse pass must be ignored');
});

test('a pass outside the gate segment is not a lap', () => {
  const e = makeEngine(GATE);
  // Drive north 50 m east of B (the gate is only +-0.001 deg wide).
  const lng = 0.002;
  e.fix(-8 / M_PER_DEG_LAT, lng, 0, 100);
  e.fix(8 / M_PER_DEG_LAT, lng, 200, 100);
  assert.deepStrictEqual(e.state.crossings, [], 'crossing the infinite line outside A-B must not count');
});

test('lap time is the interval between interpolated crossings', () => {
  const e = makeEngine(GATE);
  const run = (t0, laps) => {
    // Each pass: 8 m before and 8 m after the line, 200 ms apart.
    e.fix(-8 / M_PER_DEG_LAT, 0, t0, 120);
    e.fix(8 / M_PER_DEG_LAT, 0, t0 + 200, 120);
  };
  run(0, 1);                 // arms at t=100
  run(45000, 1);             // crosses at 45100 -> lap 45000 ms
  run(90000, 1);             // crosses at 90100 -> lap 45000 ms

  assert.strictEqual(e.state.crossings.length, 3);
  assert.strictEqual(e.state.lapCount, 2);
  assert.strictEqual(e.state.lapLastMs, 45000);
  assert.strictEqual(e.state.lapBestMs, 45000);
});

test('best lap keeps the fastest of unequal laps', () => {
  const e = makeEngine(GATE);
  const pass = (t0, dt) => {
    e.fix(-8 / M_PER_DEG_LAT, 0, t0, 120);
    e.fix(8 / M_PER_DEG_LAT, 0, t0 + dt, 120);
  };
  pass(0, 200);              // arms at 100
  pass(40000, 200);          // 40100 -> 40000 ms
  pass(80000, 400);          // 80200 -> 40100 ms
  pass(118000, 200);         // 118100 -> 37900 ms (best)

  assert.strictEqual(e.state.lapCount, 3);
  assert.strictEqual(e.state.lapBestMs, 37900);
  assert.strictEqual(e.state.lapLastMs, 37900);
});

test('re-crossing inside the minimum interval is ignored', () => {
  const e = makeEngine(GATE);
  e.fix(-8 / M_PER_DEG_LAT, 0, 0, 120);
  e.fix(8 / M_PER_DEG_LAT, 0, 200, 120);       // arms at 100
  e.fix(-8 / M_PER_DEG_LAT, 0, 2000, 120);
  e.fix(8 / M_PER_DEG_LAT, 0, 2200, 120);      // crossing at 2100, only 2 s later
  assert.strictEqual(e.state.lapCount, 0, 'a 2 s re-crossing must not score a lap');
});

test('a crossing below 5 km/h is ignored', () => {
  const e = makeEngine(GATE);
  e.fix(-8 / M_PER_DEG_LAT, 0, 0, 4.9);
  e.fix(8 / M_PER_DEG_LAT, 0, 200, 4.9);
  assert.deepStrictEqual(e.state.crossings, [], 'walking across the line must not count');
});

test('a 5 Hz sample that straddles the line is exact where a nearest-sample guess is not', () => {
  // The fix grid is 200 ms. A crossing 37 ms after a sample is reported as
  // 0 ms by "nearest sample", 200 ms by "next sample", and 37 ms here.
  const e = makeEngine(GATE);
  const v = 40;                            // m/s = 144 km/h
  const dt = 0.2;                          // 200 ms
  const stepM = v * dt;                    // 8 m per fix
  const beforeM = 37e-3 * v;               // 1.48 m before the line at the last fix
  e.fix(-beforeM / M_PER_DEG_LAT, 0, 0, 144);
  e.fix((stepM - beforeM) / M_PER_DEG_LAT, 0, 200, 144);

  const got = e.state.crossings[0];
  assert.strictEqual(got, 37, `interpolated crossing should be 37 ms, got ${got}`);
  const nearestSampleError = Math.min(got, 200 - got);   // what rounding would cost
  assert.ok(nearestSampleError < 50, 'the point of interpolation is a sub-50 ms error');
});

// ---- session persistence ------------------------------------------------
// The lap engine lives in NVS namespace "lap". These checks read the firmware
// so a refactor that silently drops the save (or restores the crossing time)
// fails here instead of losing a race to a brownout on the grid.

test('counters are saved on every completed lap', () => {
  const countIdx = CPP.indexOf('lapCount++;');
  const saveIdx = CPP.indexOf('lapSaveCounters();   // a brownout must not erase the session');
  assert.ok(countIdx > 0, 'the lap counter increment moved');
  assert.ok(saveIdx > countIdx, 'lapSaveCounters() must run right after lapCount++');
  assert.ok(saveIdx - countIdx < 1200, 'the save drifted away from the counted lap');
});

test('the save writes all three durable counters', () => {
  const save = CPP.slice(CPP.indexOf('static void lapSaveCounters() {'));
  const body = save.slice(0, save.indexOf('prefs.end();') + 'prefs.end();'.length);
  assert.match(body, /prefs\.putUInt\("n", lapCount\)/);
  assert.match(body, /prefs\.putUInt\("last", lapLastMs\)/);
  assert.match(body, /prefs\.putUInt\("best", lapBestMs\)/);
});

test('a reboot restores the counters but re-arms the line', () => {
  const load = CPP.slice(CPP.indexOf('void gpsLoadGates()'));
  const body = load.slice(0, load.indexOf('prefs.end();') + 'prefs.end();'.length);
  assert.match(body, /lapCount\s*=\s*prefs\.getUInt\("n", 0\)/);
  assert.match(body, /lapLastMs\s*=\s*prefs\.getUInt\("last", 0\)/);
  assert.match(body, /lapBestMs\s*=\s*prefs\.getUInt\("best", 0\)/);
  // millis() restarts at boot, so a restored crossing time would be a lie.
  const after = load.slice(load.indexOf('prefs.end();'));
  assert.match(after, /lapCrossMs = 0;/,
    'the crossing time must not be restored: millis() starts at 0 after a reboot');
});

test('arming a new gate clears the stored session too', () => {
  const cap = CPP.slice(CPP.indexOf('static void gpsCaptureGate(char which)'));
  const body = cap.slice(0, cap.indexOf('static void gpsShowGates'));
  const resetIdx = body.indexOf('lapCount = lapLastMs = lapBestMs = lapCrossMs = 0;');
  const saveIdx = body.indexOf('lapSaveCounters();   // persist the reset');
  assert.ok(resetIdx > 0, 'the gate capture no longer resets the counters');
  assert.ok(saveIdx > resetIdx, 'the reset must be persisted, or a reboot revives the old laps');
});

test('clearing the gate wipes the whole namespace, counters included', () => {
  const clr = CPP.slice(CPP.indexOf('static void gpsClearGates()'));
  const body = clr.slice(0, clr.indexOf('logMsg(L_OK, "LAP", "gate cleared")'));
  assert.match(body, /prefs\.clear\(\)/, 'gpsClearGates must clear the namespace, not just the gate keys');
  assert.match(body, /lapCount = lapLastMs = lapBestMs = lapCrossMs = 0;/);
});

/*
 * Unit tests for the GPS publish gate and the "tight" shadow gate.
 *
 * The gate itself is C++ on the board, so these tests do two things:
 *   1. read the firmware and prove the strict thresholds are only counted,
 *      never enforced, and that a rejected fix cannot become the reference
 *      for the next lap segment;
 *   2. mirror the two thresholds with a small fix set, so the percentage the
 *      POS line prints is arithmetically what the doc claims.
 *
 * Run with: node --test test/gps.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const CPP = fs.readFileSync(path.join(root, 'src', 'mqtt_simple', 'mqtt_simple.cpp'), 'utf8');

const num = re => Number(CPP.match(re)[1]);

test('the active gate and the shadow gate keep their documented values', () => {
  assert.strictEqual(num(/#define GPS_MIN_SATS\s+(\d+)/), 5);
  assert.strictEqual(num(/#define GPS_MAX_HDOP\s+([\d.]+)/), 4.0);
  assert.strictEqual(num(/#define GPS_STRICT_SATS\s+(\d+)/), 6);
  assert.strictEqual(num(/#define GPS_STRICT_HDOP\s+([\d.]+)/), 2.0);
});

test('the shadow gate cannot change what is published', () => {
  const from = CPP.indexOf('bool gpsFixUsable()');
  const body = CPP.slice(from, CPP.indexOf('\n}', from));
  assert.ok(!/GPS_STRICT/.test(body),
    'the strict threshold leaked into the publish gate - it must only be counted');
  // And it only counts fixes the real gate already accepted.
  assert.match(CPP, /if \(usable\) \{\s*gpsFixesAccepted\+\+;\s*if \(!gpsFixStrict\(\)\) gpsStrictReject\+\+;/,
    'the shadow counter must run after (and only after) the real gate says usable');
});

test('a rejected fix is not the reference for the next lap segment', () => {
  const from = CPP.indexOf('void updateGpsPositioning() {');
  const fn = CPP.slice(from, CPP.indexOf('\n}', from));
  const tail = fn.slice(fn.indexOf('// Only an accepted fix becomes the reference'));
  assert.match(tail, /if \(usable\) \{\s*fixPrevLat = lat;/,
    'fixPrev must only advance on an accepted fix');
  assert.ok(!/\n  fixPrevLat = lat;/.test(fn),
    'an unconditional fixPrev assignment came back: a 20 m-out fix could time the finish line');
});

// ---- mirror of the two thresholds ----------------------------------------
const passes = (fix, sats, hdop) => fix.sats >= sats && fix.hdop <= hdop;

test('a track-like fix set shows what tightening would cost', () => {
  const fixes = [
    { sats: 9, hdop: 0.7 },   // both gates
    { sats: 8, hdop: 1.1 },   // both gates
    { sats: 7, hdop: 1.9 },   // both gates
    { sats: 6, hdop: 2.4 },   // strict only (HDOP)
    { sats: 5, hdop: 1.5 },   // strict only (satellites)
    { sats: 5, hdop: 3.6 },   // strict only (both)
    { sats: 7, hdop: 2.0 }    // boundary: HDOP 2.0 passes
  ];
  const tight = fixes.filter(f => !passes(f, 6, 2.0));
  assert.deepStrictEqual(tight.map(f => f.hdop), [2.4, 1.5, 3.6]);
  assert.strictEqual(Math.floor(100 * tight.length / fixes.length), 42);

  // The POS line uses integer maths on the same two counters.
  assert.match(CPP, /\(100ULL \* gpsStrictReject\) \/ gpsFixesAccepted/);
  assert.match(CPP, /tight %lu\/%lu \(%u%%\)/);
});

// ---- hardware-fault reporting --------------------------------------------

test('a single I2C NACK does not mark the IMU dead', () => {
  const from = CPP.indexOf('if (mpuReadOnce(ax, ay, az, temp, gx, gy, gz)) return true;');
  const body = CPP.slice(from, CPP.indexOf('\n}', from));
  assert.match(body, /mpuReadOnce\(ax, ay, az, temp, gx, gy, gz\)/,
    'mpuRead must retry the burst read once');
  assert.strictEqual((body.match(/mpuReadOnce\(/g) || []).length, 2,
    'exactly one retry: a transient is hidden, a real disconnect still fails both attempts');
});

test('the UBX failure says which fault it is', () => {
  const from = CPP.indexOf('static bool gpsUbxConfigure()');
  const body = CPP.slice(from, CPP.indexOf('\n}', from) > 0 ? CPP.indexOf('\n}', from) : from);
  // The two outcomes must be distinguishable: no reply at all versus a module
  // that answers but refuses 38400.
  assert.match(CPP, /UBX: no reply on GPIO %d - wire module RX to it/);
  assert.match(CPP, /UBX: module answers on GPIO %d but ignored 38400/);
  // And the probe has to be an active UBX poll, not a wait for NMEA.
  const ping = CPP.slice(CPP.indexOf('static bool ubxPing()'));
  assert.match(ping.slice(0, ping.indexOf('\n}')), /ubxSend\(0x0A, 0x04, nullptr, 0\)/,
    'ubxPing must poll MON-VER (0x0A 0x04) so a module that ignores CFG-PRT still answers');
  assert.ok(body.length > 0);
});

/*
 * Static checks for firmware behaviour the dashboard relies on.
 * Run with: node --test test/firmware.test.js
 *
 * These do not compile the sketch; they pin the wire contract and the
 * debounce rules that keep a single I2C NACK from looking like a dead sensor.
 * The compiled check is `pio run`, which runs separately.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const SRC = fs.readFileSync(
  path.join(root, 'src', 'mqtt_simple', 'mqtt_simple.cpp'), 'utf8');

test('a lap is keyed to a session generation that survives a reboot', () => {
  // The board keeps its counters in NVS across a reset, so the server must key
  // the lap row on something that does not change on boot. `boot` does; `gen`
  // does not.
  assert.match(SRC, /uint32_t lapGen = 1;/);
  assert.match(SRC, /lapGen = sid\.getUInt\("gen", 1\)/,
    'the generation is not restored after a reboot');
  assert.match(SRC, /static void lapBumpGen\(\)/);
  assert.match(SRC, /prefs\.putUInt\("gen", lapGen\)/);
  // Every place the counters start over must start a new generation.
  const capture = SRC.slice(SRC.indexOf('static void gpsCaptureGate(char which)'),
                            SRC.indexOf('static void gpsShowGates'));
  const clear = SRC.slice(SRC.indexOf('static void gpsClearGates()'),
                          SRC.indexOf('static void gpsCaptureGate'));
  assert.match(capture, /lapBumpGen\(\);/, 'a new manual gate reuses the old generation');
  assert.match(clear, /lapBumpGen\(\);/, 'clearing the gate reuses the old generation');
  assert.match(SRC, /lapBumpGen\(\);\s+\/\/ a fresh session, new generation/,
    'auto-arm reuses the old generation');
  // Both payloads and the history frame must carry it.
  const flags = SRC.match(/\\"gen\\":%lu/g) || [];
  assert.strictEqual(flags.length, 2,
    `expected lap.gen in the full and slim payloads, found ${flags.length}`);
  assert.match(SRC, /hf\.lap_gen = lapGen;/);
  const HIST = fs.readFileSync(path.join(root, 'src', 'mqtt_simple', 'history.cpp'), 'utf8');
  assert.match(HIST, /\\"lap_gen\\":%lu/, 'history frames do not carry the generation');
});

test('the live payload carries the ESP32 die temperature', () => {
  assert.match(SRC, /const float chipTempC = temperatureRead\(\);/,
    'the temperature is not sampled once per publish');
  // Full and slim forms both carry it: a truncated publish must not drop it.
  const fields = SRC.match(/\\"temp_c\\":%\.1f/g) || [];
  assert.strictEqual(fields.length, 2,
    `expected temp_c in the full and slim payloads, found ${fields.length}`);
});

test('an MQTT connect failure names its cause', () => {
  // PubSubClient only reports a number, and -4 covers both "DNS died" and
  // "port 1883 is filtered". Resolve first and translate the state, so the log
  // says which layer failed instead of sending the reader to the wrong one.
  assert.match(SRC, /WiFi\.hostByName\(MQTT_HOST, brokerIp\)/,
    'the broker name is never resolved up front');
  assert.match(SRC, /DNS lookup for %s failed/,
    'a DNS failure is not distinguishable from a TCP timeout');
  assert.match(SRC, /mqttStateText\(mqtt\.state\(\)\)/,
    'the numeric state is logged without its meaning');
  assert.match(SRC, /case -4: return "timeout";/,
    'the state table does not cover a connect timeout');
});

test('a short I2C glitch is not reported as MPU FAIL', () => {
  assert.match(SRC, /#define MPU_FAULT_GRACE_MS 2000UL/);
  assert.match(SRC,
    /if \(mpuValid && millis\(\) - mpuFaultSince >= MPU_FAULT_GRACE_MS\)/,
    'mpuValid is cleared before the grace window expires');
  // Recovery is rate-limited too, so a dead sensor cannot flood the log.
  assert.match(SRC,
    /if \(millis\(\) - mpuRecoverAt >= MPU_FAULT_GRACE_MS\)/,
    'the I2C bus is re-initialised on every failed loop');
});

test('a lap needs no keystrokes: the board arms its own finish line', () => {
  // Sustained motion, not a single fast fix, is what picks the line.
  assert.match(SRC, /#define LAP_AUTO_HOLD_MS\s+5000UL/);
  assert.match(SRC, /#define LAP_AUTO_KMH\s+5\.0f/);
  assert.match(SRC, /#define LAP_AUTO_STOP_MS\s+180000UL/,
    'a powered trip to another venue would keep the old line');
  assert.match(SRC, /autoArmMs = now;/);
  assert.match(SRC, /autoArmMs = 0;\s+\/\/ a stop restarts the window/,
    'a stop must clear the arm window');
  // The line is anchored to the launch fix so the first return crossing times
  // lap 1 instead of only arming the gate.
  assert.match(SRC, /lapCrossMs = startMs;/,
    'lap 1 would be lost unless the clock starts at the launch fix');
  assert.match(SRC, /gateAuto = true;/);
  // Manual a/b takes ownership back and is never dropped by the distance rule.
  assert.match(SRC, /Any manual capture takes ownership/);
  assert.match(SRC, /gateAuto = false;/);
  // Both payloads must say where the line came from.
  const flags = SRC.match(/\\"auto\\":%s/g) || [];
  assert.strictEqual(flags.length, 2,
    `expected the auto flag in the full and slim payloads, found ${flags.length}`);
});

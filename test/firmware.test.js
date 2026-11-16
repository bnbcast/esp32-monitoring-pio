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

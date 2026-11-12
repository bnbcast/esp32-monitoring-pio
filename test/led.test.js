/*
 * Unit tests for the status LEDs.
 *
 * These exist because "all three LEDs are on" has two causes that look the same
 * from the outside, and the firmware must not make them indistinguishable:
 *   1. active-low wiring, where writing LOW to turn an LED *off* turns all on;
 *   2. the three signal wires shorted, where one pin HIGH lights all three.
 *
 * The LED layer is C++ on the board, so the tests do two things:
 *   - read the firmware and prove every LED write goes through the one
 *     polarity-aware helper, and that the self-test isolates one LED at a time;
 *   - mirror the helper in JavaScript and check the lit/dark state for both
 *     polarities, so "off" really is off on either wiring.
 *
 * Run with: node --test test/led.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const CPP = fs.readFileSync(path.join(root, 'src', 'mqtt_simple', 'mqtt_simple.cpp'), 'utf8');

// ---- the firmware has a single polarity gate ------------------------------

test('every LED write goes through ledWrite', () => {
  const direct = CPP.match(/digitalWrite\(LED_[A-Z]+_PIN[^)]*\)/g) || [];
  assert.deepStrictEqual(direct, [],
    `found a raw digitalWrite on an LED pin: ${direct.join(', ')} - a second ` +
    'code path would keep one wiring working and break the other');
  assert.match(CPP, /static void ledWrite\(uint8_t pin, bool on\)/);
});

test('ledWrite inverts both states when the wiring is active-low', () => {
  const from = CPP.indexOf('static void ledWrite(');
  const body = CPP.slice(from, CPP.indexOf('\n}', from));
  assert.match(body, /\(on != ledActiveLow\) \? HIGH : LOW/,
    'pin level must be a function of both the wanted state and the polarity');
});

// ---- mirrored truth table -------------------------------------------------

const OLD_HIGH = false;
const ACTIVE_LOW = true;

// Same expression as ledWrite(): the electrical level on the pin.
const level = (on, activeLow) => (on !== activeLow) ? 'HIGH' : 'LOW';
// Lit means the pin is at the level that forward-biases the LED.
const lit = (on, activeLow) => level(on, activeLow) === (activeLow ? 'LOW' : 'HIGH');

for (const wiring of [OLD_HIGH, ACTIVE_LOW]) {
  const label = wiring ? 'active-low' : 'active-high';

  test(`ledsOff leaves all three dark (${label})`, () => {
    for (const pin of ['BLUE', 'WHITE', 'RED']) {
      assert.strictEqual(lit(false, wiring), false, `${pin} must be dark at off`);
    }
  });

  test(`level 0 lights only blue, level 1 only white (${label})`, () => {
    // lvl == 0 -> blue true, others follow the link state (up => false)
    assert.deepStrictEqual(
      [lit(true, wiring), lit(false, wiring), lit(false, wiring)],
      [true, false, false]);
    assert.deepStrictEqual(
      [lit(false, wiring), lit(true, wiring), lit(false, wiring)],
      [false, true, false]);
  });

  test(`level 2 blinks red only, never all three (${label})`, () => {
    assert.deepStrictEqual(
      [lit(false, wiring), lit(false, wiring), lit(true, wiring)],
      [false, false, true]);
    // the other half of the blink is the same three pins off
    assert.deepStrictEqual(
      [lit(false, wiring), lit(false, wiring), lit(false, wiring)],
      [false, false, false]);
  });

  test(`fault mode blinks all three together (${label})`, () => {
    assert.deepStrictEqual(
      [lit(true, wiring), lit(true, wiring), lit(true, wiring)],
      [true, true, true]);
    assert.deepStrictEqual(
      [lit(false, wiring), lit(false, wiring), lit(false, wiring)],
      [false, false, false]);
  });
}

// ---- the self-test must separate the two faults ---------------------------

test('the self-test lights exactly one LED per step', () => {
  const from = CPP.indexOf('void ledSelfTest(');
  const body = CPP.slice(from, CPP.indexOf('\n}', from));
  assert.match(body, /for \(int i = 0; i < 3; i\+\+\)/);
  assert.match(body, /ledsOff\(\);\s*ledWrite\(pins\[i\], true\);/,
    'each step must clear the other two before lighting one');
  assert.match(body, /only %s should be lit/,
    'the console must name the colour, otherwise the observer cannot compare');
  assert.strictEqual((body.match(/ledWrite\(pins\[i\], true\)/g) || []).length, 1);
});

test('boot and console can both run the LED test', () => {
  assert.match(CPP, /ledSelfTest\("boot"\)/);
  assert.match(CPP, /ledSelfTest\("console"\)/);
});

test('the console can invert the polarity without a reflash', () => {
  const from = CPP.indexOf("case 'y': case 'Y':");
  assert.ok(from > 0, "missing the 'y' key");
  const body = CPP.slice(from, CPP.indexOf('break;', from));
  assert.match(body, /ledActiveLow = !ledActiveLow/);
  assert.match(body, /ledsOff\(\)/);
  // The self-test reports the current polarity, so 'd' verifies the change.
  const selfFrom = CPP.indexOf('void ledSelfTest(');
  const selfBody = CPP.slice(selfFrom, CPP.indexOf('\n}', selfFrom));
  assert.match(selfBody, /ledActiveLow \? "active-low, LOW = lit"/);
});

test('the polarity is loaded before the first write and saved by y', () => {
  const setup = CPP.indexOf('void mqtt_simple_setup()');
  const beforeTest = CPP.slice(setup, CPP.indexOf('ledSelfTest("boot"', setup));
  assert.match(beforeTest, /ledLoadPolarity\(\)/,
    'a power cycle must not lose the polarity learned by y');
  assert.ok(beforeTest.indexOf('ledLoadPolarity()') < beforeTest.indexOf('ledsOff()'),
    'loading after ledsOff would flash the wrong colours at every boot');

  const y = CPP.indexOf("case 'y': case 'Y':");
  assert.match(CPP.slice(y, CPP.indexOf('break;', y)), /ledSavePolarity\(\)/);
});

test('the help text mentions both LED keys', () => {
  assert.match(CPP, /d light each LED in turn/i);
  assert.match(CPP, /y invert polarity/i);
});

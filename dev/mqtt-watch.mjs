/*
 * dev/mqtt-watch.mjs - print raw MQTT traffic for a topic key, bypassing the
 * browser. Useful to prove whether the ESP32 is publishing at all, and to
 * capture replay fixtures for the dashboard tests.
 *
 * Usage:
 *   node dev/mqtt-watch.mjs                       # default key, 60 s window
 *   node dev/mqtt-watch.mjs <key> <ms>
 *   node dev/mqtt-watch.mjs --out test/fixtures/parked-clear.jsonl --dur 600000
 *
 * The --out file is JSON Lines, one object per message:
 *   {"t":1700000000000,"topic":"...","retained":false,"payload":{...}}
 * Raw text is kept in "raw" if the payload is not valid JSON.
 *
 * "live messages = 0" with a retained payload means the broker is fine but the
 * device is not connected (retained "offline" status = its last-will fired).
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import MiniMqtt from '../web/ui/mqtt-mini.js';

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const OUT = arg('out', '');
const KEY = arg('key', process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'race-tracker');
const DUR = Number(arg('dur', process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 60000));

const topics = [`esp32-dash/${KEY}/data`, `esp32-dash/${KEY}/status`];
const t0 = Date.now();
const at = () => '+' + ((Date.now() - t0) / 1000).toFixed(1) + 's';
let live = 0;

if (OUT) writeFileSync(OUT, '');

function record(topic, payload, retained) {
  if (!OUT) return;
  let body;
  try { body = { payload: JSON.parse(payload) }; }
  catch (e) { body = { raw: payload }; }
  appendFileSync(OUT, JSON.stringify(Object.assign({
    t: Date.now(), topic, retained
  }, body)) + '\n');
}

const client = new MiniMqtt({
  url: 'wss://broker.hivemq.com:8884/mqtt',
  topics,
  keepAlive: 30,
  onState: s => console.log('[state]', s, at()),
  onMessage: (topic, payload, retained) => {
    record(topic, payload, retained);
    if (retained) {
      console.log('[RETAINED]', topic, at(), '\n  ' + payload);
    } else {
      live++;
      console.log('[LIVE #' + live + ']', topic, at(), '\n  ' + payload.slice(0, 400));
    }
  }
});

console.log('watching', topics.join(' '), 'for', DUR, 'ms', OUT ? '-> ' + OUT : '');
client.start();
setTimeout(() => {
  console.log('\nWINDOW END: live messages =', live, OUT ? '(' + OUT + ')' : '');
  client.stop();
  process.exit(live > 0 ? 0 : 1);
}, DUR);

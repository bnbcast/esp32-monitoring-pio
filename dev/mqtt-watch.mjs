/*
 * dev/mqtt-watch.mjs — print raw MQTT traffic for a topic key, bypassing the
 * browser. Useful to prove whether the ESP32 is publishing at all.
 *
 * Usage:
 *   node dev/mqtt-watch.mjs                       # default key, 60 s window
 *   node dev/mqtt-watch.mjs ea77aca95507194b8e46 120000
 *
 * "live messages = 0" with a retained payload means the broker is fine but the
 * device is not connected (retained "offline" status = its last-will fired).
 */
import MiniMqtt from '../web/ui/mqtt-mini.js';

const KEY = process.argv[2] || 'ea77aca95507194b8e46';
const DUR = Number(process.argv[3] || 60000);
const topics = [`esp32-dash/${KEY}/data`, `esp32-dash/${KEY}/status`];
const t0 = Date.now();
const at = () => '+' + ((Date.now() - t0) / 1000).toFixed(1) + 's';
let live = 0;

const client = new MiniMqtt({
  url: 'wss://broker.hivemq.com:8884/mqtt',
  topics,
  keepAlive: 30,
  onState: s => console.log('[state]', s, at()),
  onMessage: (topic, payload, retained) => {
    if (retained) {
      console.log('[RETAINED]', topic, at(), '\n  ' + payload);
    } else {
      live++;
      console.log('[LIVE #' + live + ']', topic, at(), '\n  ' + payload.slice(0, 400));
    }
  }
});

client.start();
setTimeout(() => {
  console.log('\nWINDOW END: live messages =', live);
  client.stop();
  process.exit(live > 0 ? 0 : 1);
}, DUR);

/*
 * worker/test/live.test.mjs - the /live relay, without a broker or a socket.
 *
 *   node --test worker/test/live.test.mjs
 *
 * Two layers are pure: mqtt-wire.js (packet bytes) and live.js (the CONNACK ->
 * SUBSCRIBE -> retained PUBLISH state machine). The TCP transport is imported
 * lazily by the handler, so these tests never load cloudflare:sockets.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {
  connectPacket,
  subscribePacket,
  publishPacket,
  parsePackets,
  parsePublish,
  text
} from '../src/mqtt-wire.js';
import { LiveReader } from '../src/live.js';

const KEY = 'race-tracker';
const DATA = `esp32-dash/${KEY}/data`;
const STATUS = `esp32-dash/${KEY}/status`;

// Read an MQTT length-prefixed UTF-8 string; returns [value, nextOffset].
function readString(bytes, at) {
  const length = (bytes[at] << 8) | bytes[at + 1];
  return [text(bytes.slice(at + 2, at + 2 + length)), at + 2 + length];
}

function connack(code) {
  return Uint8Array.of(0x20, 0x02, 0x00, code);
}

function frame(extra = {}) {
  return JSON.stringify({
    seq: 42,
    ts: 1700000000,
    mpu: true,
    temp: 31.5,
    roll: 1.25,
    pitch: -0.5,
    gps: { fix: true, sats: 9, lat: -6.2, lng: 106.8, kmh: 23.4 },
    lap: { on: true, n: 3, last_ms: 61234 },
    sys: { heap: 120000, rssi: -71, temp_c: 64.2 },
    ...extra
  });
}

test('CONNECT is MQTT 3.1.1, clean session, with the client id', () => {
  const { packets, rest } = parsePackets(connectPacket('orion-live-abcd', 30));
  assert.equal(rest.length, 0);
  assert.equal(packets.length, 1);

  const { type, body } = packets[0];
  assert.equal(type, 1);

  const [protocol, at] = readString(body, 0);
  assert.equal(protocol, 'MQTT');
  assert.equal(body[at], 4);              // protocol level 3.1.1
  assert.equal(body[at + 1], 0x02);       // clean session
  assert.equal((body[at + 2] << 8) | body[at + 3], 30);

  const [clientId] = readString(body, at + 4);
  assert.equal(clientId, 'orion-live-abcd');
});

test('SUBSCRIBE carries the packet id and one QoS per topic', () => {
  const packet = subscribePacket(7, [
    { topic: DATA, qos: 0 },
    { topic: STATUS, qos: 0 }
  ]);
  const { packets } = parsePackets(packet);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].type, 8);
  assert.equal(packets[0].flags, 2);      // reserved bits of SUBSCRIBE

  const body = packets[0].body;
  assert.equal((body[0] << 8) | body[1], 7);

  const [first, at] = readString(body, 2);
  assert.equal(first, DATA);
  assert.equal(body[at], 0);
  const [second, end] = readString(body, at + 1);
  assert.equal(second, STATUS);
  assert.equal(body[end], 0);
  assert.equal(end + 1, body.length);
});

test('retained PUBLISH round-trips topic, payload and flag', () => {
  const packet = publishPacket(DATA, frame(), { retain: true });
  const { packets } = parsePackets(packet);
  const publish = parsePublish(packets[0].flags, packets[0].body);

  assert.equal(packets[0].type, 3);
  assert.equal(publish.topic, DATA);
  assert.equal(publish.retain, true);
  assert.equal(publish.qos, 0);
  assert.deepEqual(JSON.parse(text(publish.payload)), JSON.parse(frame()));
});

test('a packet split across chunks is reassembled, multi-byte length included', () => {
  // > 127 payload bytes forces the two-byte Remaining Length form.
  const payload = 'x'.repeat(300);
  const bytes = publishPacket(DATA, payload);

  // The length byte must have the continuation bit set.
  assert.equal(bytes[1] & 0x80, 0x80);

  for (const cut of [1, 2, 5, bytes.length - 1]) {
    let buffer = new Uint8Array(0);
    let packets = [];
    for (const part of [bytes.slice(0, cut), bytes.slice(cut)]) {
      buffer = Uint8Array.from([...buffer, ...part]);
      const parsed = parsePackets(buffer);
      packets = packets.concat(parsed.packets);
      buffer = parsed.rest;
    }
    assert.equal(packets.length, 1, `cut at ${cut}`);
    assert.equal(text(parsePublish(packets[0].flags, packets[0].body).payload), payload);
    assert.equal(buffer.length, 0);
  }
});

test('LiveReader sends CONNECT, then SUBSCRIBE only after CONNACK', () => {
  const reader = new LiveReader(KEY, 'test-client');
  const first = reader.takeOut();
  assert.equal(first.length, 1);
  assert.equal(parsePackets(first[0]).packets[0].type, 1);
  assert.deepEqual(reader.takeOut(), []);          // nothing before CONNACK

  reader.push(connack(0));
  const second = reader.takeOut();
  assert.equal(second.length, 1);
  assert.equal(parsePackets(second[0]).packets[0].type, 8);
  assert.deepEqual(reader.takeOut(), []);

  // A duplicate CONNACK must not subscribe twice.
  reader.push(connack(0));
  assert.deepEqual(reader.takeOut(), []);
});

test('LiveReader reports the retained frame and the online flag', () => {
  const reader = new LiveReader(KEY, 'test-client');
  reader.takeOut();
  reader.push(connack(0));

  const bytes = Uint8Array.from([
    ...publishPacket(DATA, frame(), { retain: true }),
    ...publishPacket(STATUS, 'online', { retain: true })
  ]);
  reader.push(bytes);

  const result = reader.result();
  assert.equal(result.topic, DATA);
  assert.equal(result.online, true);
  assert.equal(result.retained, true);
  assert.equal(result.frame.seq, 42);
  assert.equal(result.frame.gps.sats, 9);
  assert.equal(result.frame.sys.temp_c, 64.2);
  assert.equal(result.frame.lap.n, 3);
  assert.equal(reader.hasFrame, true);
  assert.equal(reader.hasStatus, true);
  assert.equal(reader.error, null);
});

test('LiveReader maps an offline last-will to online:false', () => {
  const reader = new LiveReader(KEY, 'test-client');
  reader.push(connack(0));
  reader.push(publishPacket(STATUS, 'offline', { retain: true }));

  assert.equal(reader.hasFrame, false);
  assert.equal(reader.result(), null);             // no frame yet
  assert.equal(reader.status, 'offline');
});

test('an unknown status string leaves online:null instead of guessing', () => {
  const reader = new LiveReader(KEY, 'test-client');
  reader.push(connack(0));
  reader.push(publishPacket(DATA, frame(), { retain: true }));
  reader.push(publishPacket(STATUS, 'starting', { retain: true }));

  assert.equal(reader.result().online, null);
});

test('a refused CONNACK stops the session and reports broker-refused', () => {
  const reader = new LiveReader(KEY, 'test-client');
  reader.takeOut();                                // the CONNECT
  reader.push(connack(5));                         // not authorised

  assert.equal(reader.error, 'broker-refused');
  assert.deepEqual(reader.takeOut(), []);          // never subscribes
});

test('ignores PUBLISH packets on unrelated topics', () => {
  const reader = new LiveReader(KEY, 'test-client');
  reader.push(connack(0));
  reader.push(publishPacket('esp32-dash/other/data', frame(), { retain: true }));
  reader.push(publishPacket(`esp32-dash/${KEY}/data2`, frame(), { retain: true }));

  assert.equal(reader.hasFrame, false);
});

test('bytes arriving one at a time still complete a frame', () => {
  const reader = new LiveReader(KEY, 'test-client');
  reader.takeOut();
  reader.push(connack(0));
  reader.takeOut();

  for (const byte of publishPacket(DATA, frame(), { retain: true })) {
    reader.push(Uint8Array.of(byte));
  }

  assert.equal(reader.hasFrame, true);
  assert.equal(reader.result().frame.seq, 42);
});

test('a non-JSON payload is returned as text instead of throwing', () => {
  const reader = new LiveReader(KEY, 'test-client');
  reader.push(connack(0));
  reader.push(publishPacket(DATA, 'not json', { retain: true }));

  assert.equal(reader.result().frame, 'not json');
});

test('GET /live rejects an unsafe key before touching the broker', async () => {
  for (const key of ['bad key', 'a'.repeat(33), 'x/y', 'race-tracker\n']) {
    const res = await worker.fetch(
      new Request(`https://api.test/live?key=${encodeURIComponent(key)}`), {}
    );
    const body = await res.json();
    assert.equal(res.status, 400, `key ${JSON.stringify(key)}`);
    assert.deepEqual(body, { ok: false, error: 'bad-key' });
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  }
});

test('OPTIONS /live is a preflight 204 with CORS headers', async () => {
  const res = await worker.fetch(
    new Request('https://api.test/live', { method: 'OPTIONS' }), {}
  );
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
});

test('POST /live is not routed', async () => {
  const res = await worker.fetch(
    new Request('https://api.test/live?key=race-tracker', { method: 'POST' }), {}
  );
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { ok: false, error: 'not-found' });
});

test('a transport failure is a 502, never a 500', async () => {
  // In Node there is no cloudflare:sockets module, so this exercises exactly
  // the "broker unreachable" branch: the handler must degrade, not crash.
  const res = await worker.fetch(
    new Request('https://api.test/live?key=race-tracker'), {}
  );
  const body = await res.json();

  assert.equal(res.status, 502);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'broker-unreachable');
});

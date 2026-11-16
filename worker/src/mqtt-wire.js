/*
 * worker/src/mqtt-wire.js - the few MQTT 3.1.1 bytes the /live relay needs.
 *
 * No client library: connect, subscribe to two topics, read the retained
 * PUBLISH packets, disconnect. Kept pure so it runs in workerd and in Node
 * tests without a broker.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function concatBytes(...parts) {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// UTF-8 string with the MQTT two-byte length prefix.
export function encodeString(value) {
  const bytes = encoder.encode(String(value));
  return concatBytes(Uint8Array.of(bytes.length >> 8, bytes.length & 0xff), bytes);
}

export function text(bytes) {
  return decoder.decode(bytes);
}

// Remaining Length: base-128, least significant group first.
export function varint(value) {
  const out = [];
  let n = value;
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Uint8Array.from(out);
}

export function packet(header, body) {
  return concatBytes(Uint8Array.of(header), varint(body.length), body);
}

// MQTT 3.1.1 CONNECT, clean session, no credentials.
export function connectPacket(clientId, keepAlive = 30) {
  const body = concatBytes(
    encodeString('MQTT'),
    Uint8Array.of(4),                                  // protocol level
    Uint8Array.of(0x02),                               // clean session
    Uint8Array.of(keepAlive >> 8, keepAlive & 0xff),
    encodeString(clientId)
  );
  return packet(0x10, body);
}

// SUBSCRIBE with one QoS per topic.
export function subscribePacket(id, topics) {
  const body = concatBytes(
    Uint8Array.of(id >> 8, id & 0xff),
    ...topics.map((t) => concatBytes(encodeString(t.topic), Uint8Array.of(t.qos || 0)))
  );
  return packet(0x82, body);
}

export function disconnectPacket() {
  return Uint8Array.of(0xe0, 0x00);
}

// Only used by the tests and by anything that wants to fake the broker.
export function publishPacket(topic, payload, options = {}) {
  const body = concatBytes(
    encodeString(topic),
    typeof payload === 'string' ? encoder.encode(payload) : payload
  );
  const header = 0x30 | (options.retain ? 1 : 0) | ((options.qos || 0) << 1);
  return packet(header, body);
}

// Pull whole packets out of a stream buffer. Returns what is left over.
export function parsePackets(buffer) {
  const packets = [];
  let rest = buffer;
  while (rest.length >= 2) {
    const length = readVarint(rest, 1);
    if (!length) break;
    const end = length.next + length.value;
    if (rest.length < end) break;
    packets.push({
      type: rest[0] >> 4,
      flags: rest[0] & 0x0f,
      body: rest.slice(length.next, end)
    });
    rest = rest.slice(end);
  }
  return { packets, rest };
}

function readVarint(bytes, start) {
  let value = 0;
  let multiplier = 1;
  let at = start;
  for (let i = 0; i < 4; i++) {
    if (at >= bytes.length) return null;
    const byte = bytes[at++];
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return { value, next: at };
    multiplier *= 128;
  }
  return null;
}

export function parsePublish(flags, body) {
  const topicLength = (body[0] << 8) | body[1];
  const topic = text(body.slice(2, 2 + topicLength));
  let at = 2 + topicLength;
  const qos = (flags >> 1) & 0x03;
  if (qos > 0) at += 2;                                // packet identifier
  return {
    topic,
    payload: body.slice(at),
    qos,
    retain: (flags & 0x01) === 1
  };
}

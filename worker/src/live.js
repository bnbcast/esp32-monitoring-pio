/*
 * worker/src/live.js - collect one retained telemetry frame from MQTT.
 *
 * Pure protocol state: no sockets here, so this runs in workerd and in tests.
 * The transport (live-tcp.js) feeds bytes in and sends whatever takeOut()
 * returns; the first CONNACK releases the SUBSCRIBE, and the retained DATA
 * and STATUS messages build the result.
 */
import {
  connectPacket,
  subscribePacket,
  disconnectPacket,
  concatBytes,
  parsePackets,
  parsePublish,
  text
} from './mqtt-wire.js';

const DATA = 'data';
const STATUS = 'status';

export class LiveReader {
  constructor(key, clientId) {
    this.dataTopic = `esp32-dash/${key}/${DATA}`;
    this.statusTopic = `esp32-dash/${key}/${STATUS}`;
    this.out = [connectPacket(clientId || 'orion-live-' + randomHex(4))];
    this.subscribe = subscribePacket(1, [
      { topic: this.dataTopic, qos: 0 },
      { topic: this.statusTopic, qos: 0 }
    ]);
    this.subscribed = false;
    this.buffer = new Uint8Array(0);
    this.frameRaw = null;
    this.status = null;
    this.retained = false;
    this.error = null;
  }

  // Packets the transport should write now.
  takeOut() {
    const out = this.out;
    this.out = [];
    return out;
  }

  push(bytes) {
    this.buffer = concatBytes(this.buffer, bytes);
    const parsed = parsePackets(this.buffer);
    this.buffer = parsed.rest;

    for (const packet of parsed.packets) {
      if (packet.type === 2) {                        // CONNACK
        const code = packet.body.length > 1 ? packet.body[1] : 1;
        if (code !== 0) {
          this.error = 'broker-refused';
          continue;
        }
        if (!this.subscribed) {
          this.subscribed = true;
          this.out.push(this.subscribe);
        }
      } else if (packet.type === 3) {                 // PUBLISH
        const publish = parsePublish(packet.flags, packet.body);
        if (publish.topic === this.dataTopic) {
          this.frameRaw = publish.payload;
          this.retained = publish.retain;
        } else if (publish.topic === this.statusTopic) {
          this.status = text(publish.payload);
        }
      }
    }
    return this;
  }

  get hasFrame() {
    return this.frameRaw != null;
  }

  get hasStatus() {
    return this.status != null;
  }

  // Success payload, or null until a data frame has arrived.
  result() {
    if (this.frameRaw == null) return null;
    const raw = text(this.frameRaw);
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch (e) {
      frame = raw;
    }
    return {
      topic: this.dataTopic,
      online: this.status === 'online' ? true : this.status === 'offline' ? false : null,
      retained: this.retained,
      frame
    };
  }

  drop() {
    return disconnectPacket();
  }
}

function randomHex(bytes) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (b) => b.toString(16).padStart(2, '0')).join('');
}

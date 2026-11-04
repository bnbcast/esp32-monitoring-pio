// mqtt-mini.js: a tiny read-only MQTT 3.1.1 client for browsers (MQTT over WebSocket).
// It can connect, subscribe (QoS 0) and receive messages. It cannot publish, so a
// page using it has no way to send anything to the broker.
// No dependencies, so there is nothing to pin or to load from a third-party CDN.
"use strict";
(function (root) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function concat(arrs) {
    let n = 0;
    arrs.forEach(a => { n += a.length; });
    const out = new Uint8Array(n);
    let o = 0;
    arrs.forEach(a => { out.set(a, o); o += a.length; });
    return out;
  }

  function strField(s) {
    const b = enc.encode(s);
    return concat([Uint8Array.of(b.length >> 8, b.length & 255), b]);
  }

  function remLen(n) {
    const a = [];
    do {
      let d = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) d |= 128;
      a.push(d);
    } while (n > 0);
    return Uint8Array.from(a);
  }

  function packet(first, body) {
    return concat([Uint8Array.of(first), remLen(body.length), body]);
  }

  function buildConnect(clientId, keepAlive) {
    const vh = Uint8Array.of(0, 4, 0x4D, 0x51, 0x54, 0x54, 4, 0x02, keepAlive >> 8, keepAlive & 255);
    return packet(0x10, concat([vh, strField(clientId)]));
  }

  function buildSubscribe(id, topics) {
    const parts = [Uint8Array.of(id >> 8, id & 255)];
    topics.forEach(t => { parts.push(strField(t), Uint8Array.of(0)); });
    return packet(0x82, concat(parts));
  }

  function parse(buf) {
    const packets = [];
    let pos = 0;
    for (;;) {
      if (buf.length - pos < 2) break;
      let mult = 1, len = 0, i = pos + 1, complete = false;
      for (;;) {
        if (i >= buf.length) break;
        const b = buf[i++];
        len += (b & 127) * mult;
        mult *= 128;
        if (mult > 128 * 128 * 128 * 128) throw new Error("bad remaining length");
        if (!(b & 128)) { complete = true; break; }
      }
      if (!complete) break;
      if (buf.length - i < len) break;
      packets.push({ type: buf[pos] >> 4, flags: buf[pos] & 15, body: buf.subarray(i, i + len) });
      pos = i + len;
    }
    return { packets, rest: buf.subarray(pos) };
  }

  function parsePublish(body, flags) {
    const tl = (body[0] << 8) | body[1];
    const topic = dec.decode(body.subarray(2, 2 + tl));
    let off = 2 + tl;
    const qos = (flags >> 1) & 3;
    if (qos > 0) off += 2;
    return { topic, payload: dec.decode(body.subarray(off)), retained: (flags & 1) === 1 };
  }

  class MiniMqtt {
    constructor(opts) {
      this.url = opts.url;
      this.topics = opts.topics;
      this.onMessage = opts.onMessage || function () {};
      this.onState = opts.onState || function () {};
      this.keepAlive = opts.keepAlive || 30;
      this.WS = opts.WebSocketImpl || root.WebSocket;
      this.clientId = opts.clientId || ("web-" + Array.from(
        (root.crypto || {}).getRandomValues ? root.crypto.getRandomValues(new Uint8Array(6)) : [1, 2, 3, 4, 5, 6],
        x => x.toString(16).padStart(2, "0")).join(""));
      this.ws = null;
      this.buf = new Uint8Array(0);
      this.attempt = 0;
      this.stopped = true;
      this.timers = [];
    }

    start() { this.stopped = false; this._connect(); }

    stop() {
      this.stopped = true;
      this._clearTimers();
      if (this.ws) { try { this.ws.close(); } catch (e) { /* ignore */ } }
    }

    _clearTimers() { this.timers.forEach(t => { clearTimeout(t); clearInterval(t); }); this.timers = []; }

    _send(bytes) { if (this.ws && this.ws.readyState === 1) this.ws.send(bytes); }

    _connect() {
      this.onState("connecting");
      this.buf = new Uint8Array(0);
      this.lastRx = Date.now();
      let ws;
      try {
        ws = new this.WS(this.url, "mqtt");
      } catch (e) {
        this._retry();
        return;
      }
      this.ws = ws;
      ws.binaryType = "arraybuffer";
      ws.onopen = () => this._send(buildConnect(this.clientId, this.keepAlive));
      ws.onmessage = ev => this._onData(new Uint8Array(ev.data));
      ws.onerror = () => { /* onclose follows */ };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this._clearTimers();
        this.onState("disconnected");
        this._retry();
      };
    }

    _retry() {
      if (this.stopped) return;
      const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(this.attempt, 5)));
      this.attempt++;
      this.timers.push(setTimeout(() => this._connect(), delay));
    }

    _onData(chunk) {
      this.lastRx = Date.now();
      this.buf = concat([this.buf, chunk]);
      let res;
      try { res = parse(this.buf); } catch (e) { this.ws.close(); return; }
      this.buf = res.rest;
      res.packets.forEach(p => this._onPacket(p));
    }

    _onPacket(p) {
      if (p.type === 2) {
        if (p.body[1] !== 0) { this.onState("refused"); this.ws.close(); return; }
        this.attempt = 0;
        this.onState("connected");
        this._send(buildSubscribe(1, this.topics));
        const every = Math.max(1000, this.keepAlive * 500);
        this.timers.push(setInterval(() => {
          if (Date.now() - this.lastRx > this.keepAlive * 1500) { this.ws.close(); return; }
          this._send(Uint8Array.of(0xC0, 0));
        }, every));
      } else if (p.type === 3) {
        const m = parsePublish(p.body, p.flags);
        this.onMessage(m.topic, m.payload, m.retained);
      }
    }
  }

  MiniMqtt._internals = { buildConnect, buildSubscribe, parse, parsePublish };
  root.MiniMqtt = MiniMqtt;
  if (typeof module !== "undefined" && module.exports) module.exports = MiniMqtt;
})(typeof window !== "undefined" ? window : globalThis);

/*
 * dev/server.js — Local dev server for testing the ESP32 dashboard without hardware.
 *
 * Serves web/ over HTTP and provides a WebSocket endpoint at /mqtt that speaks
 * MQTT-over-WebSocket (MiniMqtt protocol). A GPS simulator publishes simulated
 * telemetry so you can test the 3D trace, elevation chart, trip computer, and
 * signal quality panels without an ESP32.
 *
 * Usage:
 *   cd dev
 *   node server.js
 *   Open http://localhost:5003/?dev&t=<topic-key>
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 5003;
const WEB_DIR = path.join(__dirname, '..', 'web');

// ---- MQTT-over-WebSocket packet helpers (mirror mqtt-mini.js) ----
const enc = new TextEncoder();
const dec = new TextDecoder();

function strField(s) {
  const b = enc.encode(s);
  return [b.length >> 8, b.length & 255, ...b];
}

function remLen(n) {
  const a = [];
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 128;
    a.push(d);
  } while (n > 0);
  return a;
}

function packet(first, body) {
  return new Uint8Array([first, ...remLen(body.length), ...body]);
}

function buildConnectAck() {
  // CONNACK: 0x20, remaining length 2, session present 0, return code 0 (accepted)
  return new Uint8Array([0x20, 0x02, 0x00, 0x00]);
}

function buildSubAck(packetId) {
  // SUBACK: 0x90, remaining length 3, packetId, return code 0
  return new Uint8Array([0x90, 0x03, packetId >> 8, packetId & 255, 0x00]);
}

function buildPublish(topic, payloadStr, retained = false) {
  const topicBytes = enc.encode(topic);
  const payloadBytes = enc.encode(payloadStr);
  const qos = 0;
  const flags = (qos << 1) | (retained ? 1 : 0);
  const body = [
    topicBytes.length >> 8, topicBytes.length & 255,
    ...topicBytes,
    ...payloadBytes
  ];
  return new Uint8Array([0x30 | flags, ...remLen(body.length), ...body]);
}

function buildPingResp() {
  return new Uint8Array([0xD0, 0x00]);
}

// ---- HTTP static file server ----
function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.svg': 'image/svg+xml',
  }[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  // Strip query string first
  const cleanUrl = req.url.split('?')[0];

  // ---- Tile proxy: forward OSM tile requests with proper User-Agent ----
  if (cleanUrl.startsWith('/tiles/')) {
    const tilePath = cleanUrl.slice('/tiles/'.length); // e.g. 12/1034/1723.png
    const reqOpts = {
      hostname: 'a.tile.openstreetmap.org',
      path: '/' + tilePath,
      method: 'GET',
      headers: {
        'User-Agent': 'ESP32-Dashboard/1.0 (https://github.com/esp32-dash)',
        'Accept': 'image/png',
      },
    };
    const osmReq = https.request(reqOpts, (osmRes) => {
      res.writeHead(osmRes.statusCode, {
        'Content-Type': osmRes.headers['content-type'] || 'image/png',
        'Cache-Control': 'public, max-age=86400',
      });
      osmRes.pipe(res);
    });
    osmReq.on('error', (e) => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Tile proxy error: ' + e.message);
    });
    osmReq.end();
    return;
  }

  let filePath = path.join(WEB_DIR, cleanUrl === '/' ? '/index.html' : cleanUrl);
  serveFile(res, filePath);
});

// ---- WebSocket / MQTT broker ----
const wss = new WebSocketServer({ server, path: '/mqtt' });

const clients = new Map(); // ws -> { topics: Set, clientId }

wss.on('connection', (ws, req) => {
  let buffer = new Uint8Array(0);
  let clientId = 'unknown';
  console.log(`[WS] New connection from ${req.socket.remoteAddress}`);

  ws.on('message', (data) => {
    const chunk = new Uint8Array(data);
    console.log(`[WS] Received ${chunk.length} bytes, first byte: 0x${chunk[0]?.toString(16)}`);
    buffer = concat([buffer, chunk]);

    // Simple parser: process complete MQTT packets
    while (buffer.length >= 2) {
      const first = buffer[0];
      const type = first >> 4;

      // Parse remaining length
      let mult = 1, len = 0, i = 1;
      for (;;) {
        if (i >= buffer.length) break; // incomplete, wait for more
        const b = buffer[i++];
        len += (b & 127) * mult;
        mult *= 128;
        if (mult > 128 * 128 * 128 * 128) { 
          console.log('[WS] Bad remaining length, closing');
          ws.close(); 
          return; 
        }
        if (!(b & 128)) break;
      }

      if (buffer.length < i + len) break; // incomplete, wait for more
      const body = buffer.subarray(i, i + len);
      buffer = buffer.subarray(i + len);

      if (type === 1) { // CONNECT
        try {
          clientId = parseConnect(body);
          clients.set(ws, { topics: new Set(), clientId });
          ws.send(buildConnectAck());
          console.log(`[MQTT] Client connected: ${clientId}`);
        } catch (e) {
          console.log('[MQTT] CONNECT parse error:', e.message);
          ws.close();
        }
      } else if (type === 8) { // SUBSCRIBE
        const packetId = (body[0] << 8) | body[1];
        const c = clients.get(ws);
        if (c) {
          let off = 2;
          while (off < body.length) {
            const tl = (body[off] << 8) | body[off + 1];
            const topic = dec.decode(body.subarray(off + 2, off + 2 + tl));
            c.topics.add(topic);
            off += 2 + tl + 1; // topic + qos byte
          }
          ws.send(buildSubAck(packetId));
          console.log(`[MQTT] ${clientId} subscribed to: ${[...c.topics].join(', ')}`);
        }
      } else if (type === 12) { // PINGREQ
        ws.send(buildPingResp());
      } else {
        console.log(`[WS] Unhandled MQTT packet type: ${type}`);
      }
    }
  });

  ws.on('close', (code, reason) => {
    clients.delete(ws);
    console.log(`[WS] Connection closed: code=${code} reason=${reason} client=${clientId}`);
  });

  ws.on('error', (err) => {
    clients.delete(ws);
    console.log(`[WS] Connection error: ${err.message} client=${clientId}`);
  });
});

function concat(arrs) {
  let n = 0;
  arrs.forEach(a => { n += a.length; });
  const out = new Uint8Array(n);
  let o = 0;
  arrs.forEach(a => { out.set(a, o); o += a.length; });
  return out;
}

function parseConnect(body) {
  // Minimal parse: find clientId in payload
  // Variable header:
  //   protocol name length: 2 bytes
  //   protocol name:        4 bytes ("MQTT")
  //   protocol version:     1 byte
  //   connect flags:        1 byte
  //   keep alive:           2 bytes
  // Total: 10 bytes
  // Payload: clientId (2-byte length + string)
  let off = 10;
  const tl = (body[off] << 8) | body[off + 1];
  return dec.decode(body.subarray(off + 2, off + 2 + tl)) || 'unknown';
}

// ---- Publish helper ----
function publish(topic, payloadStr, retained = false) {
  const pkt = buildPublish(topic, payloadStr, retained);
  let sent = 0;
  for (const [ws, info] of clients) {
    if (ws.readyState === 1 && info.topics.has(topic)) {
      ws.send(pkt);
      sent++;
    }
  }
  if (sent > 0) {
    console.log(`[MQTT] Published to ${topic} (${sent} client(s))`);
  }
}

module.exports = { publish, server, wss };

// ---- GPS Simulator ----
function startSimulator() {
  const TOPIC_KEY = process.env.TOPIC_KEY || 'dev-test-1234';
  const TOPIC_DATA = `esp32-dash/${TOPIC_KEY}/data`;
  const TOPIC_STATUS = `esp32-dash/${TOPIC_KEY}/status`;

  // Publish online status
  publish(TOPIC_STATUS, 'online', true);

  let angle = 0;
  let totalDistM = 0;
  let lastLat = 0, lastLng = 0;
  let originSet = false;

  // Circular route: 100m radius, completes one lap every ~2 minutes
  const radius = 100;
  const centerLat = 37.7749;
  const centerLng = -122.4194;

  console.log(`[SIM] GPS simulator started on topic ${TOPIC_DATA}`);

  // Heading scenarios (env-gated; default 'normal' = unchanged behaviour).
  //   normal  : car moving, GPS course reliable
  //   drift   : car STOPPED (speed 0) but MPU yaw keeps rotating -> gyro drift hold
  //   dropout : periodic GPS fix loss -> stale / no-fix handling
  //   wrap    : heading sweeps across the 0/360 boundary -> no-spin check
  const SCENARIO = process.env.SIM_SCENARIO || 'normal';
  let scenarioPhase = 0;

  setInterval(() => {
    try {
      angle += 0.05; // radians per tick (200ms)
      if (angle > Math.PI * 2) angle -= Math.PI * 2;
      scenarioPhase += 0.05;

      // Position on circle
      const dLat = (radius * Math.sin(angle)) / 110540;
      const dLng = (radius * Math.cos(angle)) / (111320 * Math.cos(centerLat * Math.PI / 180));
      const lat = centerLat + dLat;
      const lng = centerLng + dLng;

      // Altitude: sinusoidal elevation change +/- 15m
      const alt = 50 + 15 * Math.sin(angle * 2);

      // ---- heading scenario overrides -------------------------------------
      let speedKmh, cog, hdop, fix, sats;
      if (SCENARIO === 'drift') {
        // Stopped: no GPS course, but MPU yaw keeps rotating (relative change)
        speedKmh = 0;
        cog = null; // no course when stopped
        hdop = 1.0;
        fix = true;
      } else if (SCENARIO === 'dropout') {
        speedKmh = 15 + 10 * Math.sin(angle * 3);
        cog = (angle * 180 / Math.PI + 90) % 360;
        hdop = 0.8 + 2.2 * Math.abs(Math.sin(angle * 5));
        // lose fix for ~3s every 20s
        fix = (scenarioPhase % (Math.PI * 10)) < (Math.PI * 3);
      } else if (SCENARIO === 'wrap') {
        // heading sweeps across 0/360 repeatedly
        speedKmh = 20;
        cog = (scenarioPhase * 60) % 360;
        hdop = 1.0;
        fix = true;
      } else {
        // normal: unchanged behaviour
        speedKmh = 15 + 10 * Math.sin(angle * 3);
        cog = (angle * 180 / Math.PI + 90) % 360;
        hdop = 0.8 + 2.2 * Math.abs(Math.sin(angle * 5));
        sats = Math.round(12 - 4 * Math.abs(Math.sin(angle * 5)));
        fix = Math.random() > 0.02;
      }

      // Distance accumulated (haversine from last point)
      if (lastLat !== 0 || lastLng !== 0) {
        const d = haversineM(lastLat, lastLng, lat, lng);
        totalDistM += d;
      }
      lastLat = lat;
      lastLng = lng;

      // UTC time
      const now = new Date();
      const utc = {
        h: now.getUTCHours(),
        m: now.getUTCMinutes(),
        s: now.getUTCSeconds(),
        y: now.getUTCFullYear(),
        mo: now.getUTCMonth() + 1,
        d: now.getUTCDate(),
      };

      const gps = {
        chars: Math.floor(Math.random() * 50000),
        sats,
        fix,
        lat: fix ? lat : null,
        lng: fix ? lng : null,
        alt: fix ? Math.round(alt) : null,
        kmh: fix ? Math.round(speedKmh * 10) / 10 : null,
        cog: fix ? Math.round(cog * 10) / 10 : null,
        hdop: fix ? Math.round(hdop * 100) / 100 : null,
        dist_m: Math.round(totalDistM * 100) / 100,
        utc_h: utc.h,
        utc_m: utc.m,
        utc_s: utc.s,
        utc_y: utc.y,
        utc_mo: utc.mo,
        utc_d: utc.d,
      };

      const msg = JSON.stringify({
        up: Math.floor(Date.now() / 1000),
        mpu: true,
        roll: 5 * Math.sin(angle),
        pitch: 3 * Math.cos(angle),
        yaw: angle * 180 / Math.PI,
        tilt: Math.abs(5 * Math.sin(angle)),
        ax: 0.1, ay: 0.2, az: 0.9, temp: 25,
        lvl: 0, warn: 30, danger: 50, maxTilt: 8, peakA: 1.5,
        acs: { ok: true, amps: 2.5, v: 2.9, zero: 2.5 },
        gps,
        sys: { heap: 200000, rssi: -50 },
      });

      publish(TOPIC_DATA, msg, true);
    } catch (e) {
      console.error('[SIM] Error in tick:', e.message);
    }
  }, 200);
}

function haversineM(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Start simulator after a short delay to let clients connect
setTimeout(startSimulator, 1500);

server.listen(PORT, () => {
  console.log(`Dev server running at http://localhost:${PORT}/`);
  console.log(`Open http://localhost:${PORT}/?dev&t=<your-topic-key>`);
  console.log(`WebSocket MQTT endpoint: ws://localhost:${PORT}/mqtt`);
});

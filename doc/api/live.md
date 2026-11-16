# GET /live — current sensor data

Everything the device is reporting *right now*, in one request: the newest
frame published on the MQTT data topic, plus whether the device is online.

This is the same data the live dashboard shows. Nothing is stored and nothing
is written to D1.

| | |
|---|---|
| Method | `GET` |
| Path | `/live` |
| Auth | none (public read) |
| CORS | `access-control-allow-origin: *` |
| Cache | `no-store` — always the moment of the request |
| Typical time | 0.7–1.5 s; up to ~6 s when the first session is retried |

**Try it:** [API Tester → Live sensors](https://bnbcast.github.io/esp32-monitoring-pio/api/docs/)
— the card sends the request and summarises online state, GPS fix, speed,
satellites, roll/pitch, MPU temperature and chip temperature.

---

## Request

```http
GET /live?key=race-tracker HTTP/1.1
Host: race-tracker-history.pages.dev
```

No headers are required and no body is sent.

| Query | Type | Default | Notes |
|-------|------|---------|-------|
| `key` | string | `race-tracker` | MQTT topic key, 1–32 chars of `A-Z a-z 0-9 _ -` |

The key selects the topics `esp32-dash/<key>/data` and
`esp32-dash/<key>/status`; it is **not** a secret. The device's ingest key
(`X-Ingest-Key`) has nothing to do with this endpoint and is never used here.

curl:

```bash
curl -sS -i "https://race-tracker-history.pages.dev/live?key=race-tracker"
```

---

## Response — 200

```json
{
  "ok": true,
  "topic": "esp32-dash/race-tracker/data",
  "online": true,
  "retained": true,
  "retrieved_ms": 1763000000123,
  "frame": {
    "seq": 48213,
    "ts": 1763000000,
    "up": 15342,
    "boot": 7,
    "mpu": true,
    "roll": 4.1,
    "pitch": -2.1,
    "yaw": 12.3,
    "tilt": 4.6,
    "ax": 0.02,
    "ay": -0.01,
    "az": 1.0,
    "temp": 31.5,
    "lvl": 0,
    "warn": false,
    "danger": false,
    "maxTilt": 21.4,
    "gps": {
      "fix": true,
      "sats": 9,
      "lat": -6.200001,
      "lng": 106.800001,
      "alt": 42.5,
      "kmh": 23.4,
      "cog": 187.5,
      "hdop": 0.8,
      "q": 4,
      "snr": 38,
      "dist_m": 1240.5,
      "ttff_s": 12,
      "mode": 3,
      "still": false
    },
    "lap": { "on": true, "n": 3, "last_ms": 61234, "best_ms": 59870 },
    "sys": {
      "heap": 120000,
      "heap_min": 98000,
      "boot": 7,
      "rssi": -71,
      "temp_c": 64.2,
      "wifi": { "status": "Connected", "ip": "192.168.1.20" }
    }
  }
}
```

### Top-level fields

| Field | Type | Meaning |
|-------|------|---------|
| `ok` | boolean | Always `true` on 200 |
| `topic` | string | The data topic that was read |
| `online` | boolean \| null | `true` = the device's retained status is `online`; `false` = last will says `offline`; `null` = no status retained yet (unknown) |
| `retained` | boolean | `true` when the frame came from the broker's retained slot, i.e. the latest published frame even if the device is now offline |
| `retrieved_ms` | number | Epoch milliseconds when the relay collected the frame |
| `frame` | object | The MQTT payload, exactly as published; see [mqtt.md](mqtt.md) for every field |

`frame` and its blocks are the device's own JSON, so a field the firmware does
not send is simply absent. If the payload were ever not JSON, `frame` would be
the raw string instead of an object.

The two temperatures are different sensors:

- `frame.temp` — MPU6050 die temperature, normal range roughly 25–45 °C
- `frame.sys.temp_c` — ESP32 chip temperature, often 50–85 °C; the junction
  limit is 125 °C

`frame.ts` is the device clock in epoch seconds, so a frame can be a second or
two old even when `online` is `true`.

---

## Errors

All errors use the API's JSON shape `{"ok":false,"error":"<code>"}`.

| Status | `error` | Cause | What to do |
|--------|---------|-------|------------|
| 400 | `bad-key` | `key` fails the 1–32 char `[A-Za-z0-9_-]` rule | Fix the query string |
| 502 | `broker-unreachable` | The relay could not open a TCP connection to the public broker | Retry in a moment |
| 502 | `broker-refused` | The broker answered CONNACK with a non-zero code | Retry; if it persists the broker is refusing new sessions |
| 504 | `live-timeout` | No data frame after two capped attempts (~6 s) | The key may be wrong, or the device has never published a retained frame on that topic |

A topic that has never been used returns `504 live-timeout`, not `404`: the
broker has nothing retained to send, so there is no frame to return.

Example:

```json
{ "ok": false, "error": "bad-key" }
```

---

## How it works

```text
GET /live ──▶ Pages Function ──▶ MQTT CONNECT ──▶ broker.hivemq.com:1883
                                      │
                                      ├─ SUBSCRIBE esp32-dash/<key>/data
                                      └─ SUBSCRIBE esp32-dash/<key>/status
                                      ▼
                          retained DATA + STATUS ──▶ JSON response
                                      ▼
                                  DISCONNECT
```

- One outbound TCP session per attempt (at most two), opened with the runtime's
  `cloudflare:sockets` API and closed as soon as the retained frame arrives.
- No D1 read, no D1 write, no new topic, no firmware change: the broker already
  keeps the last message, so there is nothing to copy.
- The status subscribe is best-effort: a frame still returns with
  `"online": null` if the status message does not arrive within 300 ms.
- Each attempt is capped at 3 s, and the public broker's habit of accepting a
  TCP connection and then going quiet is covered by one retry with a fresh
  session (~6 s worst case). Because every call opens a broker session, poll at
  most about once per second — the device only publishes once per second, so
  faster polling just repeats the same frame.

The implementation is split into a pure packet codec
(`worker/src/mqtt-wire.js`), a socket-free state machine
(`worker/src/live.js`) and the TCP transport (`worker/src/live-tcp.js`), which
is imported lazily so the Node tests never need `cloudflare:sockets`.

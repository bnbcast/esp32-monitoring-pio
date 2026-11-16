# API Endpoints Reference

Base URL: **https://race-tracker-history.pages.dev** (Cloudflare Pages Function).

Public read. Writes require `X-Ingest-Key`. All responses are JSON.

> **Try it live:** [API Tester](https://bnbcast.github.io/esp32-monitoring-pio/api/docs/) — send every endpoint from your browser, with the response status, timing, headers and body on screen. Reads need nothing; the ingest key is typed at runtime and never embedded in the page.

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/health` | — | Liveness |
| GET | `/history` | — | Stored fixes + laps |
| GET | `/live` | — | Newest sensor frame, right now |
| POST | `/ingest` | `X-Ingest-Key` | Device batch upload |
| OPTIONS | any | — | CORS preflight, `204` |

Unknown paths on the Pages deployment fall through to the static landing page
(`200`, HTML), because Pages treats a missing `404.html` as a single-page app.
The JSON error shape applies to the Worker entry and to a known path called
with the wrong method: `404 { "ok": false, "error": "not-found" }`.

Full request/response detail lives in [history.md](history.md) and
[live.md](live.md); the telemetry payload itself is documented in
[mqtt.md](mqtt.md).

---

## Quick Reference

### GET /health

```json
{ "ok": true, "service": "race-tracker-history" }
```

### GET /history

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `device` | string | `esp32-01` | 32-char cap |
| `from` | epoch sec | now − 24 h | must be `< to` |
| `to` | epoch sec | now | inclusive |
| `limit` | int | `2000` | clamped 1–5000 |

```json
{
  "ok": true, "device": "esp32-01", "from": 1700000000, "to": 1700086400,
  "count": 1, "total": 86400, "step": 173, "sampled": true,
  "maxGap": 2, "truncated": false,
  "points": [[1700000001, -6.200001, 106.800001, 45.2, 90.5, 0.8, 4.1, -2.1, 7]],
  "laps": [[1700000123, 1, 45230, 44210]]
}
```

- Point tuple: `[ts, lat, lon, kmh, cog, hdop, roll, pitch, boot]`
- Lap tuple: `[ts, n, dur_ms, best_ms]`
- Invalid window: `400 { "ok": false, "error": "bad-window" }`

### GET /live

Newest frame the device published, read from the broker's retained message —
the same data as the live dashboard. No database read or write.

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `key` | string | `race-tracker` | 1–32 chars of `A-Z a-z 0-9 _ -` |

```json
{
  "ok": true,
  "topic": "esp32-dash/race-tracker/data",
  "online": true,
  "retained": true,
  "retrieved_ms": 1763000000123,
  "frame": { "seq": 48213, "ts": 1763000000, "gps": { "fix": true, "sats": 9, "kmh": 23.4 }, "sys": { "temp_c": 64.2 } }
}
```

| Status | `error` | Cause |
|--------|---------|-------|
| 400 | `bad-key` | `key` outside `[A-Za-z0-9_-]{1,32}` |
| 502 | `broker-unreachable` | Broker TCP connect failed |
| 502 | `broker-refused` | Broker rejected the MQTT session |
| 504 | `live-timeout` | No retained frame after two capped attempts |

`online` is `true`, `false` or `null` (no status retained yet). A topic with no
retained frame returns `504`, not `404`. Full field and error detail:
[live.md](live.md).

### POST /ingest

```json
{
  "device": "esp32-01",
  "frames": [
    {"seq": 1234, "up": 3600, "ts": 1700000001, "boot": 7, "fix": true,
     "lat": -6.2, "lng": 106.8, "kmh": 45.2, "cog": 90.5, "hdop": 0.8,
     "sats": 8, "roll": 4.1, "pitch": -2.1}
  ]
}
```

`seq`, `up` and `ts` are mandatory. Response:

```json
{
  "ok": true, "received": 1, "stored": 1, "laps": 0,
  "duplicates": 0, "rejected": [], "retention": "skipped"
}
```

| Status | `error` | Cause |
|--------|---------|-------|
| 400 | `bad-json` | Body is not JSON |
| 400 | `no-frames` | Missing/empty `frames` |
| 401 | `unauthorized` | Missing/wrong `X-Ingest-Key` |
| 413 | `body-too-large` | Body > 64 KB |
| 413 | `too-many-frames` | More than 120 frames |
| 503 | `ingest-key-not-set` | Server has no `INGEST_KEY` |

---

## CORS

```http
access-control-allow-origin: *
access-control-allow-methods: GET, POST, OPTIONS
access-control-allow-headers: content-type, x-ingest-key
```

---

## Limits (implemented)

| Limit | Value |
|-------|-------|
| Body size | 64 KB |
| Frames per batch | 120 |
| History rows per response | 5000 |
| Retention | 365 days |
| Speed gate | 150 km/h |
| HDOP gate | 8 |

There is no per-IP rate limiter in the function; device traffic is paced by the
30 s upload interval.

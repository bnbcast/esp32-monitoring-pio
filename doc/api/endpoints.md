# API Endpoints Reference

All endpoints are served from the Cloudflare Pages Function at:
**https://race-tracker-history.pages.dev**

No API key required for read endpoints. Write endpoints require `X-Ingest-Key` header.

---

## GET /health

Liveness probe. Returns 200 OK if the service is healthy.

### Response (200)
```json
{
  "ok": true,
  "service": "race-tracker-history"
}
```

---

## GET /history

Query stored GPS fixes for a device.

### Query Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `device` | string | No | `esp32-01` | Device identifier |
| `from` | integer (epoch seconds) | No | 24h ago | Start time (inclusive) |
| `to` | integer (epoch seconds) | No | now | End time (inclusive) |
| `limit` | integer | No | 1000 | Max rows to return |

### Example Request
```
GET /history?from=1700000000&to=1700086400&limit=500
```

### Response (200)
```json
{
  "ok": true,
  "device": "esp32-01",
  "from": 1700000000,
  "to": 1700086400,
  "count": 500,
  "total": 12345,
  "step": 1,
  "sampled": false,
  "maxGap": 2,
  "truncated": false,
  "points": [
    [1700000001, -6.200001, 106.800001, 45.2, 90.5, 0.8, 8, -2.1, 42],
    [1700000003, -6.200002, 106.800003, 46.1, 91.2, 0.9, 7, -1.8, 43]
  ],
  "laps": []
}
```

### Point Array Format
Each point is an array: `[ts, lat, lng, kmh, cog, hdop, sats, pitch, roll]`

| Index | Field | Unit | Notes |
|-------|-------|------|-------|
| 0 | `ts` | seconds (epoch) | GPS time when available, else receive time |
| 1 | `lat` | degrees | WGS84 |
| 2 | `lng` | degrees | WGS84 |
| 3 | `kmh` | km/h | Speed over ground |
| 4 | `cog` | degrees | Course over ground (0–360) |
| 5 | `hdop` | — | Horizontal dilution of precision |
| 6 | `sats` | count | Satellites used |
| 7 | `pitch` | degrees | MPU fused pitch |
| 8 | `roll` | degrees | MPU fused roll |

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | Always true on success |
| `device` | string | Device ID queried |
| `from` | integer | Start epoch (may be adjusted to data bounds) |
| `to` | integer | End epoch |
| `count` | integer | Points returned in this response |
| `total` | integer | Total points in range (before limit) |
| `step` | integer | Downsampling step (1 = every point) |
| `sampled` | boolean | True if downsampled |
| `maxGap` | integer | Largest gap between consecutive points (seconds) |
| `truncated` | boolean | True if `limit` cut the result |
| `points` | array | Array of point arrays (see format above) |
| `laps` | array | Lap objects (if any in range) |

### Error Responses
| Status | Body |
|--------|------|
| 400 | `{"ok":false,"error":"invalid from/to"}` |
| 404 | `{"ok":false,"error":"not-found"}` |

---

## POST /ingest

Ingest a batch of frames from the ESP32. Called by the device every ~30 seconds.

### Headers
| Header | Required | Value |
|--------|----------|-------|
| `Content-Type` | Yes | `application/json` |
| `X-Ingest-Key` | Yes | Secret key (configured in Pages env) |

### Request Body
```json
{
  "device": "esp32-01",
  "frames": [
    {"ts":1700000001,"lat":-6.200001,"lng":106.800001,"kmh":45.2,"cog":90.5,"hdop":0.8,"sats":8,"pitch":-2.1,"roll":42},
    {"ts":1700000003,"lat":-6.200002,"lng":106.800003,"kmh":46.1,"cog":91.2,"hdop":0.9,"sats":7,"pitch":-1.8,"roll":43}
  ]
}
```

### Frame Object
Same fields as point array but as named properties. `ts` is optional (server adds receive time if missing).

### Response (200)
```json
{"ok":true,"accepted":2,"stored":2}
```

| Field | Description |
|-------|-------------|
| `accepted` | Frames parsed successfully |
| `stored` | Frames written to D1 (after filtering: GPS fix required, speed/parked policy) |

### Error Responses
| Status | Body |
|--------|------|
| 400 | `{"ok":false,"error":"invalid json"}` |
| 401 | `{"ok":false,"error":"unauthorized"}` (missing/invalid `X-Ingest-Key`) |
| 413 | `{"ok":false,"error":"payload too large"}` (>64 KB) |
| 429 | `{"ok":false,"error":"rate limited"}` |

---

## OPTIONS /history /ingest

CORS preflight. Returns 204 with appropriate headers.

---

## Rate Limits

| Endpoint | Limit |
|----------|-------|
| GET /health | 60 req/min/IP |
| GET /history | 30 req/min/IP |
| POST /ingest | 10 req/min/device (enforced by device batch interval) |

---

## CORS

All endpoints allow `Origin: *` for browser access from the dashboard.

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, X-Ingest-Key
```

---

## Data Retention

- Points older than 365 days are deleted daily (via scheduled batch, not cron)
- Device deletes its local batch on any 2xx response
- No PII stored; only telemetry
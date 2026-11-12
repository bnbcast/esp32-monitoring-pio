# History API (Cloudflare Pages Function)

Base URL: **https://race-tracker-history.pages.dev**

All endpoints are public read; write requires secret.

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | — | Liveness |
| GET | `/history` | — | Query stored fixes |
| POST | `/ingest` | `X-Ingest-Key` | Device batch upload |

---

## GET /health

```http
GET /health
```

**200 OK**
```json
{ "ok": true, "service": "race-tracker-history" }
```

---

## GET /history

```http
GET /history?device=esp32-01&from=1700000000&to=1700086400&limit=500
```

### Query Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `device` | string | `esp32-01` | Device ID |
| `from` | integer (epoch sec) | 24h ago | Start (inclusive) |
| `to` | integer (epoch sec) | now | End (inclusive) |
| `limit` | integer | 1000 | Max rows returned |

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

### Point Format

`[ts, lat, lng, kmh, cog, hdop, sats, pitch, roll]`

| Idx | Field | Unit |
|-----|-------|------|
| 0 | `ts` | epoch seconds |
| 1 | `lat` | degrees |
| 2 | `lng` | degrees |
| 3 | `kmh` | km/h |
| 4 | `cog` | degrees |
| 5 | `hdop` | — |
| 6 | `sats` | count |
| 7 | `pitch` | degrees |
| 8 | `roll` | degrees |

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | Always true on success |
| `device` | string | Device ID |
| `from` | integer | Actual start (clamped to data) |
| `to` | integer | Actual end |
| `count` | integer | Points in this response |
| `total` | integer | Points in range (before limit) |
| `step` | integer | Downsampling step (1 = all) |
| `sampled` | boolean | True if downsampled |
| `maxGap` | integer | Largest gap (seconds) |
| `truncated` | boolean | True if `limit` cut results |
| `points` | array | Point arrays (see format) |
| `laps` | array | Lap objects (future) |

---

## POST /ingest

Device calls this every ~30 seconds with batched frames.

```http
POST /ingest
Content-Type: application/json
X-Ingest-Key: <secret>
```

```json
{
  "device": "esp32-01",
  "frames": [
    {"ts":1700000001,"lat":-6.200001,"lng":106.800001,"kmh":45.2,"cog":90.5,"hdop":0.8,"sats":8,"pitch":-2.1,"roll":42},
    {"ts":1700000003,"lat":-6.200002,"lng":106.800003,"kmh":46.1,"cog":91.2,"hdop":0.9,"sats":7,"pitch":-1.8,"roll":43}
  ]
}
```

### Frame Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `ts` | integer | No | Epoch sec; server adds if missing |
| `lat` | number | Yes* | Degrees; required if `hdop` present |
| `lng` | number | Yes* | Degrees; required if `hdop` present |
| `kmh` | number | No | Speed over ground |
| `cog` | number | No | Course over ground (deg) |
| `hdop` | number | No | GPS quality; **fix required if present** |
| `sats` | integer | No | Satellites used |
| `pitch` | number | No | MPU pitch (deg) |
| `roll` | number | No | MPU roll (deg) |

*Fix required for storage: frames without valid GPS fix are dropped.

### Response (200)

```json
{ "ok": true, "accepted": 120, "stored": 118 }
```

| Field | Description |
|-------|-------------|
| `accepted` | Frames parsed successfully |
| `stored` | Frames written to D1 (after fix/quality filter) |

### Errors

| Status | Body |
|--------|------|
| 400 | `{ "ok":false, "error":"invalid json" }` |
| 401 | `{ "ok":false, "error":"unauthorized" }` (missing/invalid `X-Ingest-Key`) |
| 413 | `{ "ok":false, "error":"payload too large" }` (>64 KB) |
| 429 | `{ "ok":false, "error":"rate limited" }` |

---

## Storage Policy (D1)

| Rule | Detail |
|------|--------|
| Only GPS fix frames | `hdop` must be present and valid |
| Moving (≥3 km/h) | Every frame (1 Hz) |
| Parked | 1 frame / 10 s |
| Retention | 365 days (daily delete batch) |
| Capacity | ~9M frames/year < 5 GB free tier |

---

## CORS

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, X-Ingest-Key
```

---

## Device Behavior

1. Ring buffer (LittleFS) accumulates frames with GPS fix
2. Every 30s or 120 frames → `POST /ingest`
3. On **any 2xx** → delete batch locally (even if some frames rejected)
4. On network error → retry next cycle (buffer persists)

This ensures the device never blocks on a failed upload.

---

## Example: Query Last Hour

```bash
curl "https://race-tracker-history.pages.dev/history?from=$(date -d '1 hour ago' +%s)&limit=200"
```

---

## Example: Ingest (device)

```bash
curl -X POST https://race-tracker-history.pages.dev/ingest \
  -H "Content-Type: application/json" \
  -H "X-Ingest-Key: $INGEST_KEY" \
  -d '{"device":"esp32-01","frames":[{"ts":1700000001,"lat":-6.2,"lng":106.8,"kmh":45,"hdop":0.8,"sats":8}]}'
```
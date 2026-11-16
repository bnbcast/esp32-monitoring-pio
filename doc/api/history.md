# History API (Cloudflare Pages Function)

Base URL: **https://race-tracker-history.pages.dev**

Public read; write requires the ingest secret. All responses are JSON with CORS
`access-control-allow-origin: *`.

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | — | Liveness |
| GET | `/history` | — | Query stored fixes + laps |
| POST | `/ingest` | `X-Ingest-Key` | Device batch upload |
| OPTIONS | `*` | — | CORS preflight, `204` |
| any | known path, wrong method | — | `404 { ok:false, error:"not-found" }` |

Arbitrary unmatched paths never reach the function on the Pages deployment:
Pages falls back to `public/index.html` and returns the landing page with
`200`. The router's JSON `404` applies to a known path called with the wrong
method (for example `POST /health`).

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
| `device` | string | `esp32-01` | Device ID, truncated to 32 chars |
| `from` | integer (epoch sec) | now − 24 h | Start, inclusive |
| `to` | integer (epoch sec) | now | End, inclusive |
| `limit` | integer | `2000` | Clamped to 1–5000 |

`from` must be strictly less than `to`, otherwise:

```json
{ "ok": false, "error": "bad-window" }
```

### Response (200)

```json
{
  "ok": true,
  "device": "esp32-01",
  "from": 1700000000,
  "to": 1700086400,
  "count": 500,
  "total": 86400,
  "step": 173,
  "sampled": true,
  "maxGap": 2,
  "truncated": false,
  "points": [
    [1700000001, -6.200001, 106.800001, 45.2, 90.5, 0.8, 4.1, -2.1, 7]
  ],
  "laps": [
    [1700000123, 1, 45230, 44210]
  ]
}
```

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `ok` | boolean | Always true on success |
| `device` | string | Normalised device ID |
| `from`, `to` | integer | Echoed window (not clamped to data) |
| `count` | integer | Points returned |
| `total` | integer | Rows in the window before sampling |
| `step` | integer | Row step; `1` = every row |
| `sampled` | boolean | `step > 1` |
| `maxGap` | integer \| null | Largest gap in seconds inside the window |
| `truncated` | boolean | `step === 1 && count === limit` |
| `points` | array | Point tuples (see below) |
| `laps` | array | Lap tuples `[ts, n, dur_ms, best_ms]` |

### Point Tuple

`[ts, lat, lon, kmh, cog, hdop, roll, pitch, boot]`

| Idx | Field | Unit |
|-----|-------|------|
| 0 | `ts` | epoch seconds |
| 1 | `lat` | degrees |
| 2 | `lon` | degrees |
| 3 | `kmh` | km/h |
| 4 | `cog` | degrees |
| 5 | `hdop` | — |
| 6 | `roll` | degrees |
| 7 | `pitch` | degrees |
| 8 | `boot` | boot counter |

> When `total > limit`, the server picks one real row every `step` rows so the
> whole window is covered instead of returning only the oldest `limit` points.

---

## POST /ingest

The device batches queued fixes (40 frames / 8 KB, every 30 s).

```http
POST /ingest
Content-Type: application/json
X-Ingest-Key: <secret>
```

```json
{
  "device": "esp32-01",
  "frames": [
    {
      "seq": 1234, "ts": 1700000001, "up": 3600, "boot": 7,
      "fix": true, "lat": -6.200001, "lng": 106.800001, "alt": 120.4,
      "kmh": 45.2, "cog": 90.5, "hdop": 0.8, "sats": 8,
      "dist_m": 1520.4, "roll": 4.1, "pitch": -2.1,
      "lap_n": 1, "lap_last_ms": 45230, "lap_best_ms": 44210
    }
  ]
}
```

Frames may also be wrapped as `{"gps":{ "fix","lat","lng",... }}` — the worker
accepts both the flat device form and the nested live-MQTT form.

### Frame Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `seq` | number | **yes** | Monotonic frame counter |
| `up` | number | **yes** | Uptime seconds; `shape` error if missing |
| `ts` | number | **yes** | Epoch seconds > 0 |
| `boot` | number | no | Boot counter, default `0` |
| `fix` | boolean | no | `false`/missing frames are accepted but not stored |
| `lat`, `lng` | number | if fix | Range-checked |
| `kmh` | number | no | `0–150`, else `speed` |
| `cog` | number | no | Degrees |
| `hdop` | number | no | `0–8`, else `hdop` |
| `sats` | integer | no | Satellites used |
| `alt`, `dist_m` | number | no | Altitude m / odometer m |
| `roll`, `pitch` | number | no | IMU degrees |
| `lap_n` | integer | no | Lap number; a new value writes one lap row |
| `lap_last_ms`, `lap_best_ms` | integer | no | Lap duration / best |

### Frame Rejection Reasons

`shape`, `clock`, `stale-boot`, `stale-seq`, `range`, `speed`, `hdop`,
`teleport`, and `duplicate` (skipped, not counted as an error).

Rejected frames are reported in `rejected[]` as `{ "seq": n, "reason": "..." }`.
Because the device deletes a batch on any 2xx, one permanently bad frame cannot
jam the ring buffer.

### Response (200)

```json
{
  "ok": true,
  "received": 40,
  "stored": 38,
  "laps": 1,
  "duplicates": 1,
  "rejected": [{ "seq": 1235, "reason": "teleport" }],
  "retention": "skipped"
}
```

| Field | Description |
|-------|-------------|
| `received` | Frames in the request |
| `stored` | Rows written to D1 |
| `laps` | Lap rows written; `-1` = laps table missing (migration not applied) |
| `duplicates` | Frames skipped by `(boot, seq)` |
| `rejected` | `{seq, reason}` list |
| `retention` | `skipped`, a deleted-row count, or `error` |

### Errors

| Status | Body |
|--------|------|
| 400 | `{ "ok":false, "error":"bad-json" }` |
| 400 | `{ "ok":false, "error":"no-frames" }` |
| 401 | `{ "ok":false, "error":"unauthorized" }` |
| 413 | `{ "ok":false, "error":"body-too-large" }` (>64 KB) |
| 413 | `{ "ok":false, "error":"too-many-frames" }` (>120) |
| 503 | `{ "ok":false, "error":"ingest-key-not-set" }` |

---

## Storage Policy (D1)

| Rule | Detail |
|------|--------|
| Only valid fixes | `fix:false` frames are accepted but not stored |
| Moving (≥3 km/h) | Every frame (1 Hz) |
| Parked | 1 frame / 10 s |
| Speed gate | `> 150 km/h` rejected |
| HDOP gate | `> 8` rejected |
| Clock gate | −7 days … +1 hour |
| Teleport gate | distance > 1.5 × max speed × Δt + 20 m |
| Retention | 365 days, purged at most once a day from `ingest` |

---

## CORS

```http
access-control-allow-origin: *
access-control-allow-methods: GET, POST, OPTIONS
access-control-allow-headers: content-type, x-ingest-key
```

---

## Device Behavior

1. LittleFS ring buffer keeps fixes with a valid GPS position and clock.
2. Every 30 s (or 40 frames) the device sends a batch.
3. Any 2xx ack deletes the batch locally, even if some frames were rejected.
4. Network/TLS errors leave the buffer intact for the next cycle.

---

## Examples

```bash
# Last hour
curl "https://race-tracker-history.pages.dev/history?from=$(date -d '1 hour ago' +%s)&limit=200"

# Ingest
curl -X POST https://race-tracker-history.pages.dev/ingest \
  -H "Content-Type: application/json" \
  -H "X-Ingest-Key: $INGEST_KEY" \
  -d '{"device":"esp32-01","frames":[{"seq":1,"up":10,"ts":1700000001,"fix":true,"lat":-6.2,"lng":106.8,"kmh":45,"hdop":0.8}]}'
```

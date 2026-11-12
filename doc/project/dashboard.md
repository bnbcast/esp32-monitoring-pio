# Dashboard Architecture

## Overview

Single-page vanilla JS dashboard served statically from GitHub Pages.
- No build step, no bundler, no framework
- Loads in order: CSS → vendor → modules → `app.js`
- All state in `app.js`; modules export single objects/functions

---

## Module Load Order (from `index.html`)

```html
<!-- Styles -->
<link rel="stylesheet" href="css/tokens.css?v=53">
<link rel="stylesheet" href="css/base.css?v=53">
<link rel="stylesheet" href="css/components.css?v=53">
<link rel="stylesheet" href="css/layout.css?v=53">
<link rel="stylesheet" href="css/map.css?v=53">
<link rel="stylesheet" href="vendor/maplibre-gl.css?v=53">

<!-- Vendor -->
<script src="vendor/maplibre-gl-csp.js?v=53"></script>

<!-- Modules (dependency order) -->
<script src="ui/guard.js?v=53"></script>        // Operator lock
<script src="ui/map.js?v=53"></script>          // MAP object
<script src="ui/mqtt-mini.js?v=53"></script>    // MQTT client
<script src="ui/info-data.js?v=53"></script>    // Glossary data
<script src="ui/info.js?v=53"></script>         // INFO UI
<script src="ui/sessions.js?v=53"></script>     // History sessions
<script src="ui/charts.js?v=53"></script>       // Chart helpers
<script src="ui/mpu3d.js?v=53"></script>        // MPU 3D view
<script src="ui/app.js?v=53"></script>          // Main entry
```

---

## Module Exports

| Module | Export | Consumers |
|--------|--------|-----------|
| `guard.js` | `LOCK` object | `app.js` |
| `map.js` | `MAP` object | `app.js` |
| `mqtt-mini.js` | `MQTT` object | `app.js` |
| `info-data.js` | `INFO_INTRO`, `INFO_GROUPS` | `info.js`, `app.js` |
| `info.js` | `window.INFO.reveal()` | `app.js` |
| `sessions.js` | `SESSIONS` object | `app.js` |
| `charts.js` | `CHARTS` object | `app.js` |
| `mpu3d.js` | `MPU3D` object | `app.js` |
| `app.js` | — | (entry) |

---

## Data Flow (app.js)

```
MQTT message
    │
    ├─ ingestGPS(payload)
    │    ├─ Parse GPS, MPU, sys
    │    ├─ Update GPS object (circular buffers)
    │    ├─ Update pills (BROKER, DEVICE, MPU, GPS)
    │    ├─ Update HUD values
    │    ├─ MAP.updateMarker() + trail
    │    ├─ Update charts (if LIVE tab open)
    │    └─ Update MPU3D (if MPU tab open)
    │
    └─ renderBanner() (500ms interval)
         ├─ Compute status text
         ├─ Update brand state (DREAMING/LIVE/etc.)
         └─ Update pills
```

---

## Key Objects

### `GPS` (in app.js)
```js
{
  lastPoint: { lat, lng, kmh, cog, hdop, sats, ts },
  tiltHistory: [],    // last 120 pitch values
  trace: [],          // trail points {lng, lat, kmh, seg}
  maxSpeed: 0,
  movingTime: 0,
  stoppedTime: 0,
  elevGain: 0,
  elevLoss: 0
}
```

### `MAP` (from map.js)
```js
{
  create(containerId),
  loaded(),           // Promise → map ready
  updateMarker(lng, lat, heading, fix),
  updateTrail(points),
  setHistory(points),
  recenterNow(),
  setFollow(bool),
  setMeasureMode(bool),
  resize()
}
```

### `MPU3D` (from mpu3d.js)
```js
{
  draw(canvas, { roll, pitch, yaw, valid }),
  rotate(point, roll, pitch, yaw),
  project(point, scale)
}
```

### `CHARTS` (from charts.js)
```js
{
  autoMax(values, headroom),
  niceMax(max),
  bands(ctx, config),
  line(ctx, points, config),
  bar(ctx, data, config)
}
```

### `SESSIONS` (from sessions.js)
```js
{
  load(minutes),           // → Promise { sessions[], laps[] }
  select(index),           // Highlight one session
  exportHistory(format),   // 'gpx' | 'csv'
  toGpx(points, name),     // GPX 1.1 string
  toCsv(points)            // CSV string
}
```

---

## UI State

### Tabs
- `LIVE` — real-time HUD, charts, map
- `WIFI` — RSSI + heap chart, link stats
- `MPU` — 3D attitude, tilt chart, accel chart
- `HIST` — sessions timeline, laps, export, playback
- `INFO` — glossary (search, chips, expand)

### Bottom Sheet (mobile)
- 4 snap points: `collapsed` | `half` | `tall` | `full`
- Drag handle, tap toggle, keyboard arrows, persists `sheetSnap`
- Tab click reopens to last height

### Operator Lock
- Long-press `LOCKED` button → unlocks `operator-only` buttons
- Stored in `localStorage` (per browser)

---

## Charts

### LIVE Tab
- Speed line (180 frames) — red where HDOP > 3
- Stats: avg moving speed, stopped %, peak

### WIFI Tab
- RSSI (black) + free heap (red) — dual axis
- Link quality: strong/fair/weak (current RSSI)
- Msg rate (15s), max gap (60s)

### MPU Tab
- Accel magnitude |a| with 1g ref line
- Peak |a|, peak tilt
- Tilt chart (30° floor)

### HIST Tab
- View: Speed+Lean | HDOP | Lap vs Best
- Timeline: moving/stopped %, avg moving, max speed

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `C` | Recenter map |
| `M` | Toggle measure mode |
| `R` | Reset trip |
| `F` | Full-screen map |
| `Esc` | Exit full-screen / cancel measure |
| `↑/↓` | Step sheet snap (when handle focused) |

---

## Responsive Breakpoints

| Breakpoint | Layout |
|------------|--------|
| `> 900px` | Desktop: top bar \| map (flex) \| side panel |
| `≤ 900px` | Mobile: top bar, map (flex:1), bottom sheet |
| `≤ 520px` + short | Hide header wordmark, compact sheet |

---

## Performance

| Optimization | Implementation |
|--------------|----------------|
| Trail rendering | Single `LineString` + `line-gradient` (GPU) |
| Accuracy circle | Circle layer + geographic radius expression |
| Heading wedge | 4 vertices (was 8) |
| Vertex cap | 800 (decimate at 50%) |
| Pixel ratio | Capped at 2× |
| Resize debounce | 150ms + visualViewport listener |
| Chart repaint | Only on tab open + resize |

---

## Security (CSP)

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  script-src 'self';
  style-src 'unsafe-inline' 'self';
  manifest-src 'self';
  connect-src wss://broker.hivemq.com:8884 ws://localhost:5003 http://localhost:5003 https://race-tracker-history.pages.dev https://server.arcgisonline.com https://a.tile.openstreetmap.org https://b.tile.openstreetmap.org https://c.tile.openstreetmap.org https://nominatim.openstreetmap.org https://tiles.openfreemap.org;
  img-src 'self' data: blob: http://localhost:5003 https://server.arcgisonline.com https://a.tile.openstreetmap.org https://b.tile.openstreetmap.org https://c.tile.openstreetmap.org https://tiles.openfreemap.org;
  worker-src blob: 'self';
  base-uri 'none';
  form-action 'none'
">
```

- No inline scripts (`unsafe-inline` only for styles)
- MapLibre worker via blob URL (`vendor/maplibre-gl-csp.js`)
- All external connections explicitly listed
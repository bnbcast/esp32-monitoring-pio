# Project Structure

```
esp32-monitoring-pio/
├── .github/workflows/       # CI/CD (GitHub Pages deploy)
├── doc/                     # Documentation (this folder)
│   ├── api/                 # API reference
│   ├── project/             # Project structure docs
│   └── hardware/            # Hardware docs
├── dev/                     # Development tools
│   ├── check-*.mjs          # Browser probes (Playwright)
│   ├── make-*.ps1           # Asset generators
│   └── server.js            # Local dev server (simulator)
├── include/                 # C++ headers (shared)
├── lib/                     # Private libraries
├── src/                     # Firmware source
│   ├── main.cpp             # Entry point, env dispatch
│   ├── wifi_config.example.h # Bench template (copy to wifi_config.h, gitignored)
│   └── mqtt_simple/         # Single-WiFi MQTT variant
│       ├── mqtt_simple.h
│       ├── mqtt_simple.cpp  # Main firmware logic
│       ├── wifi_store.cpp   # Wi-Fi credentials in NVS (up to 4)
│       ├── wifi_store.h
│       ├── wifi_portal.cpp  # Captive setup portal (AP + HTTP + scan)
│       ├── wifi_portal.h
│       ├── history.cpp      # HTTPS batch upload (30s)
│       ├── history.h
│       └── history_secret.h # (gitignored) API keys
├── test/                    # Unit tests (node --test)
│   ├── *.test.js            # GPS, MPU3D, charts, sessions, Wi-Fi, etc.
│   ├── ui.test.js           # Static HTML/CSS/JS invariants
│   └── api-docs.test.js     # Interactive API tester invariants
├── web/                     # Dashboard (static site → GitHub Pages)
│   ├── index.html           # Single-page app
│   ├── manifest.webmanifest # PWA manifest
│   ├── api/docs/            # Interactive API tester (/api/docs)
│   ├── css/
│   │   ├── tokens.css       # Design tokens, colors, cursors
│   │   ├── base.css         # Base typography
│   │   ├── components.css   # Buttons, pills, panels
│   │   ├── layout.css       # Grid, mobile sheet, tooltip
│   │   └── map.css          # Map-specific styles
│   ├── ui/
│   │   ├── app.js           # Main dashboard logic
│   │   ├── map.js           # MapLibre integration
│   │   ├── charts.js        # Canvas chart helpers
│   │   ├── mpu3d.js         # 2D canvas 3D attitude view
│   │   ├── sessions.js      # History sessions, export
│   │   ├── info.js/.data.js # INFO tab glossary
│   │   ├── guard.js         # Operator lock
│   │   └── mqtt-mini.js     # MQTT client wrapper
│   ├── assets/              # Mascot PNG
│   ├── icons/               # Favicon/app icons (32–512)
│   └── vendor/              # MapLibre GL (CSP-safe)
├── worker/                  # Cloudflare Pages Function
│   ├── src/
│   │   ├── index.js            # API handlers (D1 + /live)
│   │   ├── mqtt-wire.js        # MQTT 3.1.1 packet codec
│   │   ├── live.js             # /live protocol state machine
│   │   └── live-tcp.js         # /live TCP transport (cloudflare:sockets)
│   ├── test/
│   │   ├── ingest.test.mjs     # ingest/history rules
│   │   └── live.test.mjs       # /live codec, relay and route rules
│   └── pages/
│       ├── functions/[[path]].js  # API router (allowlist)
│       ├── public/index.html       # Landing page
│       └── wrangler.toml           # Pages config
├── .gitignore
├── package.json             # Node deps, test scripts
├── package-lock.json
├── platformio.ini           # PlatformIO environments
└── README.md                # Project overview
```

---

## Key Modules

### Firmware (`src/mqtt_simple/`)

| File | Responsibility |
|------|----------------|
| `mqtt_simple.cpp` | WiFi state machine, MQTT, GPS (NEO-6M), MPU6050, 1 Hz publish |
| `wifi_store.cpp` | Versioned NVS blob: up to 4 SSID/password pairs, newest first |
| `wifi_portal.cpp` | Open setup AP, captive DNS, scan/save/forget page, deferred reboot |
| `history.cpp` | Ring buffer (LittleFS), 30s HTTPS batch to Pages |
| `history.h` | Config: URL, device ID, enable flag |

### Dashboard (`web/ui/`)

| File | Responsibility |
|------|----------------|
| `app.js` | Main: MQTT, tabs, sheet, HUD, banners, keyboard |
| `map.js` | MapLibre: trail, marker, accuracy, heading, replay |
| `charts.js` | Canvas helpers: lines, bars, bands, auto-max |
| `mpu3d.js` | 2D canvas 3D projection (board + chip boxes) |
| `sessions.js` | History sessions, timeline, laps, GPX/CSV export |
| `info.js` | Glossary UI (search, chips, expand) |
| `info-data.js` | Glossary content (69 terms, 8 groups) |
| `mqtt-mini.js` | Lightweight MQTT over WS client |
| `guard.js` | Operator lock (long-press) |

### History API (`worker/src/`)

| File | Responsibility |
|------|----------------|
| `index.js` | Routes, D1 ingest/history, `/live` handler |
| `mqtt-wire.js` | MQTT 3.1.1 CONNECT/SUBSCRIBE/PUBLISH bytes (pure) |
| `live.js` | CONNACK → SUBSCRIBE → retained PUBLISH state machine (no sockets) |
| `live-tcp.js` | One short-lived TCP session to HiveMQ via `cloudflare:sockets` |

### API tester (`web/api/docs/`)

| File | Responsibility |
|------|----------------|
| `index.html` | Static tester page, one card per endpoint |
| `app.js` | Request builder, fetch, status/timing/headers/body panel, curl preview |

The tester is static and outside `web/doc/`: it calls the base URL directly,
never proxies, and never embeds the ingest key. `Verify key` posts an empty
body so the auth check runs without writing a row.

### Styles (`web/css/`)

| File | Responsibility |
|------|----------------|
| `tokens.css` | Colors, shadows, cursors, midnight mode |
| `base.css` | Typography, monospace numbers |
| `components.css` | Buttons, pills, panels, lock, map-btns |
| `layout.css` | Grid, mobile sheet, tooltip, midnight overrides |
| `map.css` | Map controls, attribution |

---

## Data Flow

```
ESP32 (1 Hz)
    │
    ├─ MQTT → HiveMQ (wss) ──→ Dashboard (live tabs)
    │
    └─ HTTPS batch (30s) ──→ Cloudflare Pages Function ──→ D1
                                                      │
                                                      └─ GET /history ──→ Dashboard (HIST tab)
```

---

## Build & Deploy

| Target | Command | Output |
|--------|---------|--------|
| Firmware | `pio run -e esp32-mqtt-simple` | `.pio/build/.../firmware.bin` |
| Upload | `pio run -e esp32-mqtt-simple -t upload` | Flash via USB |
| Dashboard (local) | `npm run dev` | `http://localhost:5003/?dev` |
| Tests | `npm test` | 143 unit tests |
| Browser probes | `node dev/check-*.mjs` | Playwright screenshots |
| Dashboard (prod) | `git push` → GitHub Actions | `https://bnbcast.github.io/...` |
| API (prod) | `cd worker/pages && npx wrangler pages deploy` | `https://race-tracker-history.pages.dev` |

---

## Versioning

| Artifact | Version Location |
|----------|------------------|
| Dashboard assets | `?v=56` in `index.html` (all 21 refs) |
| Firmware | `FW_VERSION "1.5.0"` in `mqtt_simple.cpp` |
| MQTT client ID | `orion-<MAC>` at boot |
| API | No version (backwards compatible) |

---

## Key Invariants (enforced by tests)

- All assets share same `?v=` (`ui.test.js`)
- No camera/pitch/rotate buttons on map (`ui.test.js`)
- Phone basemap keeps all text labels (`ui.test.js`)
- Accuracy circle uploaded once per fix (`ui.test.js`)
- MPU3D math pure functions, testable under node (`mpu3d.test.js`)
- Dashboard calls `MPU3D.draw()` on tab open + resize (`ui.test.js`)
- Firmware image carries no Wi-Fi credential; NVS store dedupes and rolls back on a failed write (`wifi.test.js`)
- Only setup-AP clients can reach `/save` and `/forget`; a save reboots after the response (`wifi.test.js`)
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
│   └── mqtt_simple/         # Single-WiFi MQTT variant
│       ├── mqtt_simple.h
│       ├── mqtt_simple.cpp  # Main firmware logic
│       ├── history.cpp      # HTTPS batch upload (30s)
│       ├── history.h
│       └── history_secret.h # (gitignored) API keys
├── test/                    # Unit tests (node --test)
│   ├── *.test.js            # GPS, MPU3D, charts, sessions, etc.
│   └── ui.test.js           # Static HTML/CSS/JS invariants
├── web/                     # Dashboard (static site → GitHub Pages)
│   ├── index.html           # Single-page app
│   ├── manifest.webmanifest # PWA manifest
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
│   └── pages/
│       ├── functions/[[path]].js  # API router
│       ├── public/index.html       # Landing page
│       ├── src/index.js            # API handlers (D1)
│       ├── test/ingest.test.mjs    # API tests
│       └── wrangler.toml           # Pages config
├── .gitignore
├── package.json             # Node deps, test scripts
├── package-lock.json
├── platformio.ini           # PlatformIO environments
├── CMakeLists.txt           # (unused, legacy)
└── README.md                # Project overview
```

---

## Key Modules

### Firmware (`src/mqtt_simple/`)

| File | Responsibility |
|------|----------------|
| `mqtt_simple.cpp` | WiFi, MQTT, GPS (NEO-6M), MPU6050, 1 Hz publish |
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
| Tests | `npm test` | 115 unit tests |
| Browser probes | `node dev/check-*.mjs` | Playwright screenshots |
| Dashboard (prod) | `git push` → GitHub Actions | `https://bnbcast.github.io/...` |
| API (prod) | `cd worker/pages && npx wrangler pages deploy` | `https://race-tracker-history.pages.dev` |

---

## Versioning

| Artifact | Version Location |
|----------|------------------|
| Dashboard assets | `?v=53` in `index.html` (all 21 refs) |
| Firmware | `FW_VERSION "1.4.0"` in `mqtt_simple.cpp` |
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
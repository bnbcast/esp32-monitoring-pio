# AGENTS.md — esp32 PlatformIO project

## Build / Upload / Monitor

| Action | Command |
|---|---|
| Build MQTT | `pio run -e esp32-mqtt-simple` |
| Upload MQTT | `pio run -e esp32-mqtt-simple -t upload` |
| Monitor serial | `pio device monitor` |
| Clean | `pio run -t clean` |

## Build Environment

| Environment | Source | Description |
|---|---|---|
| `esp32-mqtt-simple` | `src/mqtt_simple/mqtt_simple.cpp` | Single Wi-Fi network MQTT (from `secret.txt` on GitHub) |

Publishes sensor JSON to `broker.hivemq.com` via MQTT:
- `esp32-dash/<TOPIC_KEY>/data` — sensor readings (retained)
- `esp32-dash/<TOPIC_KEY>/status` — online/offline (retained last will)

## Project Structure

```
src/
  main.cpp              # Entry point, dispatches to variant based on build flag
  mqtt_simple/
    mqtt_simple.h       # Declarations
    mqtt_simple.cpp     # MQTT implementation (single Wi-Fi network, from secret.txt)
include/                # Project headers
lib/                    # Private libraries
test/                   # Unit tests
web/
  index.html            # Browser dashboard frontend (neo-brutalist, no inline CSS)
  css/
    tokens.css          # Brutalist design tokens (flat colors, hard shadows, zero radius)
    base.css            # Resets, typography, monospace telemetry
    components.css      # Panels, buttons, pills, banner, status strip, readouts, leds
    layout.css          # Desktop grid + mobile bottom sheet
    map.css             # MapLibre overrides, map HUD, view badges, controls
  ui/
    app.js              # Dashboard JS: MQTT ingestion, ingestGPS(), renderData,
                        # renderBanner, view switch 2D/3D, tabs, controls, shortcuts
    map.js              # MapLibre GL JS module: base map, vehicle, heading fusion,
                        # my-location/compass, trail, accuracy circle, heading wedge
    mqtt-mini.js        # Tiny MQTT WebSocket client for browser
  vendor/               # Vendored maplibre-gl@3 (local, no CDN)
```

## Framework Notes

- Framework: **Arduino**
- Board: `esp32doit-devkit-v1`
- Main entry: `setup()` / `loop()` (Arduino style), dispatched from `main.cpp`
- Libraries: PubSubClient (MQTT), TinyGPSPlus (GPS)
- **Fix applied:** Copied `Network` library headers/sources into WiFi library src to resolve linker dependencies

## Secrets

Wi-Fi credentials and MQTT topic key are in the source file. Edit:
- `src/mqtt_simple/mqtt_simple.cpp` — WIFI_SSID, WIFI_PASS, TOPIC_KEY

## Testing

### Unit tests
Unit tests live in `test/`; run with `pio test`.

### Dev dashboard (no ESP32 required)
Test the web dashboard (3D GPS trace, elevation chart, trip computer, signal quality, compass) without hardware using the local dev server:

| Command | Purpose |
|---|---|
| `cd dev && npm install` | Install dev dependencies (one time) |
| `cd dev && npm start` | Start dev server at http://localhost:5003 |
| `http://localhost:5003/?dev&t=dev-test-1234` | Open dashboard with simulated GPS data |

The dev server (`dev/server.js`) speaks MQTT-over-WebSocket and publishes simulated telemetry on a circular route with varying speed, altitude, HDOP, and satellite count. The GPS simulator (`dev/server.js` embedded) runs automatically on server start.

**Without `?dev`**: the dashboard connects to `broker.hivemq.com` (real MQTT broker, requires ESP32 publishing).

**With `?dev`**: connects to `ws://localhost:5003/mqtt` and auto-uses topic key `dev-test-1234`.

## Web dashboard — neo-brutalist UI + Map (free, key-less)

The dashboard was refactored (6 stages) to a single neo-brutalist visual language:
flat solid colors, thick black borders, hard offset shadows, zero rounded corners,
no gradients/blur/glassmorphism. Single light theme, MapLibre 2D map only.

### UI structure
- Top bar: title, SIMULATED badge, status pills (broker/device/MPU/ACS/GPS),
  status strip (SAFE/WARNING/DANGER/NO SIGNAL)
- Desktop: map (left, ~2/3) + side panel tabs (right, ~1/3)
- Mobile: map full-width + bottom sheet with same tabs
- Map HUD: speed, heading, source, danger overlaid on the map

### Map & heading (unchanged data path)
- **Stack**: maplibre-gl@3 (vendored in `web/vendor/`, no CDN) + CartoDB Positron
  (light) raster basemaps — free, key-less, fast raster tiles.
  No Google Maps, no API keys, no terrain/DEM layer.
  CSP allows only: `wss://broker.hivemq.com:8884`, `ws://localhost:5003`,
  `basemaps.cartocdn.com`, `tiles.basemaps.cartocdn.com`.
- **Heading fusion** (`MAP.setVehicle` → `_fuseHeading`): GPS course when speed >3 km/h
  and HDOP ≤ 6; otherwise MPU6050 gyro (`yaw`) integrated from last GPS, with
  complementary drift pull-back toward GPS. Optional phone compass or `mag_heading`
  payload field. Source label + confidence exposed via `MAP.getHeading()`.
- **Controls**: my-location button (recenter/follow toggle), compass button
  (tap reset north, long-press lock north). Gestures drop to Free and resume tracking
  after a 3 s debounce. Keyboard: C=recenter, N=reset north, H=cycle heading source.
- **Simulator scenarios** (`SIM_SCENARIO` env): `normal` (default), `drift`
  (stopped + gyro), `dropout` (GPS loss), `wrap` (0/360 boundary).

### Testing the dashboard
`cd dev && npm start` → http://localhost:5003/?dev&t=dev-test-1234

Playwright check (`dev/debug-browser.js`): loads the dev URL, verifies key
DOM elements, asserts zero console errors. Chromium install:
`cd dev && npm install playwright && npx playwright install chromium`
(Headless screenshot capture may fail due to WebGL; element checks are the gate.)

### Verifying the deployed site (live)
Live URL: <https://bnbcast.github.io/esp32-monitoring-pio/> (GitHub Pages, built from
`web/` by `.github/workflows/deploy-pages.yml` on every push that touches `web/**`).

| Command | What it proves |
|---|---|
| `node dev/check-live.mjs` | Loads the live page, asserts broker connect, map canvas, zero JS errors / 4xx assets / CSP violations. Exit 1 = FAIL. |
| `node dev/check-live.mjs http://localhost:5003/?dev&t=dev-test-1234 0 8000` | Same gate against the local dev server. |
| `node dev/mqtt-watch.mjs <key> 60000` | Raw MQTT traffic without a browser. `live messages = 0` + retained `offline` status = broker fine, **device not connected**. |
| `C:/Users/User/.platformio/penv/Scripts/python.exe dev/serial-read.py COM4 20` | Prints 20 s of ESP32 serial log (needs COM4 free). |

Frontend facts that matter when debugging "no data":

- The page opens with **no key needed**: `DEFAULT_KEY` in `web/ui/app.js` matches the
  firmware `TOPIC_KEY`. A `#t=<key>` fragment (or `?t=` for the dev server) overrides it;
  a malformed fragment shows the setup form instead of silently falling back.
- The firmware publishes **every** reading with `retain=true`, so the retained flag does
  **not** mean "history". Liveness is therefore based on message arrival time
  (`STALE_AFTER_MS` = 6 s). Do not reintroduce a `!retained` check for `lastLiveAt`.
- The retained `status` topic carries the last will (`offline`), so `DEVICE OFFLINE` means
  the device's broker connection dropped and has not come back.

## Environment

- `.pio` directory contains build artifacts — do **not** commit.
- Edit `platformio.ini` to change environment, board, or framework.
- `dev/` contains the local development server — do **not** commit `dev/node_modules/`.

## Cross-Project Setup

### Browser Automation (Playwright + Puppeteer)

Located in `browser-automation/`. Persistent, headless browser automation with saved login state.

| Command | Purpose |
|---|---|
| `cd browser-automation && npm install` | Install deps (one time) |
| `npx playwright install chromium` | Install browsers (one time) |
| `STORAGE_STATE=auth/state.json HEADLESS=false npx playwright test save-login` | Log in once (headed), save session |
| `STORAGE_STATE=auth/state.json npx playwright test example` | Run headless with saved session |

### Dashboard

Open `web/index.html` in a browser, enter your topic key (e.g. `ea77aca95507194b8e46`), and view live sensor data from the MQTT broker.

### MCP Servers (global, reusable across projects)

Config: `~/.pi/agent/mcp-adapter.json`

Servers configured:
- `postgres` — Supabase via Supavisor pooler (IPv4, sslmode=disable)
- `github` — GitHub API
- `filesystem` — File system access
- `playwright` — Browser automation

### Skills

- `cline-sdk`, `playwright-browser`, `architecture-quest`, `product-quest`, `changelog-generator`, `ui-ux-principles`

## ESP32 Build Verified

`pio run -e esp32-mqtt-simple` completes successfully. Firmware builds to `.pio/build/esp32-mqtt-simple/firmware.bin`.

---

## UI Refactor — neo-brutalist (6 stages, committed)

| Stage | Description | Status |
|---|---|---|
| 0 | Read & inventory + propose file structure | Done |
| 1 | Brutalist design system (CSS tokens: flat colors, hard shadows, zero radius) | Done |
| 2 | Layout (desktop grid + mobile bottom sheet, status strip, HUD) | Done |
| 3 | 2D MAP view (MapLibre, vehicle, trail, heading, controls) | Done |
| 4 | 3D STREET view (removed — light map only) | Done |
| 5 | Polish & removal of old UI (deleted web/app.js, web/map.js, blueprint CSS) | Done |
| 6 | Playwright checks + docs update | Done |

All commits on `master` branch at `C:/Users/User/Documents/PlatformIO/Projects/esp32`.
Live data path unchanged: MQTT over WebSocket, `ingestGPS()`, `?dev&t=...`,
simulator, GPS + MPU6050 fields — no firmware/payload changes.

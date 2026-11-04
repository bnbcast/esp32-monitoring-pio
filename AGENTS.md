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
  index.html            # Browser dashboard frontend (from GitHub bnbcast/esp32-monitoring)
  app.js                # Dashboard JavaScript
  mqtt-mini.js          # Tiny MQTT WebSocket client for browser
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

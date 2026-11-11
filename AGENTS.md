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

## Serial console (firmware)

`pio device monitor` (COM4 @ 115200) prints one framed panel every 2 s plus event
lines as they happen. Every line is `[HH:MM:SS.mmm] LEVEL [TAG] message`, so a
capture can be grepped by level (`WARN|ERR`) or tag (`GPS|NET|MQTT|IMU|LAP|CAL`).

```
+------------------------------------------------------------------------------
| SYS   up 00:02:14.384   heap 212K   rssi -46 dBm   ch 6   ip 10.163.133.191
| LINK  wifi OK   mqtt OK   tx 426  ok 426  fail 0  drop 0  q 0
| GPS   NO FIX  used 0   view 0   snr 0   q 0  hdop 25.50  nmea 0s ago
| NMEA  2210 sent  0 bad  gga 551  rmc 551  gsa 551  gsv 557  other 0
| IMU   tilt  64.6  DANGER  roll 12.3  pitch -4.5  yaw 3.1  mpu OK
| POS   fix 3D    ttff 27s   rejected 0    hold no    lap 0  last --  best --
+------------------------------------------------------------------------------
  ! GPS  0 satellites in view - antenna / sky view, not the wiring
```

Keys (single byte, no Enter): `g` raw NMEA echo (on at boot), `v` verbose
(one line per publish), `c` colours, `p` panel, `r` yaw=0, `a` / `b` capture
finish-line ends, `l` clear the gate, `k` show it, `?` help.

`monitor_filters = log2file` tees the whole session to
`logs/device-monitor-<timestamp>.log`.

### GPS diagnostics

The firmware taps the raw UART (`GpsMon`) alongside TinyGPSPlus, because
TinyGPSPlus exposes only sanitised GGA/GSA/RMC fields and cannot tell "antenna
hears nothing" from "hears satellites but will not lock":

| Payload field | Source | Meaning |
|---|---|---|
| `gps.chars` | `gps.charsProcessed()` | bytes seen on RX; flat counter = module stopped sending |
| `gps.bad` | tap | NMEA checksum/length failures |
| `gps.view` | GSV field 3 | satellites **in view** (−1 = module sends no GSV) |
| `gps.snr` | GSV field 7 | best SNR in the current GSV cycle |
| `gps.q` | GGA field 6 | fix quality (0 none, 1 GPS, 2 DGPS) |
| `gps.sats` | GGA field 7 | satellites **used** (0 whenever there is no fix) |
| `gps.mode` | GSA field 2 | 1 none, 2 = 2D, 3 = 3D; only 3D is published |
| `gps.ttff_s` | firmware | seconds from boot to the first accepted fix |
| `gps.rej` | firmware | fixes dropped by the 200 km/h jump gate |
| `gps.still` | firmware | true while the parked hold is freezing the coordinate |

Reading it: `chars` climbing + `view 0` = receiver alive, antenna hears nothing;
`view 6` + `sats 0` = hears satellites, no lock yet; `chars` frozen = the module
stopped sending (power/contact), which the console reports as a `WARN`.

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
- Top bar: title, SIMULATED badge, status pills (broker/device/MPU/GPS),
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
- **Controls**: my-location button (recenter/follow, off while parked), measure
  A→B (M) and trip reset (0). The custom compass button was removed; MapLibre's
  own compass in the navigation control still resets north. Keyboard: C=recenter,
  M=measure, R=reset trip, Esc=clear measure.
- **Simulator scenarios** (`SIM_SCENARIO` env): `normal` (default), `drift`
  (stopped + gyro), `dropout` (GPS loss), `wrap` (0/360 boundary).

### Testing the dashboard
`cd dev && npm start` → http://localhost:5003/?dev&t=dev-test-1234

Playwright check (`dev/debug-browser.js`): loads the dev URL, verifies key
DOM elements, asserts zero console errors. Chromium install:
`cd dev && npm install playwright && npx playwright install chromium`
(Headless screenshot capture may fail due to WebGL; element checks are the gate.)

### Trip distance, A→B measuring, address

- **JARAK TEMPUH (HUD)** is measured from the drawn trail, client-side: every
  accepted point adds a haversine chord to `trailDistM` in [map.js](web/ui/map.js).
  A fix only counts if the jump since the previous one is physically possible for
  the reported speed (**physics gate**, e.g. 40 m in 0.5 s = 288 km/h is dropped),
  then the point must clear **3 m** while moving or **10 m** (grows with HDOP)
  while parked, confirmed by 2 resp. 3 consecutive readings. The drawn polyline is decimated (drop every
  other vertex at 1200 points) but the distance counter is *not*, so a long trip
  keeps 1-point resolution while the GeoJSON stays small.
- **Odometer (LIVE tab)** is the firmware `dist_m` counter; **Trail** is the
  browser session. They differ after a reload — the device keeps counting, the
  browser starts at zero. `R` (or the **0** button) resets the trail.
- **Measure A→B**: press `M` (or the **M** button), click two points, read the
  distance in the blue HUD badge. Click again to restart, `Esc` to leave.
- **Stationary:** below 0.6 km/h for 2.5 s the marker snaps to the last accepted
  point, its rotation freezes and the trail stops growing. No pulsing, no
  spinning emoji, no drift.
- **Address** under Position is reverse-geocoded from OSM Nominatim, keyless.
  It is deliberately conservative: min 8 s between calls, min 80 m of movement,
  skipped while the tab is hidden, cached per ~110 m cell in localStorage for 7
  days, and suspended for 10 min after a 403/429. CSP must keep
  `https://nominatim.openstreetmap.org` in `connect-src`.
- The vehicle marker is a **MapLibre Marker** (not a hand-positioned div), so it
  re-projects correctly on pan/zoom; a CSS transform transition would make it
  lag the map and is intentionally absent.

### GPS conditioning and lap timing

There is no current sensor in this build: the ACS712 was removed from the
firmware, the payload and the dashboard.

- **Parked hold:** below `GPS_STILL_KMH` (1.0 km/h) the published coordinate is
  frozen and only follows a real displacement over `GPS_HOLD_MOVE_M` (8 m), so
  multipath wander never reaches the map or the database.
- **Jump gate:** a fix that implies more than `GPS_MAX_KMH` (200 km/h) is dropped
  and counted in `gps.rej`.
- **Publish gate:** at least 5 satellites, HDOP ≤ 4 and a 3D fix. A 2D fix has
  no altitude constraint and is not published.
- **5 Hz:** at boot the firmware probes 9600, 38400 and 115200, then pushes UBX
  configuration into the module that answered: 38400 baud, 5 Hz, automotive
  model, static hold 0.5 m/s, SBAS, GGA/GSA/RMC every fix, GSV once a second,
  GLL/VTG/ZDA off. The configuration is then saved in the module (BBR + flash),
  so a power cycle restarts already at 5 Hz. With the TX pin (GPIO 33) unwired
  nothing changes: the probe finds no module and the link stays at 9600.
  GSA is kept because it is the only 2D/3D indicator TinyGPSPlus exposes, and
  GSV at 1 Hz because the dashboard shows satellites in view.
- **Static hold mask:** `CFG-NAV5` applies fields per bit. The static-hold
  threshold is bit 8 (0x0100); the earlier mask 0x0041 left it silently off.
- **Finish line:** the board stores two points captured over serial (`a`, `b`;
  `l` clears, `k` shows). A lap is the segment P0→P1 crossing A→B in the forward
  direction, timed by interpolating the crossing between the two fixes; laps
  under 3 s or 5 km/h are ignored. The dashboard draws the gate in red and the
  LIVE tab shows laps, last and best.

### UI details worth not breaking

- **Mobile** is a single non-scrolling column: top bar, map (`flex:1`), bottom
  sheet in normal flow (`height: 38dvh`). The sheet used to be `position: fixed`,
  which covered the bottom of the map; do not bring that back.
- **Parked** is decided from the spread of the last 6 s of fixes, not from the
  reported speed (a parked module reports 2-4 km/h). While parked: speed shows
  `0.0`, the trail and the marker freeze, and the camera never re-centres.
- **Odometer reset** is a browser-side offset over the firmware `dist_m`
  (localStorage `odoOffset`); it clears itself when the counter drops (reboot).
- **Favicon** is an inline SVG data URI in the theme colours - no extra request.

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

## Important: System Maintenance — Pi Session Purge Removed

**Do not recreate or re-enable the following:**

- **Removed scheduled task:** `PiSessionPurge` (Windows Task Scheduler, root path `\`)
  - Was running every 30 minutes, 24/7
  - Ran `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\Users\User\.pi\agent\bin\purge-sessions.ps1 -SessionRetentionMinutes 60 -LogRetentionDays 7`
  - **Effect:** Deleted Pi session transcripts older than 60 minutes and permission logs older than 7 days — causing sessions/config to disappear continuously
- **Removed PowerShell script:** `C:\Users\User\.pi\agent\bin\purge-sessions.ps1`
  - File deleted; no longer present in `.pi/agent/bin/`
- **OpenCode:** Searched `~/.config/opencode/`, `~/.opencode/`, `~/.cache/opencode/`, `~/.local/share/opencode/`, and desktop app data — **no equivalent purge/auto-cleanup scripts found** for OpenCode

**Current state:** Pi sessions and config now persist automatically. No background task is removing them. If you need session retention, it is now handled by normal operation only — no scheduled cleanup exists.

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

---

## What to Do Next (for the AI agent)

- The ESP32 firmware build is verified working (`pio run -e esp32-mqtt-simple`).
- The web dashboard refactor (6 stages) is complete and committed.
- Pi session purge has been removed — sessions/config will no longer be auto-deleted.
- No pending architectural or product decisions are blocking.
- If starting new work: check `MEMORY_INDEX.md` and any unfinished-task handoffs before planning.

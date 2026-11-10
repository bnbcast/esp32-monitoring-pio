# ESP32 Race Tracker

Live GPS/telemetry dashboard for one race vehicle.

- **Firmware:** `src/mqtt_simple/mqtt_simple.cpp` (classic ESP32, `esp32doit-devkit-v1`)
- **Dashboard:** static site in `web/`, deployed to GitHub Pages
- **Transport:** ESP32 → public HiveMQ (`broker.hivemq.com`) → dashboard over WSS
- **Live site:** https://bnbcast.github.io/esp32-monitoring-pio/

## Build and flash

```powershell
pio run -e esp32-mqtt-simple            # build
pio run -e esp32-mqtt-simple -t upload  # flash over COM4
```

## Dashboard

```powershell
npm run dev        # local broker + GPS simulator, http://localhost:5003/?dev
npm test           # unit tests for the live-frame gate and the INFO tab
npm run watch      # print raw MQTT traffic
npm run capture    # record 10 minutes of payloads to test/fixtures/
```

The **INFO** tab explains every value on screen without turning into a wall of
text: 73 terms in 9 collapsible areas, a search box, and one-term-at-a-time
definitions. Tapping any field label (HDOP, Max gap, ...) jumps straight to its
explanation. The wording lives in `web/ui/info-data.js`, so `test/info.test.js`
can fail when a panel shows a field the glossary does not explain, and
`node dev/check-info.mjs <url>` drives the real UI (search, chips, accordions,
label jump) at desktop and phone widths.

## Current state

See `docs/BASELINE.md` for measured numbers and `docs/PLAN.md` for the
simplified phase plan. The firmware publishes at 1 Hz; the dashboard validates
every live frame before it can touch the map.

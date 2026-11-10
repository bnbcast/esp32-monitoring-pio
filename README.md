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
npm test           # unit tests: live-frame gate, INFO glossary, UI/map invariants
npm run watch      # print raw MQTT traffic
npm run capture    # record 10 minutes of payloads to test/fixtures/
```

The **INFO** tab explains every value on screen without turning into a wall of
text: 75 terms in 9 collapsible areas, a search box, and one-term-at-a-time
definitions. Tapping any field label (HDOP, Max gap, ...) jumps straight to its
explanation. The wording lives in `web/ui/info-data.js`, so `test/info.test.js`
can fail when a panel shows a field the glossary does not explain, and
`node dev/check-info.mjs <url>` drives the real UI (search, chips, accordions,
label jump) at desktop and phone widths.

## On a phone

The map is the screen; the numbers fold away. Three controls sit on the map:

- **Target icon** - camera lock. Lit means the camera keeps the vehicle near the
  middle. Drag the map once and it releases; the choice is remembered in that
  browser.
- **Brackets icon** - full screen, for a map with no top bar and no panel.
  `Esc` or `F` leaves it.
- **Crosshair** - back to your own location.

The panel is a bottom sheet: tap or swipe the grip to fold it to the tab bar,
tap it again to open it, and picking a tab opens it too. Both the lock and the
folded sheet survive a reload. The page itself never scrolls - a downward swipe
scrolls the open panel and stops there, so it cannot trigger a browser refresh.

On a phone the basemap drops decorative fills (building footprints, airport
aprons and runways) and caps the drawing buffer at 2x. **Every text layer stays**,
so street names, districts and place names are unchanged; `node
dev/check-map-perf.mjs` fails if a label layer is hidden. See the measured
before/after in `docs/BASELINE.md`.

## Current state

See `docs/BASELINE.md` for measured numbers and `docs/PLAN.md` for the
simplified phase plan. The firmware publishes at 1 Hz; the dashboard validates
every live frame before it can touch the map.

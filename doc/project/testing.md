# Testing Documentation

## Overview

Three layers of testing ensure correctness without a device farm.

| Layer | Tool | Scope | Command |
|-------|------|-------|---------|
| Unit | Node `--test` | Pure functions, static invariants | `npm test` |
| Browser probes | Playwright | Real DOM, map, charts | `node dev/check-*.mjs` |
| Integration | Manual | Live MQTT + dashboard | `npm run dev` |

---

## Unit Tests (115 tests)

Run: `npm test`

### Test Files
| File | Focus |
|------|-------|
| `test/gps.test.js` | NMEA parsing, coordinate math |
| `test/mpu3d.test.js` | 3D rotation, projection math |
| `test/charts.test.js` | Canvas helpers (autoMax, bands, lines) |
| `test/sessions.test.js` | Session splitting, lap detection, GPX/CSV |
| `test/info.test.js` | Glossary content, search |
| `test/lap.test.js` | Lap gate logic, best-lap tracking |
| `test/led.test.js` | Danger LED state machine |
| `test/guard.test.js` | Operator lock logic |
| `test/ui.test.js` | Static HTML/CSS/JS invariants |

### Key Invariants (ui.test.js)
- All 21 asset refs share same `?v=` version
- No camera/pitch/rotate buttons on map
- Phone basemap keeps all text labels (buildings, streets, POIs)
- Accuracy circle uploaded once per fix
- MPU3D canvas has fixed 170px height
- Dashboard calls `MPU3D.draw()` on tab open + resize

---

## Browser Probes (Playwright)

Run individually:
```bash
node dev/check-playback.mjs      # Session replay + speed/lean chart
node dev/check-timeline.mjs      # Timeline chart (desktop + phone)
node dev/check-laps-export.mjs   # GPX/CSV export, lap markers
node dev/check-live-charts.mjs   # LIVE/WIFI/MPU charts + stats
node dev/check-orion.mjs         # Branding: title, mascot, icons, manifest
```

### Probe Architecture
1. Start throwaway HTTP server serving `web/`
2. Mock `race-tracker-history.pages.dev/*` → fixed JSON fixtures
3. Launch Chromium (1280×1000 desktop, 390×844 phone)
4. Wait for map ready (`MAP.isReady()`)
5. Interact (click tabs, scrub playback, export)
6. Assert visual state + screenshot
7. Fail on any console error or CSP violation

### Fixtures
Fixed JSON responses in each probe:
- 20 points with known values
- 2 laps with known times
- HDOP > 3 segments for red-line test

---

## Local Development Testing

```bash
# Start simulator + dashboard
npm run dev
# → http://localhost:5003/?dev&t=dev-test-1234

# Watch live MQTT traffic
npm run watch
# or
node dev/mqtt-watch.mjs

# Capture 10 min of real frames
npm run capture
# → test/fixtures/parked.jsonl
```

---

## CI (GitHub Actions)

| Workflow | Trigger | Steps |
|----------|---------|-------|
| `deploy-pages.yml` | push to main | Build → GitHub Pages deploy |
| `test.yml` | push/PR | `npm test` (Node 22) |

```yaml
# .github/workflows/test.yml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm' }
      - run: npm ci
      - run: npm test
```

---

## Adding a Test

1. Create `test/<name>.test.js`
2. Use `node:test` + `node:assert`
3. Run `npm test` → verify passes
4. If testing browser behavior → add probe in `dev/check-<name>.mjs`

---

## Debugging Failures

| Symptom | Likely Cause |
|---------|--------------|
| `SyntaxError: Invalid or unexpected token` | File has UTF-16 BOM (run `node -e "fs.writeFileSync('file', fs.readFileSync('file','utf16le'), 'utf8')"`) |
| `map never became ready` | MapLibre failed to load (network, CSP, missing vendor) |
| `accuracy circle uploaded twice` | `updateAccuracy` missing `key === accKey` guard |
| `building should be treated as decoration` | `HEAVY_LAYER` regex changed in `map.js` |
| `mixed asset versions` | `index.html` has mismatched `?v=` params |

---

## Coverage Goals

| Area | Target |
|------|--------|
| Pure math (rotate, project, chart helpers) | 100% |
| GPS parsing (NMEA, coordinate math) | 100% |
| Session logic (split, laps, export) | 100% |
| UI invariants (HTML/CSS static checks) | 100% |
| Browser probes (map, charts, playback) | 5/5 passing |
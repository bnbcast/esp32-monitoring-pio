# Dev Server — ESP32 Dashboard Testing

Local environment to test the web dashboard without ESP32 hardware.

## Quick Start

```bash
cd dev
npm install      # one time
npm start        # starts server at http://localhost:5002
```

Then open: **http://localhost:5003/?dev&t=dev-test-1234**

## What It Does

- Serves `web/` static files
- WebSocket MQTT broker at `ws://localhost:5003/mqtt`
- GPS simulator publishes circular-route telemetry every 200ms:
  - Lat/lng on a 100m radius circle (San Francisco center)
  - Altitude varying ±15m sinusoidally
  - Speed 5–25 km/h
  - Course-over-ground tangent to the circle
  - HDOP 0.8–3.0 (color-codes the 3D trace)
  - Satellite count 8–12
  - Occasional fix dropouts (~2%)
  - Cumulative odometer (device-side `dist_m`)

## Features You Can Test

| Panel | What to look for |
|---|---|
| [07] 3D GPS Trace | Rotating 3D line, red→green HDOP color, position cone |
| [08] Elevation Profile | Sinusoidal altitude vs. distance curve |
| [09] Trip Computer | Distance climbing, avg/max speed, elev gain/loss |
| [10] Signal Quality | HDOP, sats, fix status flickering |
| [11] Compass | Heading needle rotating with COG |
| Controls | Record/Pause, Replay, Clear, speed slider |

### [07] Map / Heading (free, key-less MapLibre + OpenFreeMap)
Toggle **BLUEPRINT ↔ MAP** at top-left of the panel.
- **MAP**: full-screen vector map (Liberty style default), vehicle dot + translucent view cone showing fused heading. Cone narrows with high confidence, widens when uncertain; greys out when stale (>2 s without a fix).
- **Heading sources (Auto default)**: GPS course when moving >3 km/h with good HDOP; otherwise MPU6050 gyro integrated from last GPS (drift pulled back to GPS). Optional phone compass (DeviceOrientation) or magnetometer (`mag_heading`) if present. Source label + confidence shown in the HUD and on the marker badge.
- **My-location button** (bottom-right): cycles Recenter → Follow → Compass → North-up. Panning/rotating drops to Free and shows Recenter (auto-resumes after 3 s).
- **Compass button** (bottom-right): tap resets North; long-press locks North.
- **Style** (top-right): CartoDB DARK (spectacle — neon roads on dark, ideal for racing telemetry) / LIGHT (daytime). Fast raster tiles, no API key.
- Keyboard: **C** = recenter, **N** = reset north, **H** = cycle heading source.
- **3D car** (Stage 3): an F1-style Three.js car rendered as a MapLibre custom layer, placed at the live fix, oriented by fused heading + MPU roll/pitch, and color-coded by danger level (cyan/yellow/red). It scales with the map zoom.
- **Basemap**: CartoDB Dark Matter (default) or Positron — free, key-less raster tiles. No terrain/DEM layer (removed; was 404ing and slow).

### Simulator heading scenarios (dev/server.js)
Set `SIM_SCENARIO` before starting the server to exercise the heading logic:
| Scenario | What it tests |
|---|---|
| (unset) `normal` | normal circular route, GPS course reliable |
| `drift` | car stopped (speed 0), MPU yaw keeps rotating → gyro drift hold |
| `dropout` | periodic GPS fix loss → stale / no-fix handling |
| `wrap` | heading sweeps across the 0/360 boundary → no 359→1 spin |

```bash
cd dev
SIM_SCENARIO=drift npm start     # gyro-drift scenario
SIM_SCENARIO=wrap  npm start     # 0/360 boundary scenario
```

## Files

- `server.js` — HTTP + WebSocket MQTT broker + GPS simulator
- `package.json` — Node dependencies (`ws`)

## Notes

- Do **not** commit `node_modules/` or `package-lock.json`.
- This is a development-only tool; not part of the firmware build.

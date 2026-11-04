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

## Features You Can Test

| Panel | What to look for |
|---|---|
| Status strip (top) | SAFE / WARNING / DANGER / NO SIGNAL + tilt, warn, danger |
| Status pills | Broker, Device, MPU, ACS, GPS state |
| Live tab (side panel) | Speed, altitude, sats, HDOP, fix, heading, tilt, amps, distance, max speed |
| Controls | Record/Pause, Replay, Clear, speed slider, units |
| LEDs | Blue (safe), White (warn), Red (danger) |
| Map HUD | Speed, heading, source, danger overlaid on the map |
| View toggle | 2D MAP ↔ 3D STREET (top bar + map buttons) |
| Theme toggle | Light ↔ Dark |

### Map / Heading (free, key-less MapLibre + CartoDB)
Two views switchable from the top bar:

**2D MAP**: full-screen CartoDB raster map (Dark Matter default / Positron light),
vehicle marker, speed-colored trail, accuracy circle, translucent heading wedge
(view cone ~ confidence). Map HUD shows speed / heading / source / danger.

**3D STREET**: Three.js street-view canvas with asphalt ground, road markings,
building blocks, and a dead-reckoned F1 car driven by GPS speed + fused heading.
Camera modes: Chase (behind), Driver (cockpit), Orbit (above). Keys: 1/2/3.

- **Heading sources (Auto default)**: GPS course when moving >3 km/h with good HDOP;
  otherwise MPU6050 gyro integrated from last GPS (drift pulled back to GPS).
  Optional phone compass or `mag_heading` if present. Source label + confidence
  shown in the HUD and heading badge.
- **My-location button** (bottom-right on map): cycles Recenter → Follow → Compass →
  North-up. Panning/rotating drops to Free and shows Recenter (auto-resumes after 3 s).
- **Compass button** (bottom-right on map): tap resets North; long-press locks North.
- **Style** (top-right on map): CartoDB DARK (spectacle — neon roads on dark) / LIGHT.
  Fast raster tiles, no API key.
- Keyboard: **C** = recenter, **N** = reset north, **H** = cycle heading source,
  **V** = toggle 2D/3D view, **1/2/3** = chase/driver/orbit street cam.
- **3D car** (Stage 3): F1-style Three.js car in the street-view canvas, oriented by
  fused heading + MPU roll/pitch, color-coded by danger level (green/yellow/red).
- **Basemap**: CartoDB Dark Matter (default) or Positron — free, key-less raster tiles.
  No terrain/DEM layer (removed; was 404ing and slow).

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

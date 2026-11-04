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

## Files

- `server.js` — HTTP + WebSocket MQTT broker + GPS simulator
- `package.json` — Node dependencies (`ws`)

## Notes

- Do **not** commit `node_modules/` or `package-lock.json`.
- This is a development-only tool; not part of the firmware build.

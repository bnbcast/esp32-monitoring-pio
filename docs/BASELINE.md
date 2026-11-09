# Baseline — measured facts

Recorded on branch `phase-a-baseline`, base commit `7c37e17`.
Anything marked **(board)** still needs the physical device on COM4.

## Build (verified locally)

```
pio run -e esp32-mqtt-simple      # after huge_app.csv + the history module
RAM:   16.3%  (53,280 / 327,680 bytes)
Flash: 40.6%  (1,275,912 / 3,145,728 bytes)
```

Before the partition change the same tracker used 79.8% of a 1.25 MiB slot.
With `huge_app.csv` there are **1.87 MB free** for TLS, the LittleFS ring
buffer and future code. The OTA slot is gone; USB flashing is the update path.
The history module costs ~230 KB of flash and ~1 KB of RAM at rest; the TLS
client is allocated only during a batch.

| Item | Value |
|---|---|
| PlatformIO | 6.2.0 |
| Framework | Arduino-ESP32 3.3.12 |
| Board | `esp32doit-devkit-v1`, 4 MB flash |
| Libraries | PubSubClient 2.8.0, TinyGPSPlus 1.1.0 |
| Serial | COM4, 115200 |

## Partition layout (from the Arduino core package)

`huge_app.csv`, **applied and flashed** (`board_build.partitions` in
`platformio.ini`):

| Partition | Size | Note |
|---|---|---|
| nvs | 20 KB | boot counter |
| otadata | 8 KB | |
| app0 | 3,145,728 B (3 MiB) | 33.3% used |
| spiffs | 917,504 B (896 KB) | LittleFS ring buffer target |
| coredump | 64 KB | |

**Decision:** approved by the owner. It triples application space and keeps
896 KB for the batch buffer, at the cost of the OTA slot that nothing uses.
Flashing the new table requires one USB reflash; done on 2026-11-09.

## TLS and ECDSA on the board (measured)

One-shot bench build (`pio run -e esp32-bench`), ESP32-D0WD-V3, RSSI -40,
`cloudflare.com:443` (the future Worker's front end):

| Measurement | Result |
|---|---|
| TLS connect, `setInsecure()` | 800 ms, 43.4 KB heap |
| TLS connect, built-in CA bundle | 1,731–1,981 ms, 42.6 KB heap |
| Peak transient | ~98 KB below the pre-connect free heap |
| Low-water free heap | 132,072 B (bench had 230 KB before) |
| ECDSA P-256 keygen | 163 ms |
| ECDSA P-256 sign | **174 ms** avg (20 runs), 72 B signature |
| ECDSA key heap | ~1 KB |

Consequences for W3:

- A 30 s batch fits comfortably: one handshake per batch, not per frame.
- Verification is affordable, so `setInsecure()` is not needed.
- **Never sign per frame.** 174 ms at 1 Hz is 17% of one core; one signature
  per 30 s batch is ~0.6% duty and still proves the whole batch.

## Transport

| Item | Value |
|---|---|
| Broker | `broker.hivemq.com` |
| Firmware port | 1883, **plain TCP, no TLS** |
| Dashboard port | 8884, WSS |
| QoS | 0 |
| Retained | yes, on both data and status |
| Publish cadence | 500 ms → **1000 ms** (changed on this branch) |
| Buffer | `mqtt.setBufferSize(2048)`, payload buffer 1200 B |
| Offline queue | 3 slots × 1024 B, oldest dropped |

Visible consequence: the live position is world-readable on a public broker,
and anyone can publish to the same topic. That is accepted (public data is
intended) and mitigated on the dashboard by `web/ui/guard.js`.

## Payload fields (as published today)

```
seq, ts (GPS epoch, 0 when unknown), up (uptime s), mpu,
roll, pitch, yaw, tilt, ax, ay, az, temp, lvl, warn, danger, maxTilt, peakA,
acs{ok, amps, v, zero},
gps{chars, view, snr, q, bad, sats, fix, lat, lng, alt, kmh, cog, hdop,
    dist_m, utc_h, utc_m, utc_s, utc_y, utc_mo, utc_d},
sys{heap, rssi, wifi{ssid, bssid, channel, status, ip, mac}}
```

Position is withheld entirely (`lat`/`lng` = `null`) unless sats ≥ 4 **and**
HDOP ≤ the configured gate. The gate moved from 20 to 8 on this branch.

## Dashboard

| Item | Value |
|---|---|
| Files | `web/index.html`, `web/ui/app.js`, `web/ui/map.js`, `web/ui/mqtt-mini.js`, `web/ui/guard.js` |
| MQTT client | custom, read-only; cannot publish |
| Stale threshold | 6 s (`STALE_AFTER_MS`) |
| Map | MapLibre 3.6.2 (local, `-csp` build), OpenFreeMap Liberty vector |
| Raster fallback | Esri World Street → Esri Topo → OSM tiles |
| Geocoding | public Nominatim, min 8 s and 80 m between calls, 110 m cache cells |
| CSP | present, `script-src 'self'`, no CDN |
| Tests | none before this branch |

## Secrets

| Secret | Location | Status |
|---|---|---|
| Wi-Fi password | `src/wifi_config.h` | in source and git history — burned |
| `TOPIC_KEY` | `mqtt_simple.cpp`, `web/ui/app.js` | **not a secret**; fixed slug `race-tracker` |
| `.env` | repo root | gitignored, AI provider keys |

`TOPIC_KEY` is now a readable default shared by firmware and dashboard, so a
fork works with no edits. It was never secret (it shipped in public JS); the
20-hex value only created a two-file edit. A second tracker changes that one
firmware line and opens the dashboard with `#t=<slug>`. The plausibility gate,
not the topic name, is the protection.

## Long-uptime diagnostics (published in `sys`)

| Field | Source | Use |
|---|---|---|
| `sys.heap` | `ESP.getFreeHeap()` at publish time | current headroom |
| `sys.heap_min` | lowest free heap seen since boot | catches a slow leak before it bites |
| `sys.boot` | `RTC_DATA_ATTR bootCount` | a rising value across sessions is a reboot loop |

The task watchdog is armed at the end of `mqtt_simple_setup()` with a 30 s
timeout, and `esp_task_wdt_reset()` runs at the top of `mqtt_simple_loop()`.
A hang therefore reboots the chip, and the next payload's `sys.boot` proves it.
The heap warning is logged once per boot below 40,000 bytes.

**Verified on the board** (flash 2026-11-09): boot without an IMU, `task
watchdog armed (30 s)`, `ready`, Wi-Fi + MQTT up, 1 Hz on the new topic, and
`heap_min` present in every frame. Over 7.5 minutes: `boot=1`, `seq=421`,
`heap=216120`, `heap_min=206456` — no reboot and no downward heap trend.

## History path on the board (measured)

Self-test build (`pio run -e esp32-history-test`, which adds `-DHISTORY_SELFTEST`),
continuous serial capture, `race-tracker-history.pages.dev`:

| Step | Observed |
|---|---|
| Mount + task start | `history ready: ...pages.dev/ingest, 0 B buffered, offset 0` |
| Enqueue | `self-test: 3 synthetic frames queued` |
| RAM buffer → flash | `stored 1` after the first 10 s flush, `stored 3` after the next |
| TLS + POST | `POST /ingest -> 200 in 3711 ms` |
| Ack + delete | `3 frames acked, queue 0 B` |
| Read back | `/history` returned all 3 points, `ts` ascending, `lat -6.9123` |

The request body is 3 × 161 B = 483 B, i.e. one TLS handshake per 30 s costs
~1.8 s of core time and ~43 KB of peak heap, matching the bench numbers. The
test rows were deleted from D1 afterwards.

The watchdog did not fire during the TLS handshake, confirming the history task
and the loop task coexist without a stall.

## Still needs the board

1. Real parked wander radius (lat/lon spread over 10 minutes).
2. One drive capture (route, speed, odometer).
3. A multi-hour soak with `sys.heap_min` and `sys.boot` logged.

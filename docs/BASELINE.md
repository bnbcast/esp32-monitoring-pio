# Baseline — measured facts

Recorded on branch `phase-a-baseline`, base commit `7c37e17`.
Anything marked **(board)** still needs the physical device on COM4.

## Build (verified locally)

```
pio run -e esp32-mqtt-simple
RAM:   16.0%  (52,368 / 327,680 bytes)
Flash: 79.6%  (1,043,980 / 1,310,720 bytes)
```

Only **266 KB** of the application slot is free. This is the single most
important constraint in the project: a TLS client plus ECDSA signing plus a
filesystem will not fit in the current layout.

| Item | Value |
|---|---|
| PlatformIO | 6.2.0 |
| Framework | Arduino-ESP32 3.3.12 |
| Board | `esp32doit-devkit-v1`, 4 MB flash |
| Libraries | PubSubClient 2.8.0, TinyGPSPlus 1.1.0 |
| Serial | COM4, 115200 |

## Partition layout (from the Arduino core package)

`default.csv`, currently active:

| Partition | Size | Note |
|---|---|---|
| nvs | 20 KB | unused today |
| otadata | 8 KB | |
| app0 | 1,310,720 B (1.25 MiB) | the build limit above |
| app1 | 1,310,720 B | OTA slot, **unused** (no OTA code exists) |
| spiffs | 1,441,792 B | unused today |
| coredump | 64 KB | |

`huge_app.csv` (not applied):

| Partition | Size |
|---|---|
| app0 | 3,145,728 B (3 MiB) |
| spiffs | 917,504 B (896 KB) |

**Recommendation:** switch to `huge_app.csv` before any TLS/storage work. It
triples the application space and keeps ~900 KB for a ring buffer, at the cost
of the OTA slot that nothing uses. It requires a USB reflash to take effect, so
it is left as a decision rather than applied silently.

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
| Wi-Fi password | `mqtt_simple.cpp:26` | in source and git history — burned |
| `TOPIC_KEY` | `mqtt_simple.cpp:36` | in source and git history — burned |
| `.env` | repo root | gitignored, AI provider keys |

Rotation is **not** done yet. It changes the public topic, so firmware and
dashboard must ship together.

## Still needs the board

1. Free heap with MQTT connected.
2. Free heap during one TLS handshake.
3. ECDSA P-256 sign time at 240 MHz.
4. Behaviour under a watchdog while doing TLS + MQTT + GPS.
5. Real parked wander radius (lat/lon spread over 10 minutes).

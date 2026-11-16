# Firmware Architecture

## Overview

Single-variant firmware (`esp32-mqtt-simple`) for classic ESP32 (`esp32doit-devkit-v1`).
- Framework: Arduino (PlatformIO)
- Transport: MQTT over TCP (`broker.hivemq.com:1883`); the browser dashboard uses `wss://broker.hivemq.com:8884/mqtt`
- Sensors: NEO-6M GPS (UART), MPU6050 (I2C)
- Storage: LittleFS ring buffer for history

---

## Build & Flash

```bash
# Build
pio run -e esp32-mqtt-simple

# Flash (auto-detects COM port)
pio run -e esp32-mqtt-simple -t upload

# Monitor serial (115200 baud)
pio device monitor
```

### PlatformIO Env

```ini
[env:esp32-mqtt-simple]
platform = espressif32
board = esp32doit-devkit-v1
framework = arduino
lib_deps =
    bblanchon/ArduinoJson@^7.0.4
    knolleary/PubSubClient@^2.8
    bblanchon/TinyGPSPlus@^1.0.3
build_flags =
    -D USE_MQTT_SIMPLE
    -D CORE_DEBUG_LEVEL=0
```

---

## Main Loop (non-blocking)

```
loop()
  ├─ gps read → NMEA parse → fix, lat, lng, alt, kmh, cog, hdop, sats
  ├─ MPU read → complementary filter → roll, pitch, yaw
  ├─ networkService() → wifiService() → MQTT reconnect/publish/queue drain
  ├─ publishData() at PUBLISH_INTERVAL_MS (1 Hz)
  │    ├─ MQTT publish → esp32-dash/<key>/data (retained)
  │    └─ historyEnqueue() when a valid fix + clock exists
  ├─ historyService() → HTTPS batch every 30 s
  └─ serial status panel every DASH_INTERVAL_MS
```

The loop never calls `delay()` for pacing: sensors, Wi-Fi, MQTT and history each
use `millis()` deadlines, so a TLS upload or a scan cannot stall the others.

---

## Key Components

### GPS (NEO-6M)
- UART2 (GPIO 16/17), 9600 baud
- TinyGPSPlus parser
- Outputs: fix, lat, lng, alt, speed (km/h), course, HDOP, satellites
- Cold start: 30–60s outdoors; warm start: ~5s

### MPU6050
- I2C (GPIO 21/22), 400 kHz
- Accel ±2g, Gyro ±250°/s
- Complementary filter (0.98 gyro / 0.02 accel) for roll/pitch
- Yaw = integrated gyro Z (drifts, no magnetometer)
- Self-test on boot; fails → MPU FAIL pill

### MQTT Client
- PubSubClient over `WiFiClientSecure`
- CA cert: HiveMQ root (embedded)
- Client ID: `orion-<MAC>` (e.g., `orion-A1B2C3D4`)
- Topics: `esp32-dash/<key>/data`, `esp32-dash/<key>/status`
- LWT: `offline` on `.../status` (retained); `online` is published retained on connect
- Reconnect: exponential backoff (2s, 4s, 8s, max 30s)

### Wi-Fi Reconnect Behavior
The network stack is a non-blocking state machine (`WF_IDLE` → `WF_SCANNING` → `WF_CONNECTING`) driven from `networkService()`:

- Boot starts an **async scan** (never blocks the GPS/IMU loop).
- Candidates live in `src/wifi_config.h`; exact SSID match wins, then prefix match.
- After one success the AP is cached (`lastGoodNet`) so reconnects skip the scan.
- If the scan shows no configured SSID, each candidate is tried **directly, round-robin**. This covers hidden APs and scan misses.
- A cached AP that times out **3 times** is dropped and a rescan is forced, so a hotspot that moved or was renamed cannot pin the device forever.
- Association timeout uses `WiFi.disconnect(false)` so the radio stays up (the old `true` powered the station down and made retries look like flapping).
- Modem sleep is disabled (`WiFi.setSleep(false)`) for low-latency telemetry.
- Every scan logs each visible SSID with RSSI/channel, which distinguishes "wrong SSID" from "dead radio".

> If the log shows `best candidate=none`, the configured SSID is simply not in range. Add the correct **2.4 GHz** SSID/password to `src/wifi_config.h` and reflash; 5 GHz-only APs are invisible to the ESP32.


### History Ring Buffer (LittleFS)
- File: `/history.bin` (fixed-size, ~200 KB)
- Format: binary, fixed-record (36 bytes/frame)
- Only frames with `gps.fix=true` stored
- Moving (≥3 km/h): every frame (1 Hz)
- Parked: 1 frame / 10 s
- Batch upload: 30s or 120 frames → HTTPS POST /ingest
- On 2xx: delete batch (even if server rejected some)
- Max ~9M frames/year (fits 5 GB D1 free tier)

---

## Configuration (compile-time)

| Define | Default | Description |
|--------|---------|-------------|
| `TOPIC_KEY` | `"race-tracker"` | MQTT topic suffix |
| `FW_NAME` | `"orion"` | Firmware name in banner |
| `FW_VERSION` | `"1.4.0"` | Firmware version |
| `PUBLISH_INTERVAL_MS` | `1000` | Publish cadence (ms) |
| `HISTORY_URL` | `""` | Pages Function URL (from `history_secret.h`) |
| `HISTORY_KEY` | `""` | Ingest key (from `history_secret.h`) |
| `HISTORY_DEVICE` | `"esp32-01"` | Device ID in D1 |

### Secrets (`src/mqtt_simple/history_secret.h` — **gitignored**)
```cpp
#define HISTORY_URL "https://race-tracker-history.pages.dev/ingest"
#define HISTORY_KEY "your-ingest-key-here"
```

---

## Serial Output (115200 baud)

```
orion 1.4.0
WiFi: connected (SSID) RSSI -52 dB
MQTT: connected to broker.hivemq.com
MPU: OK (roll=0.1 pitch=-0.2)
GPS: waiting for fix...
[1700000001] GPS FIX lat=-6.200001 lng=106.800001 kmh=45.2 sats=8 hdop=0.8
[1700000002] GPS FIX lat=-6.200002 lng=106.800003 kmh=46.1 sats=8 hdop=0.7
History: uploaded 120 frames (2xx)
```

---

## Status Pills (from firmware → dashboard)

| Pill | Source | Values |
|------|--------|--------|
| BROKER | MQTT conn state | OK / ... / OFFLINE |
| DEVICE | `online` field in status topic | LIVE / OFFLINE / NO SIGNAL |
| MPU6050 | Self-test + valid data | OK / FAIL |
| GPS | `gps.fix` + HDOP | FIX / WAIT / NO FIX |

---

## Memory Map (approx)

| Region | Size |
|--------|------|
| Flash (code + rodata) | ~1.3 MB / 3.1 MB (41%) |
| RAM (static + heap) | ~53 KB / 320 KB (16%) |
| LittleFS (history) | 200 KB |
| WiFi + MQTT buffers | ~40 KB |

---

## OTA

**Explicitly out of scope.** Firmware updates require USB flash.
- Reason: single device, no fleet, public broker cannot push OTA
- If needed: `pio run -t upload` via USB
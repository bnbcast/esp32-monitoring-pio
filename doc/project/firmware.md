# Firmware Architecture

## Overview

Single-variant firmware (`esp32-mqtt-simple`) for classic ESP32 (`esp32doit-devkit-v1`).
- Framework: Arduino (PlatformIO)
- Transport: MQTT over TCP (`broker.hivemq.com:1883`); the browser dashboard uses `wss://broker.hivemq.com:8884/mqtt`
- Sensors: NEO-6M GPS (UART), MPU6050 (I2C)
- Storage: LittleFS ring buffer for history; Wi-Fi credentials in NVS
- Provisioning: phone-friendly setup portal, no SSID or password in the image

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
platform = espressif32@8.0.0
board = esp32doit-devkit-v1
framework = arduino
lib_deps =
    knolleary/PubSubClient@2.8
    mikalhart/TinyGPSPlus@1.1.0
build_flags = -DUSE_MQTT_SIMPLE
```

`WebServer` and `DNSServer` come from the Arduino core, so the setup portal
adds no dependencies. `lib_ignore = Networking` keeps the duplicate Network
headers that core 3.3.12 ships inside `WiFi/src` from clashing with the
standalone copy `WebServer` would otherwise pull in.

---

## Main Loop (non-blocking)

```
loop()
  ├─ gps read → NMEA parse → fix, lat, lng, alt, kmh, cog, hdop, sats
  ├─ MPU read → complementary filter → roll, pitch, yaw
  ├─ networkService() → wifiPortalLoop() → wifiButtonService() → wifiService()
  │                    → MQTT reconnect/publish/queue drain
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
- A failed connect logs the resolved broker IP (or an explicit DNS failure)
  and the state by name, e.g. `connect failed (state=-4, timeout)`. A bare
  `-4` cannot tell a dead DNS from a filtered port 1883, and that difference
  sends you to the wrong layer.

### Wi-Fi Provisioning (NVS + setup portal)

No SSID or password is compiled into the tracker. A real credential in the
public repository is a permanent leak, so the board is provisioned from a phone
and the list lives in NVS.

- **Storage**: up to 4 networks in the `wifi` NVS namespace, written as one
  versioned blob (`wifi_store.cpp`). Newest first; saving the same SSID replaces
  the old entry instead of duplicating it; the oldest is dropped when full. An
  empty password means an **open** network.
- **First boot after flashing**: the list is empty, so the setup AP opens
  immediately. It is open (`Orion-Setup-XXXX`, last four hex digits of the MAC)
  and serves the page at `http://192.168.4.1/`. Captive-portal probes redirect
  to it, so a phone usually offers the sign-in sheet by itself.
- **Saved list, no association**: if no saved network connects within 45 s, the
  portal opens. This also covers a moved venue or a changed hotspot password.
- **Page**: scan list (2.4 GHz only; hidden networks can be typed), SSID field,
  password field (leave empty for open), saved-network list with **Forget**.
  Passwords are never rendered back into the page.
- **Save**: validated in the handler, written to NVS, then the board reboots
  1.5 s after the response so the saved page can leave the socket. If the join
  fails, the portal returns on the next boot.
- **Runtime trigger**: serial `w` or hold **BOOT/GPIO0 for 3 s**. The AP is
  started in `WIFI_AP_STA`, so a portal opened while the tracker is online does
  not cut MQTT. A portal opened automatically while offline closes as soon as
  the station reconnects; one opened manually is left alone.
- **Safety**: `/save` and `/forget` accept only clients whose connection arrived
  on the setup-AP address, so a portal left open cannot be edited from the
  venue LAN.
- **Bench build only**: `src/wifi_config.h` still exists as a gitignored
  compile-time list for the one-shot `esp32-bench` environment. Copy
  `src/wifi_config.example.h` when you need it. A fresh clone builds without it.

Step-by-step instructions for the person at the track are in
[wifi-setup.md](wifi-setup.md).

### Wi-Fi Reconnect Behavior
The network stack is a non-blocking state machine (`WF_IDLE` → `WF_SCANNING` → `WF_CONNECTING`) driven from `networkService()`:

- Boot reads the NVS list; a non-empty list starts an **async scan** (never blocks the GPS/IMU loop).
- Candidates come from NVS; exact SSID match wins, then prefix match.
- After one success the AP is cached (`lastGoodNet`) so reconnects skip the scan.
- If the scan shows no saved SSID, each candidate is tried **directly, round-robin**. This covers hidden APs and scan misses.
- A cached AP that times out **3 times** is dropped and a rescan is forced, so a hotspot that moved or was renamed cannot pin the device forever.
- Association timeout uses `WiFi.disconnect(false)` so the radio stays up (the old `true` powered the station down and made retries look like flapping).
- Modem sleep is disabled (`WiFi.setSleep(false)`) for low-latency telemetry.
- Every scan logs each visible SSID with RSSI/channel, which distinguishes "wrong SSID" from "dead radio".

> If the log shows `best candidate=none`, the saved SSID is simply not in range. Open the portal (`w` or hold BOOT) and add the correct **2.4 GHz** network; 5 GHz-only APs are invisible to the ESP32.


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
| `FW_VERSION` | `"1.5.0"` | Firmware version |
| `PUBLISH_INTERVAL_MS` | `1000` | Publish cadence (ms) |
| `WIFI_TX_POWER` | `WIFI_POWER_15dBm` | Radio TX power; lower peak current for battery/boost supplies |
| `WIFI_STORE_MAX` | `4` | Saved networks in NVS (`wifi_store.h`) |
| `WIFI_PORTAL_AFTER_MS` | `45000` | Open the setup portal after this long without a saved link |
| `WIFI_BOOT_PIN` | `0` | GPIO0 / BOOT button |
| `WIFI_BOOT_HOLD_MS` | `3000` | Hold time that opens or closes the setup portal |
| `HISTORY_URL` | `""` | Pages Function URL (from `history_secret.h`) |
| `HISTORY_KEY` | `""` | Ingest key (from `history_secret.h`) |
| `HISTORY_DEVICE` | `"esp32-01"` | Device ID in D1 |
| `LAP_AUTO_KMH` | `5.0` | Speed that can arm an automatic finish line |
| `LAP_AUTO_HOLD_MS` | `5000` | Sustained motion required before arming |
| `LAP_AUTO_HALF_M` | `15.0` | Half-width of the automatic line (30 m gate) |
| `LAP_AUTO_KEEP_M` | `500.0` | Boot further than this drops a stored auto gate |
| `LAP_AUTO_STOP_MS` | `180000` | A stop this long re-arms the line if motion resumes elsewhere |
| `LAP_GEN_BASE` | `1000000` | First session generation; above any boot counter |

### Secrets (`src/mqtt_simple/history_secret.h` — **gitignored**)
```cpp
#define HISTORY_URL "https://race-tracker-history.pages.dev/ingest"
#define HISTORY_KEY "your-ingest-key-here"
```

Wi-Fi is not a compile-time secret. `src/wifi_config.h` is gitignored and used
only by the `esp32-bench` environment; the tracker provisions itself through
the portal described above.

---

## Lap Timing

The board counts laps; the dashboard only mirrors the result.

- **Manual gate**: serial `a` at one end of the line and `b` at the other, both captured from the current fix. `k` prints the stored gate and counters, `l` clears it.
- **Auto-arm**: with no gate stored (and no manual capture in progress), the first motion above 5 km/h sustained for 5 s arms a line through the launch fix, perpendicular to the heading, 30 m wide. The lap clock starts at that launch fix, so the first return crossing times lap 1 rather than only arming the gate.
- **Persistence**: both kinds of gate live in NVS. A stored auto line is dropped when the first fix after boot is more than 500 m away (a different track), or after a stop of 3 minutes or more followed by motion more than 500 m away (powered transport to another venue). Manual gates are never dropped.
- **Counting**: the segment between two accepted fixes must cross A→B forward, above 5 km/h, at least 3 s after the previous crossing. The crossing time is interpolated inside the segment.
- **Payload**: `lap.on` (armed), `lap.auto` (came from auto-arm), `lap.n`, `lap.gen`, `lap.last_ms`, `lap.best_ms`, `lap.la`/`lb`. History rows carry `lap_n`, `lap_last_ms`, `lap_best_ms` and `lap_gen` so the server can log one row per completed lap. `lap_gen` is the session generation: it survives a reboot, so the board saying "lap 5" again after a reset does not write a duplicate row, and it increments whenever the counters start over. It starts at 1000000, above any boot counter, so it cannot collide with laps the server logged before the field existed.

---

## Serial Output (115200 baud)

```
 orion 1.5.0
 reset power-on   mac AA:BB:CC:DD:EE:FF   boot #274   brownouts 0
 SYS ready - orion 1.5.0
 wifi  1 saved network(s) in NVS   setup: hold BOOT 3 s or press w
 NET connected 'Track-Hotspot'  ip=192.168.1.50  rssi=-37 dBm  ch=1  (slot 0)
 MQTT session up, status=online (retained)
 IMU MPU6050 at 0x68  gyro bias 0.21/0.61/0.20 dps
 GPS waiting for fix...
 HIST ON  queued 0  stored 0  sent 0  fail 0
```

When no saved network is in range, the panel gains an actionable line instead
of leaving the cause implicit:

```
  ! NET  setup portal 'Orion-Setup-B9F0' open - join it and open http://192.168.4.1/
```

---

## Status Pills (from firmware → dashboard)

| Pill | Source | Values |
|------|--------|--------|
| BROKER | MQTT conn state | OK / ... / OFFLINE |
| DEVICE | `online` field in status topic | LIVE / OFFLINE / NO SIGNAL |
| MPU6050 | Self-test + valid data | OK / FAIL (page adds RECOVERING for a short gap) |
| GPS | `gps.fix` + HDOP | FIX / WAIT / NO FIX |

The boot banner also reports `reset <reason>` and `brownouts N` (persisted in
NVS, also published as `sys.brown`). A rising count means the supply is sagging;
see the power section in `hardware/schematic.md`. The I²C bus is re-initialised
after five consecutive MPU read failures, so a rail glitch does not leave the
sensor stuck in FAIL until the next reboot.

`sys.temp_c` carries the ESP32 **die** temperature from `temperatureRead()`,
sampled once per publish (full and slim payloads). It is uncalibrated on the
classic ESP32, so use it as a relative chip-heating signal, not ambient or
engine temperature.

An I2C NACK is debounced: `mpuValid` stays true for a 2-second
`MPU_FAULT_GRACE_MS` window and the last attitude keeps being published. Only a
fault that outlives the window flips the payload to `mpu:false` and starts the
all-three-LED fault blink. Bus recovery is rate-limited to once every two
seconds so a genuinely dead sensor cannot flood the serial log.

---

## Memory Map (approx)

| Region | Size |
|--------|------|
| Flash (code + rodata) | ~1.38 MB / 3.1 MB (44%) |
| RAM (static + heap) | ~54 KB / 320 KB (17%) |
| LittleFS (history) | 200 KB |
| WiFi + MQTT buffers | ~40 KB |

---

## OTA

**Explicitly out of scope.** Firmware updates require USB flash.
- Reason: single device, no fleet, public broker cannot push OTA
- If needed: `pio run -t upload` via USB
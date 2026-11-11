# Plan B — Convert Tracker Firmware to ESPHome (Detailed)

**Project:** ESP32 EV distance tracker  
**Goal:** Move firmware from PlatformIO + Arduino to ESPHome while keeping the dashboard unchanged, and add JK-BMS over BLE via `syssi/esphome-jk-bms`.  
**Constraint:** Single ESP32 (`esp32doit-devkit-v1`, classic). Dashboard must not change.  
**Status:** Pre-implementation. Do not write firmware yet. Review required.

---

## 1. Codebase Audit

### 1.1 Source files (firmware)

| Path | Size | Responsibility |
|------|------|----------------|
| `src/main.cpp` | 750 B | Build-flag dispatcher. Routes to `mqtt_simple_setup/loop` under `USE_MQTT_SIMPLE`. No logic of its own. |
| `src/mqtt_simple/mqtt_simple.cpp` | 16,250 B | **Monolith.** Wi-Fi, MQTT (PubSubClient), GPS (TinyGPSPlus), MPU6050 (I2C), odometer (Haversine), lap gate, LED patterns, JSON publisher, serial commands, status logging. |
| `src/mqtt_simple/mqtt_simple.h` | 121 B | Two function declarations only. |

**Verdict confirmed:** The firmware is effectively **one source file** (`mqtt_simple.cpp`) plus a dispatcher (`main.cpp`). There is no separate `testno3.ino` or other variant present in the repo (the failover branch in `main.cpp` is dead code referencing a missing file).

### 1.2 Web/dashboard files

| Path | Size | Responsibility |
|------|------|----------------|
| `web/index.html` | ~14.9 KB | Dashboard shell. Neo-brutalist UI. |
| `web/css/tokens.css` | ~1.4 KB | Design tokens (flat colors, hard shadows). |
| `web/css/base.css` | ~1.8 KB | Resets, typography, monospace telemetry. |
| `web/css/components.css` | ~6.2 KB | Panels, buttons, pills, banner, status strip, readouts, LEDs. |
| `web/css/layout.css` | ~6.1 KB | Desktop grid + mobile bottom sheet. |
| `web/css/map.css` | ~2.9 KB | MapLibre overrides, map HUD, view badges. |
| `web/ui/app.js` | ~22.5 KB | **MQTT consumer.** Subscribes to `esp32-dash/<KEY>/data` + `/status`. `validData()` contract, `renderData()`, MapLibre integration. |
| `web/ui/map.js` | ~15.6 KB | MapLibre vehicle, trail, heading fusion, controls. |
| `web/ui/mqtt-mini.js` | ~5.7 KB | Tiny browser MQTT-over-WebSocket client (read-only). |
| `web/vendor/maplibre-gl.js` | ~762.7 KB | Vendored MapLibre GL JS (no CDN). |
| `web/vendor/maplibre-gl-csp.js` | ~694.1 KB | Vendored MapLibre CSP build. |
| `web/vendor/maplibre-gl-csp-worker.js` | ~338.6 KB | MapLibre worker. |
| `web/vendor/maplibre-gl.css` | ~63.7 KB | MapLibre CSS. |

**Verdict:** 1 HTML + 6 CSS + 3 JS (app.js, map.js, mqtt-mini.js) + 4 vendored MapLibre files. The dashboard is **browser-side only** — not served by the ESP32. It must keep working unchanged.

### 1.3 Features to port (inventory)

| # | Feature | Current implementation | ESPHome equivalent / custom? |
|---|---------|----------------------|------------------------------|
| 1 | Wi-Fi connect + auto-reconnect | `WiFi.begin`, `setAutoReconnect` | `wifi:` component |
| 2 | MQTT publish (retained, QoS 0) | PubSubClient to `broker.hivemq.com:1883` | `mqtt:` component + `mqtt.publish_json` |
| 3 | MQTT status + LWT ("online"/"offline") | `mqtt.connect(... will ...)` + publish "online" | `mqtt: birth_message`, `will_message` |
| 4 | GPS parsing (NMEA) | `HardwareSerial(2)` GPIO25 @9600 + TinyGPSPlus | `uart:` + `gps:` component |
| 5 | Odometer (Haversine, cumulative meters) | `haversineM()` in `loop()` | Lambda + `globals:` (custom) |
| 6 | MPU6050 init (address scan 0x68/0x69, wake, LPF, ranges) | `Wire` I2C GPIO21/22 | `i2c:` + `mpu6050:` gives raw only |
| 7 | Gyro bias calibration (500 samples @ 4 ms) | `setup()` blocking loop | Custom C++ lambda / `button:` trigger |
| 8 | Roll/pitch/yaw fusion (complementary, ALPHA=0.98) | `updateMotion()` in `loop()` | **Custom C++** — no ESPHome equivalent for fused attitude |
| 9 | Tilt = max(|roll|, |pitch|), warn/danger with hysteresis | `updateLevel()`, `setLeds()` | Lambda + `output:`/`binary_sensor:` |
| 10 | `r` serial reset yaw command | Serial 'r' in `loop()` | `button:` entity or logger hook |
| 11 | JSON publisher (500 ms, retained, 800-byte buffer) | `publishData()` `snprintf` to 800-byte buffer | `mqtt.publish_json` from `interval:` lambda |
| 12 | Status LEDs (blue/white/red, solid + fast/slow blink) | `digitalWrite` patterns in `loop()` | `output:` + lambda or `light:` |
| 13 | Sys block (heap, uptime, RSSI) | `ESP.getFreeHeap()`, `millis()`, `WiFi.RSSI()` | Lambda reading `system.uptime`, `wifi.rssi`, heap |
| 14 | Serial debug status line (every 2 s) | `printStatus()` | ESPHome `logger:` (different format) |

### 1.4 Exact JSON schema (compatibility contract)

The dashboard `validData()` in `web/ui/app.js` requires:

```json
{
  "tilt": number,       // required, finite
  "roll": number,       // required, finite
  "pitch": number,      // required, finite
  "yaw": number,        // required, finite
  "lvl": number,        // required, 0..2 integer
  "warn": number,       // required, finite
  "danger": number,     // required, finite
  "gps": {              // required object
    "sats": number,     // required, finite
    "lat": number,      // required, finite (when fix)
    "lng": number,      // required, finite (when fix)
    "alt": number,      // required, finite
    "kmh": number,      // required, finite
    "cog": number,      // required, finite
    "hdop": number,     // required, finite
    "fix": boolean-ish,
    "chars": number     // required, finite
  },
  "sys": {              // required object
    "heap": number,     // required, finite
    "rssi": number,     // required, finite
    "wifi": {           // optional but read
      "ssid": string,
      "bssid": string,
      "channel": number,
      "status": string,
      "ip": string,
      "mac": string
    }
  },
  "up": number,         // required, finite (uptime seconds)
  "temp": number,       // required, finite (MPU temp)
  "maxTilt": number,    // required, finite
  "mpu": boolean-ish    // truthy/falsy
}
```

**Additional fields read by `renderData()`** (not in `validData` but used): `gps.dist_m`, `gps.utc_h/m/s/y/mo/d`, `sys.wifi.*`, `d.bms` (future), `mag_heading` (optional).

**Topics:** `esp32-dash/<KEY>/data` (retained), `esp32-dash/<KEY>/status` (retained, LWT "offline"). Publish interval 500 ms. Buffer 1024 bytes.

---

## 2. Feature Mapping to ESPHome

| Current feature | ESPHome approach | Risk | Notes |
|-----------------|-----------------|------|-------|
| Wi-Fi | `wifi:` | Low | `ssid`, `password`, `fast_connect`, `manual_ip` optional |
| MQTT broker | `mqtt:` | Low | `broker: broker.hivemq.com`, `port: 1883`, `discovery: false` |
| MQTT client ID | `mqtt: client_id:` | Low | Must match `esp32-dash-<EFUSE_MAC>` format if dashboard depends on it (it doesn't, but keep parity) |
| Birth message | `mqtt: birth_message:` | Low | Topic `.../status`, payload `online`, retained true |
| Will message | `mqtt: will_message:` | Low | Topic `.../status`, payload `offline`, retained true |
| Retained 500 ms JSON publish | `mqtt:` + `interval: 500ms` lambda calling `mqtt.publish_json()` | **Medium** | Payload must match schema exactly; check 1024-byte limit; `publish_json` may add whitespace |
| GPS NMEA | `uart:` (GPIO25 RX, 9600) + `gps:` | Low | `gps:` publishes latitude/longitude/satellites/etc as separate sensors |
| Odometer (Haversine) | `globals:` + lambda on `gps:` update | Medium | GPS distance in ESPHome; cumulative sum in lambda; persistence across reboot? |
| MPU6050 raw | `i2c:` + `mpu6050:` | Low | Gives accel_x/y/z, gyro_x/y/z, temp |
| Gyro calibration | Custom `button:` + lambda | Medium | Store bias in `globals:` |
| Roll/pitch/yaw fusion | **Custom C++** (`includes:`) | **High** | No ESPHome component fuses gyro+accel into attitude. Must write custom sensor class. |
| Tilt warn/danger + hysteresis | Lambda + `binary_sensor:`/`text_sensor:` | Low | Compare fused tilt to thresholds |
| LEDs | `output:` (GPIO26/27/32) + lambda | Low | Digital on/off; blink via lambda with `millis()`-equivalent or `light:` with effects |
| Serial command `r` | `button:` entity | Low | Trigger lambda to reset yaw |
| JSON payload reproduction | `mqtt.publish_json` lambda | **High** | Must match field names/types exactly; `publish_json` serializes differently than `snprintf` |
| Sys block (heap/rssi) | `system.uptime`, `wifi.rssi`, lambda | Low | Heap via `lambda` reading `ESP.getFreeHeap()` |
| Serial status line | `logger:` | Low | Different format; acceptable loss |

### Components with **no** ESPHome equivalent (must be custom C++)

1. **MPU6050 attitude fusion** (roll/pitch/yaw complementary filter) — `mpu6050` only gives raw accel/gyro/temp.
2. **Exact JSON payload serialization** — `mqtt.publish_json` may not produce byte-identical output to `snprintf`; field order, decimal places, and `null` strings need care.
4. **Gyro bias calibration loop** — same as above.

---

## 3. YAML Sketches

### 3.1 Minimal ESPHome config skeleton

```yaml
esphome:
  name: esp32-dash
  friendly_name: "ESP32 EV Tracker"
  comment: "Converted from PlatformIO Arduino"

esp32:
  board: esp32doit-devkit-v1
  framework:
    type: arduino   # or esp-idf — decision needed (see Section 5)

logger:
  level: INFO

wifi:
  ssid: !secret wifi_ssid
  password: !secret wifi_password
  fast_connect: true
  ap:  # fallback hotspot
    ssid: "Esp32-Dash Fallback"
    password: !secret wifi_ap_password

mqtt:
  broker: broker.hivemq.com
  port: 1883
  username: !secret mqtt_username
  password: !secret mqtt_password
  client_id: "esp32-dash-<mac>"  # or fixed
  discovery: false
  birth_message:
    topic: "esp32-dash/<KEY>/status"
    payload: "online"
    retained: true
  will_message:
    topic: "esp32-dash/<KEY>/status"
    payload: "offline"
    retained: true

# GPS on HardwareSerial 2, GPIO25 RX
uart:
  id: gps_uart
  tx_pin: GPIO1   # unused, set to -1 or a dummy
  rx_pin: GPIO25
  baud_rate: 9600

gps:
  id: gps_sensor
  uart_id: gps_uart
  update_interval: 1s

# MPU6050 on I2C GPIO21/22
i2c:
  id: i2c_bus
  sda: GPIO21
  scl: GPIO22
  frequency: 100kHz

mpu6050:
  i2c_id: i2c_bus
  update_interval: 50ms
  # accel_x, accel_y, accel_z, gyro_x, gyro_y, gyro_z, temperature exposed


# JK-BMS over BLE (external component)
external_components:
  - source: github://syssi/esphome-jk-bms@<version>

esp32_ble_tracker:
  id: ble_tracker

jk_bms_ble:
  mac_address: !secret bms_mac
  ble_device_type: JK02_32S   # TBD from Phase 0
  update_interval: 10s

# ... custom C++ includes for fusion, odometer, JSON publisher ...
```

### 3.2 Custom C++ include sketch (fusion + JSON)

```cpp
// includes/esphome_dash.h — custom sensor + publisher
#pragma once

#include "esphome.h"
#include "mpu6050.h"  // if needed for register access

namespace esphome {

class MpuFusion : public PollingComponent {
 public:
  MPU6050 *mpu = nullptr;
  float gyro_bias_x = 0, gyro_bias_y = 0, gyro_bias_z = 0;
  float roll = 0, pitch = 0, yaw = 0;
  unsigned long last_micros = 0;
  bool valid = false;
  // ... calibrated via button ...

  void set_mpu(MPU6050 *m) { mpu = m; }
  void calibrate_gyro();
  void reset_yaw() { yaw = 0; }
  void update() override;  // runs fusion at 500 ms (or faster)
};

class DashPublisher : public PollingComponent {
 public:
  MpuFusion *fusion = nullptr;
  GPS *gps = nullptr;
  // ...
  void publish_json();  // builds exact payload, calls mqtt::publish_json
};

}  // namespace esphome
```

---

## 4. Phases

### Phase 0 — Identify the BMS (shared with Plan A)

No code. Use nRF Connect (Android/iOS) to record:
- BMS BLE device name and MAC address
- Services/characteristics UUIDs
- JK phone app firmware version reading
- Whether phone can connect while ESP32 holds BLE link

Record results. Everything below depends on them.

### Phase B1 — BMS-only spike (ESPHome, separate ESP32 or reflashed unit)

Goal: confirm `jk_bms_ble` works with the real BMS before touching the main firmware.

1. Back up current PlatformIO firmware binary (`.pio/build/esp32-mqtt-simple/firmware.bin`).
2. Install ESPHome (`pip install esphome`).
3. Minimal YAML: Wi-Fi + `esp32_ble_tracker` + `jk_bms_ble` + logger.
4. Flash to a spare ESP32 (or the main one, accepting downtime).
5. Observe logs: pack voltage, current, SOC, protocol version match JK app?
6. Record protocol version (`JK02_24S`, `JK02_32S`, `JK04`) and frame behavior.

Exit criteria: BMS data visible in ESPHome logs matching phone app.

### Phase B2 — Port non-BMS features one at a time

For each feature, implement in ESPHome, flash, and compare readings side-by-side with current firmware:

| Feature | ESPHome task | Verification |
|---------|-------------|--------------|
| Wi-Fi + MQTT + birth/will | `wifi:`, `mqtt:` | status topic shows online/offline |
| GPS | `uart:` + `gps:` | lat/lng/sats match current firmware JSON |
| Odometer | `globals:` + Haversine lambda | `dist_m` matches current firmware |
| MPU6050 raw | `i2c:` + `mpu6050:` | raw accel/gyro match |
| Fusion + tilt | Custom `MpuFusion` component | roll/pitch/yaw/tilt match within 2° |
| Warn/danger LEDs | Lambda + `output:` | level matches at 30°/50° |
| Sys block | Lambda | heap/rssi/uptime reasonable |

### Phase B3 — Reproduce the JSON payload

This is the highest-risk phase for dashboard compatibility.

1. Implement `mqtt.publish_json` lambda in a 500 ms `interval:` component.
2. Build the exact field names/types from Section 1.4.
3. Capture current firmware JSON output (Serial or MQTT client).
4. Compare ESPHome JSON field-by-field: order, decimals, `null` vs `0`, boolean vs number.
5. Point the dashboard at the ESPHome device's MQTT topics (same broker, same `<KEY>`).
6. Verify `validData()` passes and all pills/charts render.

Exit criteria: Dashboard shows live data indistinguishable from current firmware.

### Phase B4 — Add BMS fields

Append `"bms":{...}` to the JSON payload:

```json
"bms": {
  "valid": true,
  "age": 0,
  "v": 53.64,
  "a": -0.00,
  "soc": 99,
  "w": 0,
  "tMos": 24,
  "tBat": 22,
  "cycles": 0,
  "err": 0,
  "chg": false,
  "dischg": false,
  "bal": false
}
```

- `"age"` = seconds since last good BMS frame (dashboard greys panel when stale).
- Dashboard `validData()` ignores unknown fields → backward compatible.

### Phase B5 — Soak test (8+ hours)

- Weak Wi-Fi, vehicle motion (GPS), BMS power cycles, BLE out-of-range then back.
- Log heap (`ESP.getFreeHeap()`) and reconnects.
- Acceptance: no reboot, no heap leak trend, tilt/danger response time matches current firmware, BMS data refreshes ≤30 s.

---

## 5. Decisions to Address Before Coding

| Decision | Options | Recommendation |
|----------|---------|----------------|
| **Framework:** ESP-IDF vs Arduino inside ESPHome | `framework.type: arduino` vs `esp-idf` | Start with **arduino** (maximizes compatibility with existing libs; NimBLE/ESPHome BLE works under both). Re-evaluate if BLE+Wi-Fi memory is tight. |
| **ESPHome version** | `2026.1.0+` (per `esphome-jk-bms` requirement) vs latest | Pin exact version in plan; `esphome-jk-bms` requires 2026.1.0 or higher. |
| **Home Assistant `api:`** | Enable or disable | **Disable** — nothing in this project depends on the ESPHome native API or Home Assistant. |
| **Custom C++ location** | `includes:` header in YAML vs separate component | `includes:` header is simpler for one-off fusion math; separate component is cleaner if reused. Start with `includes:`. |
| **Unit testing** | No native ESPHome test culture | Compile checks (`esphome compile`), captured-frame replay, bench tests against real hardware. |
| **Security** | Public broker (current) vs authenticated/TLS | Keep public broker for parity during conversion; evaluate TLS/auth as post-conversion hardening. |

---

## 6. Plan A vs Plan B Comparison

| Criterion | Plan A (NimBLE + hand parser, stay Arduino) | Plan B (ESPHome + esphome-jk-bms) |
|-----------|--------------------------------------------|-----------------------------------|
| **Effort** | ~10–12 person-days | ~12–16 person-days (MPU fusion + JSON payload reproduction are large unknowns) |
| **Highest risk** | Unknown BMS protocol variant; own parser may misparse frames | MPU tilt fusion must match current behavior within tolerance; exact JSON payload must match `validData()` |
| **Reused vs rewritten** | Reuses `main.cpp`, `mqtt_simple.cpp`; adds `jkbms/` module | Rewrites entire firmware in YAML; only `web/` dashboard is reused |
| **Third-party dependency** | NimBLE-Arduino (h2zero) — maintained, but you own the parser | `syssi/esphome-jk-bms` — maintained component (1,045 stars), but license must be verified; ESPHome itself is the platform |
| **BLE parsing risk** | You write and validate the parser against captured frames | Component maintains parser; you validate against real frames |
| **BLE/Wi-Fi coexistence** | You manage explicitly (FreeRTOS task or state machine) | ESPHome manages scheduling, but single-radio limit still applies |
| **Long-term maintenance** | Team maintains C++ parser + Arduino code | Team maintains ESPHome YAML + custom C++ includes; depends on ESPHome upstream |
| **OTA/update story** | Manual USB (`pio run -t upload`) or custom OTA | Built-in `ota:` component — wireless updates out of the box |
| **Team skills needed** | Arduino C++, BLE/GATT, MQTT, PlatformIO | ESPHome YAML, lambdas, custom C++ components, ESPHome internals |
| **Rollback path** | Trivial — reflash old `.bin` | Reflash old PlatformIO firmware; ESPHome is a different format |
| **Dashboard changes** | None (JSON schema preserved) | None (JSON schema preserved) — but harder to guarantee |

### Recommendation

**Plan A is the safer choice** for this project because:
1. It keeps the working, tested Arduino codebase intact.
2. The MPU6050 fusion and exact JSON payload are already proven; no regression risk.
3. It adds BMS as a separate module rather than rewriting everything.

**Plan B is preferable only if:**
- The team wants ESPHome's built-in OTA and web UI, AND
- Plan A Phase 1 fails to match any JK frame variant (protocol too different), AND
- The team is willing to accept 1–2 weeks of firmware rewrite risk.

### Conditions to reverse (switch from B to A, or vice versa)

- **Switch B → A if:** Plan B Phase B2 cannot reproduce MPU tilt/warn/danger behavior within ±3° of current firmware, or the JSON payload cannot be made byte-compatible enough for `validData()`.
- **Switch A → B if:** Plan A Phase 1 cannot capture/parse any valid JK-BMS frames, and `esphome-jk-bms` successfully reads the same BMS in the B1 spike.

---

## 7. Test Plan (Plan B)

| Test | Method | Pass criteria |
|------|--------|---------------|
| B1 spike | ESPHome + `jk_bms_ble` on spare ESP32 | BMS V/A/SOC match phone app; protocol version identified |
| Feature side-by-side | Flash ESPHome build, compare Serial/MQTT output to current firmware | GPS, MPU, odometer within tolerance (GPS ±5 m, tilt ±2°) |
| JSON regression | Capture current firmware JSON vs ESPHome JSON | `validData()` passes; all dashboard pills/charts render |
| Dashboard BMS panel | Add `bms` object, optional web panel | Panel shows data when `bms.valid`, greys when `bms.age` high |
| Soak test | 8+ h, weak Wi-Fi, vehicle motion, BMS power cycles | No reboot, no heap leak trend, BMS refresh ≤30 s |

---

## 8. Open Questions for Team / Client

1. **JK-BMS model and firmware version?** Needed to confirm protocol variant (`JK02_24S`, `JK02_32S`, `JK04`).
2. **BLE MAC address or device name?** From nRF Connect scan.
3. **Physical distance BMS↔ESP32 in vehicle?** Determines BLE viability vs RS485 fallback.
4. **ESPHome version pin?** `esphome-jk-bms` requires 2026.1.0+. Pin exact version.
5. **License check:** `syssi/esphome-jk-bms` LICENSE file — verify before depending on it.
6. **Framework:** Arduino or ESP-IDF inside ESPHome? Affects BLE memory and component availability.
7. **Dashboard BMS panel required?** If yes, `web/ui/app.js` and `web/index.html` changes needed.
8. **Can the phone JK app connect while ESP32 holds BLE link?** If no, connect-read-disconnect pattern needed in both plans.
9. **Is `test/` set up for `pio test -e native`?** Relevant for Plan A parser tests; Plan B has no equivalent test culture.
10. **TLS/auth for broker?** Current public broker is open. Post-conversion hardening decision.

---

## 9. Fallbacks (Plan B)

| Trigger | Fallback |
|---------|----------|
| B1 spike fails: `jk_bms_ble` doesn't read the BMS | Try UART-TTL wiring if BMS is close; otherwise switch to Plan A (own parser) or second-device gateway |
| Phase B2/B3: MPU fusion or JSON payload cannot match current firmware | Abort Plan B, switch to Plan A (keeps working code) |
| Phase B5: BLE+Wi-Fi coexistence causes drops on single ESP32 | Tune poll interval; if unstable, propose second ESP32 gateway (client decision) |
| License review fails on `esphome-jk-bms` | Implement parser from captured frames (Plan A approach) without copying repo code |

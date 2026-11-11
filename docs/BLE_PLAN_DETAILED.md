# JK-BMS over BLE — Detailed Integration Plan

**Project:** ESP32 EV distance tracker (PlatformIO + Arduino)
**Goal:** Read JK-BMS battery data over BLE on the **same ESP32**, publish to MQTT alongside existing data.
**Constraint:** Single device. Stay on Arduino/PlatformIO. `syssi/esphome-jk-bms` is ESPHome-only — reference only (**license unverified — check the repo's LICENSE file before using as protocol reference**).
**Status:** Pre-implementation. Do not write code until reviewed.

---

## 1. Codebase Audit Summary (Step 1)

### 1.1 Project structure

| Path | Role |
|------|------|
| `platformio.ini` | Single env `esp32-mqtt-simple`. Board: `esp32doit-devkit-v1`. Framework: Arduino. Libs: PubSubClient, TinyGPSPlus. `build_src_filter` restricts compile to `main.cpp` + `mqtt_simple/*`. |
| `src/main.cpp` | Build-flag dispatcher. `#if defined(USE_MQTT_SIMPLE)` → `mqtt_simple_setup()` / `mqtt_simple_loop()`. |
| `src/mqtt_simple/mqtt_simple.cpp` | Monolithic implementation: Wi-Fi, MQTT, GPS (HardwareSerial 2, RX=GPIO25, TX=GPIO33), MPU6050 (I2C GPIO21/22), odometer (Haversine), JSON publisher, lap gate, LED status. |
| `src/mqtt_simple/mqtt_simple.h` | Two function declarations only. |
| `web/ui/app.js` | Dashboard MQTT consumer. Subscribes to `esp32-dash/<KEY>/data` and `/status`. `validData()` requires fields: `tilt, roll, pitch, yaw, lvl, warn, danger, gps, sys`. Extra fields are ignored. |
| `web/ui/mqtt-mini.js` | Browser MQTT-over-WebSocket client (read-only). |
| `web/ui/map.js` | MapLibre vehicle/trail/heading rendering. |
| `test/` | README only. No unit tests. |
| `docs/` | Does not exist yet. |

### 1.2 Setup / loop structure

- `setup()` (`mqtt_simple_setup`): Serial, LED pin test, GPS serial begin (9600), Wire I2C begin, MPU6050 find+init (blocking retry loop with `delay(100)`), gyro calibration (500 samples × `delay(4)` ≈ 2 s), initial roll/pitch seed.
- `loop()` (`mqtt_simple_loop`): GPS serial drain, Serial command handling ('r' reset yaw, 'a'/'b' set the finish gate), GPS odometer update, `updateMotion()`, LED update, `networkService()`, status print every 2 s.
- **Blocking calls present:** MPU init retry loop (`delay(100)`), calibration loops (`delay(4)`), Wi-Fi reconnect attempts inside `networkService()` (15 s interval), MQTT connect retry (5 s interval). None block indefinitely but the loop can pause for hundreds of ms during Wi-Fi/MQTT reconnect.

### 1.3 MQTT layer

| Item | Value |
|------|-------|
| Library | PubSubClient (knolleary) |
| Broker | `broker.hivemq.com:1883` |
| Data topic | `esp32-dash/<TOPIC_KEY>/data` (retained, QoS 0) |
| Status topic | `esp32-dash/<TOPIC_KEY>/status` (retained, QoS 0, LWT "offline") |
| Publish interval | 500 ms |
| Keepalive | 15 s |
| Socket timeout | 3 s |
| Buffer size | 1024 bytes |
| Reconnect | Non-blocking polling in `networkService()`, Wi-Fi 15 s / MQTT 5 s backoff |
| Client ID | `esp32-dash-<EFUSE_MAC>` |

### 1.4 Web dashboard data flow

1. ESP32 publishes JSON to `broker.hivemq.com` over TCP port 1883.
2. Browser connects via WebSocket Secure `wss://broker.hivemq.com:8884/mqtt` (or local dev WS).
3. `mqtt-mini.js` subscribes to data + status topics.
4. `app.js` `onMessage()` parses JSON, validates via `validData()`, feeds GPS to MapLibre, updates DOM.
5. Dashboard tolerates missing/new fields (extra JSON keys ignored), so adding BMS fields is backward compatible **if existing fields remain present**.

### 1.5 Memory / resource headroom (measured first — do not trust guesses)

**Before coding, read the real values from a running device:**
- `ESP.getFreeHeap()` and `ESP.getMinFreeHeap()` — add to the status line / JSON `sys` block (see Phase 4).
- Payload size: measure `strlen()` of the current `publishData()` JSON buffer before adding `bms`. PubSubClient buffer is **1024 bytes**; if adding `bms` pushes the JSON over it, `mqtt.publish()` silently fails. Bump `mqtt.setBufferSize()` if needed.

| Resource | Estimate (verify on device) | Risk for adding NimBLE |
|----------|----------------------------|------------------------|
| Flash | ESP32-DOIT typically 4 MB. Current firmware likely < 1 MB. | Low |
| RAM (heap) | ~250–300 KB free at runtime (unverified — read real `sys.heap`). | Medium — NimBLE + BLE stack + frame buffers need ~40–80 KB (unverified) |
| Partition | Default `esp32doit-devkit-v1` uses default Arduino partition (likely 1.9 MB app). | Low |

**Flag:** `platformio.ini` does not specify a partition scheme. Adding NimBLE and BLE buffers on a single ESP32 with Wi-Fi + MQTT + GPS + MPU is feasible but leaves less headroom. Monitor `ESP.getFreeHeap()` and `ESP.getMinFreeHeap()`.

### 1.6 Where BMS code fits

- **Data struct:** New `src/jkbms/jkbms.h` + `src/jkbms/jkbms.cpp` — parser + state machine, no Arduino dependencies (unit-testable on desktop).
- **BLE driver:** New `src/jkbms/ble_client.cpp` — NimBLE-Arduino scan/connect/notify, calls parser.
- **Integration:** `src/mqtt_simple/mqtt_simple.cpp` — add `#include "jkbms/jkbms.h"`; call `jkbms_setup()` in `setup()` only (it creates the FreeRTOS task, which runs autonomously — there is no `jkbms_loop()` in the Arduino loop); add BMS fields to `publishData()` JSON.
- **Build config:** Add `[env:ble_test]` and update `[env:esp32-mqtt-simple]` `lib_deps` to include **h2zero/NimBLE-Arduino** (pin an exact version — NimBLE 1.x and 2.x APIs differ). Update `build_src_filter` to include `jkbms/*`.

---

## 2. File-by-File Change List

### Phase 0 — Identify the BMS (no code)

**No files changed.** Deliverable: recorded BMS model, firmware version, BLE MAC, service/characteristic UUIDs, frame format observed.

**Action:** Client provides BMS model/firmware, or team scans with nRF Connect app and records:
- BLE device name
- MAC address (public/random)
- Services and characteristics (UUIDs)
- Whether phone app can connect simultaneously with ESP32

---

### Phase 1 — Standalone BLE prototype (`[env:ble_test]`)

**New files:**
- `src/jkbms/ble_test.cpp` — standalone prototype sketch (temporary, removed before production)
- `src/jkbms/ble_client.h` / `src/jkbms/ble_client.cpp` — NimBLE scan/connect/subscribe skeleton
- `src/jkbms/jkbms.h` / `src/jkbms/jkbms.cpp` — parser skeleton (stub, returns raw bytes)

**Modified files:**
- `platformio.ini` — add `[env:ble_test]` environment extending base with `lib_deps = https://github.com/h2zero/NimBLE-Arduino.git` (or latest maintained fork, pin an exact version); add `build_src_filter` for ble_test
- `src/main.cpp` — optionally add `#if defined(USE_BLE_TEST)` dispatch (temporary)

**Functions:**
- `ble_scan_once()` — **single** NimBLE scan at startup only (after Phase 0 gives the MAC, scanning can be skipped entirely). NimBLE scan interval/window are specified in **0.625 ms units** — do not pass raw milliseconds.
- `ble_connect(address)` — connect directly by MAC address (no repeated scanning).
- `ble_disconnect()` — release the BLE link after each read poll so Wi-Fi gets radio time.
- `ble_discover_service_char()` — find JK service (tentatively `0xFFE0`) and char (tentatively `0xFFE1`).
- `ble_subscribe_notify()` — register notification callback.
- `ble_send_request(cmd)` — write request frame `AA 55 90 EB ... <checksum>` (checksum algorithm TBD from captured frames — see Phase 2).
- `ble_notify_callback(data, len)` — append to reassembly buffer, print hex to Serial.

**Connection pattern (critical):** Connect → read → **disconnect**. Do not hold a persistent BLE connection. Reconnect on the next poll interval. This avoids BLE starving Wi-Fi/MQTT on the single shared radio.

**Exit criteria:** Pack voltage, current, SOC printed on Serial match JK phone app. Raw frames saved to `test/fixtures/frame_*.bin` or `.txt` hex dumps.

---

### Phase 2 — Parser module (`src/jkbms/`)

**New files:**
- `src/jkbms/jkbms.h` — public struct `JkbmsData`, `JkbmsParser` class, result enum
- `src/jkbms/jkbms.cpp` — frame reassembly, CRC validation, field extraction
- `test/jkbms_parser_test.cpp` — desktop unit test using fixtures (build with `pio test -e native` if available, or manual host harness)

**Modified files:**
- `platformio.ini` — add `jkbms/*` to `build_src_filter` of main env
- `src/main.cpp` — no change yet (parser not integrated)

**Data struct (`JkbmsData`):**
```cpp
struct JkbmsData {
  bool valid = false;
  uint32_t lastUpdateMs = 0;     // millis() of last good frame
  uint32_t ageSeconds = 0;       // (millis() - lastUpdateMs) / 1000 — dashboard uses this to grey out stale BMS panel
  float packVoltageV = NAN;
  float currentA = NAN;
  float socPercent = NAN;
  float powerW = NAN;
  float cellMinV = NAN;
  float cellMaxV = NAN;
  float cellDeltaV = NAN;
  int cellCount = 0;
  float tempMosfetC = NAN;
  float tempBatteryC = NAN;
  uint16_t cycleCount = 0;
  uint16_t errorsBitmask = 0;
  bool chargingEnabled = false;
  bool dischargingEnabled = false;
  bool balancingEnabled = false;
};
```

**Parser responsibilities:**
- Reassemble multi-chunk notifications into full frames (`55 AA EB 90 ...`)
- Validate header `55 AA EB 90`, length, **checksum** (verify algorithm against captured frames — JK frames may use a simple byte-sum checksum rather than CRC16; do not assume CRC16)
- Dispatch on frame-type byte (settings / cell info / device info)
- Fail safely: on unknown frame type or checksum mismatch, discard frame, set `valid=false`, never crash
- No `delay()`, no `Serial`, no Arduino includes

**Unit tests:** Load `test/fixtures/`, assert struct fields match expected values from JK app. Include `ageSeconds` = 0 for freshly parsed frames.

---

### Phase 3 — Integration into main firmware

**New files:**
- None beyond Phase 1/2 (ble_client and jkbms already exist)

**Modified files:**

| File | Change |
|------|--------|
| `platformio.ini` | Add `https://github.com/h2zero/NimBLE-Arduino.git` to `lib_deps` (pin exact version). Add `+<jkbms/*>` to `build_src_filter`. |
| `src/main.cpp` | Add `#if defined(USE_JKBMS)` block calling `jkbms_setup()` only — creates the FreeRTOS task which runs autonomously; no `jkbms_loop()` in the main loop. |
| `src/mqtt_simple/mqtt_simple.cpp` | - `#include "jkbms/jkbms.h"`<br>- Declare global `JkbmsData gBms;` + `portMUX_TYPE bmsMutex` (or `SemaphoreHandle_t`)<br>- In `setup()`: call `jkbms_setup()` (creates FreeRTOS task on core 0)<br>- In `loop()`: read `gBms` under mutex, compute `ageSeconds`<br>- In `publishData()`: append `"bms":{...}` JSON object with `"age"`<br>- In `networkService()`: no change (BLE task is independent)<br>- Add `ESP.getMinFreeHeap()` to status line and `sys.minHeap` |
| `src/mqtt_simple/mqtt_simple.h` | No change needed (or add forward decl if desired) |

**BLE client architecture (mandatory): FreeRTOS task from the start.**

NimBLE scan, connect, and service discovery are **blocking calls** that can hold the ESP32 loop for seconds. That would break MPU6050 gyro integration (which depends on regular `dt`) and the tilt/danger logic.

- `xTaskCreatePinnedToCore(jkbms_task, "jkbms", 8192, NULL, 2, NULL, 0)` — pinned to **core 0**. NOTE: on ESP32 Arduino `loop()` runs on core 1 and Wi-Fi housekeeping runs on core 0, so core 1 would share the MPU6050 gyro loop and a priority-2 task could preempt it. Confirm core/priority defaults for your Arduino core version; alternatively cap the task priority at 1 (the loop's priority). Stack size 8192 bytes is a starting value — log `uxTaskGetStackHighWaterMark(NULL)` inside the task and report the high-water mark in soak testing.
- A **mutex-protected** `JkbmsData gBms` snapshot is shared between the BLE task (writer) and `mqtt_simple_loop()` (reader).
- BLE task loop: connect → subscribe → request frame → wait for response → parse → store in `gBms` (under mutex) → disconnect → `vTaskDelay(poll interval)` → repeat.
- On failure: exponential backoff, then retry. Never block the main loop.

**Coexistence tuning:**
- **Do not scan on every poll.** After Phase 0 captures the MAC, connect directly by address. Skip scanning entirely in production.
- Connect → read once → **disconnect** (poll pattern). Never hold a persistent BLE link.
- BLE NimBLE interval/window values are in **0.625 ms units** — convert milliseconds correctly.
- MQTT keepalive 15 s, Wi-Fi `setAutoReconnect(true)`.
- After BLE disconnect, `vTaskDelay(500–1000 ms)` before next poll to let Wi-Fi service MQTT.

**MQTT schema addition (backward compatible):**
Append to existing JSON under `"bms"` key:
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
- `"age"` = seconds since last good BMS frame. Dashboard uses this to grey out the BMS panel when BLE drops (retained MQTT would otherwise republish stale values as if fresh).
- Dashboard `validData()` does not check for `bms`, so existing viewers keep working. Dashboard can optionally render BMS panel when `d.bms` is present.

---

### Phase 4 — Reliability and soak testing

**Modified files:**
- `src/mqtt_simple/mqtt_simple.cpp` — add `ESP.getMinFreeHeap()` to status line and JSON `sys.minHeap`
- `src/jkbms/ble_client.cpp` — add reconnect backoff counter, disconnect-on-idle logic

**Tests:**
- Unit: parser fixtures (Phase 2)
- Hardware: BMS data matches phone app within ±5% voltage, ±0.1 A current
- Soak: 8+ hours unattended. Conditions: weak Wi-Fi, vehicle movement (GPS), BMS power cycle, BLE out-of-range then back
- Acceptance: no reboot, no heap leak trend (min free heap stable), BMS data refreshes at target interval (≤30 s)

---

## 3. MQTT Topic / JSON Schema

### Existing topics (unchanged)
| Topic | Retained | Payload |
|-------|----------|---------|
| `esp32-dash/<KEY>/data` | Yes | Full JSON telemetry |
| `esp32-dash/<KEY>/status` | Yes | `online` / `offline` (LWT) |

### New BMS data — option 1: merged into existing data topic (recommended)
Append `"bms":{...}` to the existing `data` JSON. No new topic, one MQTT publish per 500 ms cycle (or slower for BMS, e.g. 5 s).

### New BMS data — option 2: separate topic
`esp32-dash/<KEY>/bms` — standalone BMS JSON, published at BMS update interval.

**Recommendation:** Option 1 for minimal dashboard changes. Option 2 if BMS publish rate differs significantly from GPS/MPU rate.

### Backward compatibility
- `validData()` in `app.js` does not require `bms`, so existing dashboards render normally.
- New BMS panel in `web/` can read `d.bms` when present.

---

## 4. Task Breakdown with Effort Estimates

| Phase | Task | File(s) | Effort | Depends |
|-------|------|---------|--------|---------|
| 0 | Get BMS model/fw/MAC from client or nRF scan | None | 0.5 d | — |
| 1 | Add h2zero/NimBLE-Arduino lib dep (pinned version) + `[env:ble_test]` | platformio.ini | 0.5 d | 0 |
| 1 | FreeRTOS BLE task: connect-by-MAC → read → disconnect skeleton | `src/jkbms/ble_client.{h,cpp}` | 2 d | 0 |
| 1 | Capture raw BLE frames to fixtures | `test/fixtures/` | 1 d | 1 (skeleton) |
| 2 | JKBMS parser struct + reassembly + checksum (verify algorithm) | `src/jkbms/jkbms.{h,cpp}` | 2 d | 1 (fixtures) |
| 2 | Desktop unit tests against fixtures | `test/jkbms_parser_test.cpp` | 1 d | 2 |
| 3 | Integrate FreeRTOS BLE task + mutex-protected `gBms` snapshot into `mqtt_simple_loop()` | `src/mqtt_simple/mqtt_simple.cpp` | 1.5 d | 2 |
| 3 | Measure current MQTT JSON payload size; bump PubSubClient buffer if adding `bms` exceeds 1024 | `src/mqtt_simple/mqtt_simple.cpp` | 0.5 d | 3 |
| 3 | Add BMS `"bms":{...}` + `"age"` fields to `publishData()` JSON | `src/mqtt_simple/mqtt_simple.cpp` | 0.5 d | 3 |
| 3 | BLE/Wi-Fi coexistence tuning (connect-read-disconnect poll pattern, vTaskDelay gaps) | `src/jkbms/ble_client.cpp` | 1 d | 3 |
| 3 | Dashboard BMS panel (optional, reads `d.bms` + `d.bms.age`) | `web/ui/app.js`, `web/index.html` | 1 d | 3 |
| 4 | Heap monitoring (`ESP.getMinFreeHeap()`) + status line + `sys.minHeap` | `src/mqtt_simple/mqtt_simple.cpp` | 0.5 d | 3 |
| 4 | Soak test (8+ h) | None | 1 d (wall clock) | 3 |
| **Total** | | | **~12–14 person-days** | |

---

## 5. Test Plan

| Test | Method | Pass criteria |
|------|--------|---------------|
| Parser unit | Desktop build, load `test/fixtures/*.hex`, assert struct fields | All fields match expected values from JK app; unknown/checksum-bad frames rejected safely; `ageSeconds` = 0 on fresh parse |
| Checksum algorithm | Analyze captured frames; confirm byte-sum vs CRC16 | Validator matches all fixtures without false rejects |
| MQTT payload size | `strlen()` of current `publishData()` buffer before adding `bms` | If +`bms` > 1024 bytes, `mqtt.setBufferSize()` increased accordingly |
| BLE connect | Hardware, nRF Connect cross-check | ESP32 connects by MAC (no scan), gets notifications, disconnects cleanly |
| End-to-end data | Hardware, Serial + MQTT client | Pack V/A/SOC on ESP32 match phone app within tolerance; `bms.age` increments on stale |
| Coexistence | Hardware, weak Wi-Fi + active BLE polling | MQTT does not drop for >30 s; Wi-Fi reconnects autonomously; gyro integration not disrupted by BLE task |
| Soak | 8 h unattended, log heap every 60 s | No reboot, min free heap stable (±5%), BMS data refreshes ≤30 s interval, `bms.age` stays bounded |
| Dashboard regression | Browser, subscribe to existing topics | All existing pills/charts render; new BMS panel optional and greys out when `bms.age` is high |

---

## 6. Open Questions for Team / Client

1. **JK-BMS model and firmware version?** Needed to confirm protocol variant (JK02_24S / JK02_32S / JK04) and frame layout.
2. **BLE MAC address or BLE device name?** Needed for `ble_connect()` target.
3. **ESP32 variant?** `platformio.ini` says `esp32doit-devkit-v1` (classic ESP32). Confirm no S3/C3 in actual hardware — NimBLE support differs.
4. **Physical distance BMS↔ESP32 in vehicle?** Determines if BLE is viable or if RS485/UART fallback is needed.
5. **Can the phone JK app connect while ESP32 holds BLE link?** If no, need a "release link" mode (connect-read-disconnect poll pattern).
6. **Target BMS refresh interval?** (5 s, 10 s, 30 s?) Affects publish JSON and BLE duty cycle.
7. **Dashboard BMS panel required, or is MQTT topic enough?** If panel needed, `web/ui/app.js` and `web/index.html` changes required.
8. **Partition scheme / flash size confirmation?** To confirm NimBLE fits alongside existing code.
9. **Is `test/` set up for `pio test -e native` desktop unit tests, or do we need a manual host harness?**
10. **License review:** `syssi/esphome-jk-bms` license status unverified — check the repo's LICENSE file before using even as a protocol reference; do not copy code. Clean-room implementation based on observed frames + public JK protocol docs. Confirm team approach.

---

## 7. Fallbacks (documented triggers)

| Trigger | Fallback |
|---------|----------|
| Phase 1 fails: BLE frames don't match any known JK variant | Request BMS protocol docs from client; if unavailable, switch to RS485/UART fallback |
| Phase 3: BLE + Wi-Fi coexistence unstable (MQTT drops >30 s repeatedly) even with connect-read-disconnect poll pattern and vTaskDelay gaps | Propose second ESP32 gateway running ESPHome + `esphome-jk-bms` (client budget decision; violates single-device constraint) |
| RAM/flash pressure: free heap < 50 KB | Trim features (reduce PubSub buffer, disable LED test), change partition scheme, or second-device gateway |
| License review fails: cannot use `syssi/esphome-jk-bms` even as reference | Implement parser from captured frames + public JK protocol docs only; no code from the repo |

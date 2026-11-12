# MQTT Topic Structure & Payload Format

Live telemetry flows: **ESP32 → HiveMQ (wss) → Dashboard**

---

## Broker

| Property | Value |
|----------|-------|
| Host | `broker.hivemq.com` |
| Port | `8884` (wss) |
| Path | `/mqtt` |
| Protocol | MQTT 3.1.1 over WebSocket Secure |
| Auth | None (public broker) |

---

## Topic Format

```
esp32-dash/<TOPIC_KEY>/data   → sensor readings (retained)
esp32-dash/<TOPIC_KEY>/status → online/offline (retained, LWT)
```

- `<TOPIC_KEY>` default: `race-tracker` (configurable in firmware and dashboard URL `#t=<key>`)
- Dashboard subscribes to both topics on connect
- Multiple trackers can share the broker by using different `<TOPIC_KEY>`

---

## Data Payload (esp32-dash/<key>/data)

Published at **1 Hz** (every second). Retained = true (latest always available).

```json
{
  "ts": 1700000001,
  "gps": {
    "fix": true,
    "lat": -6.200001,
    "lng": 106.800001,
    "alt": 42.5,
    "kmh": 45.2,
    "cog": 90.5,
    "hdop": 0.8,
    "sats": 8
  },
  "mpu": {
    "roll": 2.1,
    "pitch": -1.8,
    "yaw": 42.0,
    "accel": {"x": 0.02, "y": -0.15, "z": 9.78},
    "gyro": {"x": 0.01, "y": 0.02, "z": 0.03}
  },
  "sys": {
    "uptime": 3600,
    "freeHeap": 245000,
    "wifiRssi": -52,
    "wifiCh": 1
  }
}
```

### Field Reference

| Path | Type | Unit | Description |
|------|------|------|-------------|
| `ts` | integer | seconds (epoch) | GPS time if fix, else millis()/1000 |
| `gps.fix` | boolean | — | True if valid position |
| `gps.lat` | number | degrees | Latitude (WGS84) |
| `gps.lng` | number | degrees | Longitude (WGS84) |
| `gps.alt` | number | meters | Altitude (MSL) |
| `gps.kmh` | number | km/h | Speed over ground |
| `gps.cog` | number | degrees | Course over ground (0–360) |
| `gps.hdop` | number | — | Horizontal dilution of precision |
| `gps.sats` | integer | count | Satellites used in fix |
| `mpu.roll` | number | degrees | Fused roll (tilt left/right) |
| `mpu.pitch` | number | degrees | Fused pitch (tilt fore/aft) |
| `mpu.yaw` | number | degrees | Gyro-integrated heading (drifts) |
| `mpu.accel` | object | m/s² | Raw accelerometer (x/y/z) |
| `mpu.gyro` | object | rad/s | Raw gyroscope (x/y/z) |
| `sys.uptime` | integer | seconds | Seconds since boot |
| `sys.freeHeap` | integer | bytes | ESP.getFreeHeap() |
| `sys.wifiRssi` | integer | dBm | WiFi signal strength |
| `sys.wifiCh` | integer | — | WiFi channel |

---

## Status Payload (esp32-dash/<key>/status)

Published on connect and as Last Will (LWT). Retained = true.

### Online
```json
{"online": true, "ts": 1700000000, "fw": "orion 1.4.0", "id": "orion-A1B2C3D4"}
```

### Offline (LWT)
```json
{"online": false, "ts": 1700000000}
```

| Field | Description |
|-------|-------------|
| `online` | true = connected, false = LWT fired |
| `ts` | Epoch seconds when status sent |
| `fw` | Firmware version string |
| `id` | MQTT client ID (`orion-<MAC>`) |

---

## Dashboard Subscription

On page load (or `#t=<key>` change):

```js
const TOPIC_ROOT = "esp32-dash/";
const TOPIC_KEY = "race-tracker"; // or from URL hash
mqtt.subscribe(TOPIC_ROOT + TOPIC_KEY + "/data");
mqtt.subscribe(TOPIC_ROOT + TOPIC_KEY + "/status");
```

- Data topic → `ingestGPS()` → updates all tabs
- Status topic → updates `DEVICE` pill (LIVE/OFFLINE/NO SIGNAL)

---

## Multiple Trackers

Each tracker uses a unique `<TOPIC_KEY>`:
- Firmware: `#define TOPIC_KEY "my-tracker"`
- Dashboard: open `https://.../esp32-monitoring-pio/#t=my-tracker`
- Broker: public, no coordination needed

---

## QoS & Retention

| Topic | QoS | Retained | Reason |
|-------|-----|----------|--------|
| `.../data` | 0 | true | Latest reading always available on subscribe |
| `.../status` | 0 | true | LWT ensures offline state visible |

QoS 0 chosen for: minimal overhead, 1 Hz is frequent enough, broker is public/unreliable anyway.

---

## Firmware Config (src/mqtt_simple/mqtt_simple.cpp)

```cpp
#define TOPIC_KEY     "race-tracker"      // Change per tracker
#define TOPIC_DATA    "esp32-dash/" TOPIC_KEY "/data"
#define TOPIC_STATUS  "esp32-dash/" TOPIC_KEY "/status"
#define FW_NAME       "orion"
#define FW_VERSION    "1.4.0"
#define PUBLISH_INTERVAL_MS 1000
```

Client ID generated at boot: `orion-<MAC>` (e.g., `orion-A1B2C3D4`).
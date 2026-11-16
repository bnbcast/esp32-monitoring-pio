# MQTT Topic Structure & Payload Format

Live telemetry: **ESP32 → HiveMQ → browser dashboard**.

| Client | Transport | Address |
|--------|-----------|---------|
| ESP32 firmware | MQTT over TCP | `broker.hivemq.com:1883` |
| Dashboard (browser) | MQTT over WebSocket Secure | `wss://broker.hivemq.com:8884/mqtt` |

No authentication on either path — this is the public HiveMQ broker.

---

## Topics

```
esp32-dash/<TOPIC_KEY>/data    sensor frames   (retained, QoS 0)
esp32-dash/<TOPIC_KEY>/status  online/offline  (retained, QoS 0, LWT)
```

- `TOPIC_KEY` default: `race-tracker` (`src/mqtt_simple/mqtt_simple.cpp`)
- The dashboard derives the key from the URL hash: `#t=<key>`
- Data is retained: a new subscriber immediately receives the last frame
- Status uses the broker Last Will: if the device drops, HiveMQ publishes `offline`
- `GET /live` on the history API returns the retained frame over HTTPS without
  a browser MQTT client — see [live.md](live.md)

---

## Data Payload

Published once per second, retained. Real shape (one line on the wire):

```json
{
  "seq": 1234,
  "ts": 1700000001,
  "up": 3600,
  "mpu": true,
  "roll": 4.10,
  "pitch": -2.10,
  "yaw": 12.30,
  "tilt": 4.60,
  "ax": 0.020,
  "ay": -0.150,
  "az": 9.780,
  "temp": 31.2,
  "lvl": 0,
  "warn": 35,
  "danger": 50,
  "maxTilt": 12.4,
  "gps": {
    "chars": 18422,
    "view": 11,
    "snr": 24,
    "q": 1,
    "bad": 3,
    "sats": 9,
    "fix": true,
    "lat": -6.200001,
    "lng": 106.800001,
    "alt": 120.4,
    "kmh": 45.2,
    "cog": 90.5,
    "hdop": 0.8,
    "dist_m": 1520.4,
    "ttff_s": 41,
    "rej": 0,
    "still": false,
    "mode": 3,
    "utc_h": 9, "utc_m": 12, "utc_s": 3,
    "utc_y": 2026, "utc_mo": 11, "utc_d": 16
  },
  "lap": {
    "on": false,
    "auto": false,
    "n": 2,
    "gen": 3,
    "last_ms": 45230,
    "best_ms": 44210,
    "la": [-6.2001, 106.8001],
    "lb": [-6.2002, 106.8002]
  },
  "sys": {
    "heap": 194560,
    "heap_min": 188400,
    "boot": 7,
    "brown": 0,
    "rssi": -52,
    "temp_c": 41.8,
    "wifi": {
      "ssid": "Gi Joe",
      "bssid": "aa:bb:cc:dd:ee:ff",
      "channel": 6,
      "status": "Connected",
      "ip": "10.0.0.42",
      "mac": "28:56:2f:49:b9:10"
    }
  }
}
```

### Field Reference

| Path | Type | Unit | Description |
|------|------|------|-------------|
| `seq` | integer | — | Monotonic publish counter |
| `ts` | integer | epoch s | GPS UTC when valid, else 0 |
| `up` | integer | s | `millis()/1000` |
| `mpu` | boolean | — | MPU present and initialised |
| `roll`, `pitch`, `yaw` | number | deg | Fused attitude (yaw is gyro-only) |
| `tilt` | number | deg | Combined tilt magnitude |
| `ax`, `ay`, `az` | number | g | Accelerometer |
| `temp` | number | °C | MPU die temperature |
| `lvl` | integer | — | 0 safe, 1 warn, 2 danger |
| `warn`, `danger` | integer | deg | Configured tilt thresholds |
| `maxTilt` | number | deg | Peak tilt this boot |
| `gps.chars` | integer | — | NMEA characters processed |
| `gps.view` | integer | count | Satellites in view (`-1` unknown) |
| `gps.snr` | integer | dB-Hz | Best SNR |
| `gps.q` | integer | — | Fix quality (0 none, 1 GPS, 2 DGPS) |
| `gps.bad` | integer | — | Bad NMEA sentences |
| `gps.sats` | integer | count | Satellites used |
| `gps.fix` | boolean | — | Valid position |
| `gps.lat`, `gps.lng` | number | deg | WGS84 |
| `gps.alt` | number | m | MSL altitude |
| `gps.kmh` | number | km/h | Ground speed |
| `gps.cog` | number | deg | Course over ground |
| `gps.hdop` | number | — | Horizontal dilution |
| `gps.dist_m` | number | m | Device odometer |
| `gps.ttff_s` | integer | s | Time to first fix this boot |
| `gps.rej` | integer | — | Fixes rejected by the jump gate |
| `gps.still` | boolean | — | Parked/hold state |
| `gps.mode` | integer | — | NMEA fix mode |
| `gps.utc_*` | integer | — | UTC broken down for the dashboard clock |
| `lap.on` | boolean | — | Timing gate armed |
| `lap.auto` | boolean | — | Line was armed automatically (no stored gate) |
| `lap.n` | integer | — | Lap count |
| `lap.gen` | integer | — | Session generation: changes when the counters restart, survives a reboot |
| `lap.last_ms`, `lap.best_ms` | integer | ms | Last and best lap |
| `lap.la`, `lap.lb` | number[2] | deg | Gate endpoints |

> With no gate stored (and no manual `a`/`b` in progress) the board arms one
> itself on the first sustained motion: 5 s above 5 km/h. The line passes
> through the launch fix, perpendicular to the heading, 30 m wide. `lap.auto`
> says where it came from. Manual `a`/`b` always overrides, and a stored auto
> line is dropped when the first fix after boot is more than 500 m away.
| `sys.heap`, `sys.heap_min` | integer | bytes | Free / minimum free heap |
| `sys.boot` | integer | — | Boot counter (NVS) |
| `sys.brown` | integer | — | Persisted brownout resets (NVS) |
| `sys.rssi` | integer | dBm | Wi-Fi RSSI |
| `sys.temp_c` | number | deg C | ESP32 **die** temperature (`temperatureRead()`) |
| `sys.wifi.*` | mixed | - | SSID, BSSID, channel, status, IP, MAC |

> `sys.wifi.status` is `Connected`, `Disconnected`, `No SSID`, `Connect failed`,
> `Idle` or `Unknown`. When not connected, `ssid` is empty and `ip` is `-`.

> `sys.temp_c` is the ESP32's internal **die** sensor, sampled once per publish.
> On a classic ESP32 it is uncalibrated: read it as "the chip is heating up",
> not as ambient or engine temperature. The top-level `temp` field is the
> MPU6050's separate on-chip sensor. Older firmware omits `sys.temp_c`, and the
> dashboard simply leaves the chip-temperature row and line empty.

---

## Status Payload

Plain string, not JSON:

| Value | When |
|-------|------|
| `online` | Published retained immediately after a successful connect |
| `offline` | Broker Last Will when the TCP session drops |

---

## Client ID & Session

- Client ID: `orion-<8 hex>` from the ESP32 eFuse MAC, e.g. `orion-3B4A21C8`
- Clean session, keepalive 15 s, socket timeout 3 s
- Last Will: topic `.../status`, payload `offline`, QoS 0, retained
- The firmware keeps a 3-slot publish queue; frames that fail to send are
  retried oldest-first after a reconnect
- A watchdog forces a reconnect if nothing is delivered for 20 s

---

## Firmware Config

```cpp
#define MQTT_HOST   "broker.hivemq.com"
#define MQTT_PORT   1883
#define TOPIC_KEY   "race-tracker"
#define TOPIC_DATA   "esp32-dash/" TOPIC_KEY "/data"
#define TOPIC_STATUS "esp32-dash/" TOPIC_KEY "/status"
#define FW_NAME     "orion"
#define FW_VERSION  "1.4.0"
#define PUBLISH_INTERVAL_MS 1000
```

---

## Dashboard Subscription

```js
const TOPIC_ROOT = "esp32-dash/";
const TOPIC_KEY  = "race-tracker";      // or from #t=<key>
mqtt.subscribe(TOPIC_ROOT + TOPIC_KEY + "/data");
mqtt.subscribe(TOPIC_ROOT + TOPIC_KEY + "/status");
```

- `/data` → `ingestGPS()` → map, charts, pills
- `/status` → DEVICE pill (`LIVE` / `OFFLINE` / `NO SIGNAL`)

Every tracker needs its own `TOPIC_KEY`; both sides must match.

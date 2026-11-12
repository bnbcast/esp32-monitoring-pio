# Hardware Schematic & Wiring

## Bill of Materials

| Component | Qty | Notes |
|-----------|-----|-------|
| ESP32 DevKit V1 (DOIT) | 1 | `esp32doit-devkit-v1` |
| NEO-6M GPS Module | 1 | UART, 9600 baud default |
| MPU6050 IMU | 1 | I2C, 0x68 address |
| Breadboard / Perfboard | 1 | |
| Jumper wires | ~10 | |
| USB cable (data) | 1 | For power + flash |

---

## Pinout

| ESP32 Pin | Function | Connected To |
|-----------|----------|--------------|
| **GPIO 16 (RX2)** | UART2 RX | NEO-6M **TX** |
| **GPIO 17 (TX2)** | UART2 TX | NEO-6M **RX** |
| **GPIO 21 (SDA)** | I2C SDA | MPU6050 **SDA** |
| **GPIO 22 (SCL)** | I2C SCL | MPU6050 **SCL** |
| **3V3** | Power | NEO-6M VCC, MPU6050 VCC |
| **GND** | Ground | NEO-6M GND, MPU6050 GND |
| **EN** | Reset | (optional) button to GND |

> **Note**: NEO-6M RX accepts 3.3V logic. If your module is 5V-only, add a voltage divider on ESP32 TX2 → NEO-6M RX.

---

## Wiring Diagram

```
                    ┌─────────────────────┐
                    │    ESP32 DevKit     │
                    │                     │
              ┌─────►│ GPIO 16 (RX2)       │
              │      │ GPIO 17 (TX2)       │──────┐
              │      │ GPIO 21 (SDA)       │──────┤
              │      │ GPIO 22 (SCL)       │──────┤
              │      │ 3V3                 │──────┼──┐
              │      │ GND                 │──────┼──┼──┐
              │      │                     │      │  │  │
              │      └─────────────────────┘      │  │  │
              │                                   │  │  │
              ▼                                   ▼  ▼  ▼
        ┌───────────┐                     ┌───────────────┐
        │  NEO-6M   │                     │    MPU6050    │
        │           │                     │               │
        │ TX ───────┘                     │ SDA ──────────┘
        │ RX ─────────────────────────────┘ SCL ──────────┘
        │ VCC ────────────────────────────────────────────┘
        │ GND ────────────────────────────────────────────┘
        └───────────┘
```

---

## Power Considerations

| Component | Voltage | Current (typical) |
|-----------|---------|-------------------|
| ESP32 | 3.3V | 80–240 mA (WiFi active) |
| NEO-6M | 3.3V | 30–50 mA (acquisition) |
| MPU6050 | 3.3V | 3–5 mA |
| **Total** | **3.3V** | **~150–300 mA** |

- ESP32 DevKit onboard LDO (AMS1117) handles up to 800 mA → sufficient
- Add 100 µF + 100 nF decoupling near ESP32 3V3/GND if using long wires
- NEO-6M cold start draws more current → ensure stable 3.3V

---

## Antenna Placement

| Sensor | Requirement |
|--------|-------------|
| **NEO-6M** | Ceramic patch antenna needs clear sky view. Keep >5 cm from ESP32 WiFi antenna, metal, carbon fiber. Horizontal mount (patch facing up). |
| **MPU6050** | Mount flat on vehicle chassis. Align axes: X = right, Y = forward, Z = up. Secure rigidly (double-sided tape + zip tie). |

---

## ESP32 DevKit V1 Pin Reference

```
          ┌────────────────────────┐
    VIN ──►│ 3V3           GND ◄───│
           │ GND           GPIO23   │
           │ GPIO18          GPIO22 │◄── SCL (MPU6050)
           │ GPIO19          GPIO21 │◄── SDA (MPU6050)
           │ GPIO5           GPIO19 │
           │ GPIO4           GPIO18 │
           │ GPIO2           GPIO5  │
           │ GPIO0           GPIO4  │
           │ GPIO35          GPIO0  │
           │ GPIO34          GPIO35 │
           │ GPIO39          GPIO34 │
           │ GPIO36          GPIO39 │
           │ GPIO16 (RX2)  GPIO36   │
           │ GPIO17 (TX2)  GPIO39   │
           │ 3V3           EN       │
    3V3 ◄───│ GND           GPIO16   │◄── RX (NEO-6M)
           └────────────────────────┘
```

---

## Optional: External LED Indicators

| LED | Pin | Purpose |
|-----|-----|---------|
| GPS Fix (green) | GPIO 25 | Blinks on fix, solid on good HDOP |
| MPU OK (blue) | GPIO 26 | Solid when MPU self-test passes |
| Danger (red) | GPIO 27 | High accel/tilt warning |
| Status (RGB) | GPIO 13/12/14 | Combined status (PWM) |

> Not implemented in current firmware. Add if desired.

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| GPS never fixes | Antenna orientation, clear sky, 5+ min cold start |
| MPU FAIL pill | I2C wiring (SDA/SCL), 0x68 address, 3.3V power |
| WiFi won't connect | SSID/password in `secret.txt`, 2.4 GHz only |
| MQTT won't connect | Broker reachable, port 8884, TLS cert valid |
| No history upload | `HISTORY_URL` + `HISTORY_KEY` in `history_secret.h` |
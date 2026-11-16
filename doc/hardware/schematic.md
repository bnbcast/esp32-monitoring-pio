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

## Power Stability: USB vs MT3608 Boost

The board behaves differently on USB and on a battery + MT3608 because the two
sources have very different output impedance.

| | USB-C from PC | 5 V battery → MT3608 |
|---|---|---|
| Source | Regulated, 1–3 A available | Switching boost, limited output caps |
| Wiring | Short, thick | Often long/thin dupont or breadboard |
| Transient response | Stiff; bulk caps absorb Wi-Fi bursts | Sags on a 300–500 mA TX pulse |
| Result | Stable Wi-Fi + I²C | Brownout resets, Wi-Fi drops, MPU NACKs |

The ESP32 radio draws short **300–500 mA** bursts at 3.3 V every beacon/TX
window. The DevKit's AMS1117 needs ~1.1–1.3 V of headroom, so a 5.0 V boost set
point is already marginal; if the MT3608 output dips to ~4.5 V the 3.3 V rail
falls, the brownout detector trips, and the MPU6050 starts returning I²C NACKs.
That is why the same firmware and the same open `ESP32` AP look stable on USB
and “sometimes connected” on battery.

### Fix checklist

1. **Set the MT3608 to 5.3–5.5 V**, measured at the ESP32 `5V`/`VIN` pin while
   the board is connected and transmitting — not open-circuit. Stay below 6 V.
2. **Add bulk capacitance at the board**: 470–1000 µF low-ESR electrolytic plus
   100 nF ceramic across `5V`/`GND`, and 100 µF + 100 nF across `3V3`/`GND` if
   the 3.3 V pin is accessible.
3. **Add 22–47 µF** at the MT3608 input and output if the module lacks them.
4. **Use short, thick power wires** (18–20 AWG), soldered or screw terminals.
   Do not run the boost output through a breadboard.
5. **Battery must supply ≥1 A continuous and ≥2 A peaks.** Small protected
   5 V packs and 9 V-style batteries sag or trip their protection.
6. **Use one power path at a time.** Do not connect USB and the boost to `5V`
   together; use a Schottky (SS34) or ideal-diode OR-ing if both are needed.
7. **Keep the boost inductor/switch node away** from the GPS antenna and I²C
   wires. Twist SDA/SCL with a ground return and keep them under ~20 cm.
8. **Measure with a scope, not a multimeter.** A multimeter averages away the
   millisecond dips. Target: 5 V rail stays above 4.8 V, 3.3 V above 3.1 V
   during connect/TX.

### Firmware mitigations (already applied)

| Change | Effect |
|--------|--------|
| Wi-Fi TX power set to 15 dBm | Cuts the dominant current peak by roughly a third |
| `sys.brown` / boot banner `brownouts N` | Counts actual brownout resets in NVS |
| I²C bus recovery after 5 failed reads | Re-inits the bus instead of staying in MPU FAIL |

These reduce the symptom; they do not replace the bulk capacitors and a
correctly set boost output.

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| GPS never fixes | Antenna orientation, clear sky, 5+ min cold start |
| MPU FAIL pill | I2C wiring (SDA/SCL), 0x68 address, 3.3V power |
| MPU FAIL only on battery | 3.3 V rail sag / boost ripple — add 100 µF + 100 nF, check LDO headroom |
| WiFi connects then drops on battery | Boost output sag on TX bursts — set 5.3–5.5 V, add 1000 µF bulk cap, shorter power wires |
| `reset BROWNOUT` or rising `brownouts` | Supply is sagging; USB is fine, fix the boost/battery path |
| WiFi won't connect | SSID/password in `src/wifi_config.h`, 2.4 GHz only; serial log prints visible SSIDs |
| MQTT won't connect | Device uses `broker.hivemq.com:1883` (TCP); browser uses `wss://...:8884/mqtt`. Check serial for `mqtt OK` |
| No history upload | `HISTORY_URL` + `HISTORY_KEY` in `history_secret.h` |
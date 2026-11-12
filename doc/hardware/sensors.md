# Sensor Specifications & Configuration

---

## NEO-6M GPS Module

### Specifications

| Parameter | Value |
|-----------|-------|
| **Chip** | u-blox NEO-6M |
| **Receiver** | 50-channel, GPS L1 C/A |
| **Update Rate** | 1 Hz (default), up to 5 Hz |
| **Accuracy** | 2.5 m CEP (autonomous) |
| **Acquisition** | Cold: 27 s, Warm: 5 s, Hot: 1 s |
| **Sensitivity** | Tracking: -161 dBm, Reacq: -160 dBm, Cold: -148 dBm |
| **Interface** | UART, 9600 baud (default), 8N1 |
| **Protocol** | NMEA 0183 + u-blox binary (UBX) |
| **Power** | 3.0–3.6 V, 37 mA (acquisition), 25 mA (tracking) |
| **Antenna** | Integrated ceramic patch (25×25 mm) |
| **Backup** | VBAT pin for RTC + ephemeris (supercap/coin cell) |

### NMEA Sentences (enabled by default)

| Sentence | Description | Used By Firmware |
|----------|-------------|------------------|
| `GGA` | Global positioning fix data | ✅ lat, lng, alt, fix, sats, HDOP |
| `RMC` | Recommended minimum | ✅ lat, lng, speed, course, date, time |
| `GSA` | DOP and active satellites | ✅ HDOP, fix quality |
| `GSV` | Satellites in view | (sats count) |
| `VTG` | Track made good | (speed, course backup) |

### Key Configuration (via UBX)

```cpp
// Set 1 Hz update rate (default)
uint8_t rate[] = {0x06, 0x08, 0x06, 0x00, 0xE8, 0x03, 0x01, 0x00, 0x01, 0x00};

// Disable unused sentences to reduce UART traffic
uint8_t gll_off[]  = {0x06, 0x01, 0x08, 0x00, 0xF0, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01};
uint8_t gsa_off[]  = {0x06, 0x01, 0x08, 0x00, 0xF0, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01};
uint8_t gsv_off[]  = {0x06, 0x01, 0x08, 0x00, 0xF0, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01};
uint8_t vtg_off[]  = {0x06, 0x01, 0x08, 0x00, 0xF0, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01};
uint8_t zda_off[]  = {0x06, 0x01, 0x08, 0x00, 0xF0, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01};
```

> Current firmware uses defaults (1 Hz, all sentences). Parser ignores unknown sentences.

---

## MPU6050 IMU

### Specifications

| Parameter | Value |
|-----------|-------|
| **Chip** | InvenSense MPU-6050 |
| **Accelerometer** | 3-axis, ±2/±4/±8/±16 g |
| **Gyroscope** | 3-axis, ±250/±500/±1000/±2000 °/s |
| **DMP** | Digital Motion Processor (not used) |
| **Interface** | I2C, up to 400 kHz |
| **Address** | 0x68 (AD0=GND) or 0x69 (AD0=VCC) |
| **Power** | 2.375–3.45 V, 3.9 mA (active) |
| **Temp Sensor** | ±1°C accuracy, -40 to +85°C |

### Configuration (Firmware)

```cpp
// Accel: ±2g (16384 LSB/g)
mpu.setFullScaleAccelRange(MPU6050_ACCEL_FS_2);

// Gyro: ±250°/s (131 LSB/°/s)
mpu.setFullScaleGyroRange(MPU6050_GYRO_FS_250);

// DLPF: 44 Hz (bandwidth)
mpu.setDLPFMode(MPU6050_DLPF_BW_44);

// Sample rate: 1 kHz / (1 + SMPLRT_DIV) = 100 Hz
mpu.setRate(9);  // 1000/(1+9) = 100 Hz
```

### Sensor Fusion (Complementary Filter)

```cpp
// Roll/Pitch from accelerometer (noisy, absolute)
accelRoll  = atan2(ay, az) * RAD_TO_DEG;
accelPitch = atan2(-ax, sqrt(ay*ay + az*az)) * RAD_TO_DEG;

// Gyro integration (drift-free short term, relative)
gyroRoll  += gx * dt;
gyroPitch += gy * dt;

// Fuse: 98% gyro, 2% accel
fusedRoll  = 0.98 * (fusedRoll  + gx * dt) + 0.02 * accelRoll;
fusedPitch = 0.98 * (fusedPitch + gy * dt) + 0.02 * accelPitch;

// Yaw: gyro-only (no magnetometer)
fusedYaw += gz * dt;  // drifts ~1°/min
```

| Output | Source | Latency | Drift |
|--------|--------|---------|-------|
| Roll | 98% gyro + 2% accel | ~10 ms | <0.1°/min |
| Pitch | 98% gyro + 2% accel | ~10 ms | <0.1°/min |
| Yaw | Gyro only (integrated) | ~10 ms | ~1°/min |

---

## NEO-6M + MPU6050 Timing

```
t=0ms      GPS UART byte arrives
    │
    ├─ parse NMEA → gpsFix, lat, lng, kmh, cog, hdop, sats
    │
    ├─ MPU I2C read (100 Hz) → accel, gyro
    │       │
    │       └─ complementary filter → roll, pitch, yaw
    │
    └─ build JSON payload
         │
         └─ MQTT publish (1 Hz)
```

- GPS: 1 Hz (NMEA sentences arrive ~once/sec)
- MPU: 100 Hz I2C reads, fused at 100 Hz
- MQTT: 1 Hz publish (aligned with GPS)

---

## Sensor Calibration

### MPU6050 (run once, store offsets in NVS)

```cpp
// On first boot or when "calibrate" command received
mpu.CalibrateAccel(6);   // 6 samples per axis
mpu.CalibrateGyro(6);
mpu.PrintActiveOffsets();
// Save to NVS: mpu.GetAccelOffset(), mpu.GetGyroOffset()
```

### GPS (no calibration needed)

- Cold start: ensure clear sky, 5+ minutes
- HDOP < 1.5 = excellent, 1.5–2.5 = good, >3 = poor
- Firmware rejects fixes with HDOP > 6

---

## Troubleshooting

| Symptom | Sensor | Check |
|---------|--------|-------|
| `MPU FAIL` pill | MPU6050 | I2C wiring, 0x68 address, 3.3V, `mpu.testConnection()` |
| `GPS WAIT` > 5 min | NEO-6M | Antenna sky view, UART wiring, baud 9600, cold start time |
| HDOP > 6 | NEO-6M | Obstructed sky, multipath, antenna orientation |
| Roll/Pitch stuck | MPU6050 | I2C bus contention, DLPF setting, accel range |
| Yaw drifts fast | MPU6050 | Gyro offset not calibrated, DLPF too high |

---

## Data Quality Metrics (published in MQTT)

| Field | Good | Warning | Critical |
|-------|------|---------|----------|
| HDOP | < 1.5 | 1.5–3.0 | > 3.0 |
| Satellites | ≥ 8 | 5–7 | < 5 |
| MPU temp | -10 to 50°C | -20 to 60°C | outside |
| Free heap | > 150 KB | 50–150 KB | < 50 KB |
| WiFi RSSI | > -60 dBm | -60 to -80 | < -80 dBm |
# Orion Project — Documentation Index

This directory contains comprehensive documentation for the Orion Project: a live GPS/telemetry dashboard for one race vehicle running on ESP32.

## Contents

| Category | File | Description |
|----------|------|-------------|
| **API Reference** | [api/endpoints.md](api/endpoints.md) | All HTTP endpoints, request/response schemas, auth |
| **API Reference** | [api/history.md](api/history.md) | History ingestion & query API (Cloudflare Pages Function) |
| **API Reference** | [api/mqtt.md](api/mqtt.md) | Live MQTT topic structure, payload format |
| **Project Structure** | [project/structure.md](project/structure.md) | Repository layout, module responsibilities |
| **Project Structure** | [project/firmware.md](project/firmware.md) | ESP32 firmware architecture, build, flash |
| **Project Structure** | [project/dashboard.md](project/dashboard.md) | Dashboard JS modules, data flow, rendering |
| **Project Structure** | [project/testing.md](project/testing.md) | Unit tests, browser probes, CI |
| **Hardware** | [hardware/schematic.md](hardware/schematic.md) | ESP32 + NEO-6M + MPU6050 wiring, pinout |
| **Hardware** | [hardware/sensors.md](hardware/sensors.md) | Sensor specs, config, calibration |

## Quick Links

- **Live Dashboard**: https://bnbcast.github.io/esp32-monitoring-pio/
- **History API**: https://race-tracker-history.pages.dev/
- **Repository**: https://github.com/bnbcast/esp32-monitoring-pio
- **MQTT Broker**: wss://broker.hivemq.com:8884/mqtt

## Project Overview

| Aspect | Detail |
|--------|--------|
| **Name** | Orion Project |
| **Hardware** | Classic ESP32 (`esp32doit-devkit-v1`), NEO-6M GPS, MPU6050 IMU |
| **Transport** | ESP32 → public HiveMQ (wss) → Dashboard |
| **History** | ESP32 → HTTPS batch (30s) → Cloudflare Pages Function → D1 |
| **Dashboard** | Static site (GitHub Pages), vanilla JS, MapLibre GL |
| **Firmware** | PlatformIO + Arduino, `esp32-mqtt-simple` env |
| **Version** | Dashboard `?v=53`, Firmware `orion 1.4.0` |

## Branding

All surfaces use **Orion Project** branding:
- Page title: `Orion Project`
- Header wordmark: `Orion / LIVE` with mascot
- Dynamic state: `DREAMING` → `WENT SLEEPING` → `WAITING...` → `STRETCHING` → `LIVE`
- Favicon/app icons: 32–512px from mascot PNG
- Kawaii mascot cursors (11 emotional states)
- Midnight mode (00:00–04:00 local)

---

*Generated from commit `ecdc832` — see [CHANGELOG](../CHANGELOG.md) for history.*
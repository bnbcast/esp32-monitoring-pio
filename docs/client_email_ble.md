Subject: JK-BMS integration — 3 questions for you (we'll handle the rest)

Hi,

We're adding JK-BMS battery telemetry to the ESP32 vehicle tracker over BLE. Most of the discovery work we can do in-house, so we only need three things from you:

1. Physical distance between the BMS and the ESP32 in the vehicle — determines whether BLE range is viable, or whether we need an RS485/UART fallback.
2. Target BMS refresh interval (e.g., 5 s, 10 s, 30 s) — affects the MQTT payload size and BLE duty cycle.
3. Do you want a BMS panel on the web dashboard, or is the MQTT topic (a `bms` object inside the existing `esp32-dash/<KEY>/data` topic) enough?

What we'll handle ourselves — no client input needed:

- BMS model and firmware version: read from the BMS label and the JK app's device info screen.
- BLE MAC address / device name and service/characteristic UUIDs: we'll scan with the nRF Connect app. Please use an Android phone if possible — nRF Connect on iOS hides the real BLE MAC address and shows a UUID instead, which we can't use to connect by address.
- Whether the phone JK app can connect while the ESP32 holds the BLE link: we'll test this on hardware using the connect-read-disconnect poll pattern.

Once we have your answers to questions 1–3, we'll proceed to the standalone BLE prototype phase.

Thanks,

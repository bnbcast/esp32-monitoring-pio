# Baseline — measured facts

Recorded on branch `phase-a-baseline`, base commit `7c37e17`.
Anything marked **(board)** still needs the physical device on COM4.

## Build (verified locally)

```
pio run -e esp32-mqtt-simple      # after huge_app.csv + the history module
RAM:   16.3%  (53,280 / 327,680 bytes)
Flash: 40.6%  (1,275,912 / 3,145,728 bytes)
```

Before the partition change the same tracker used 79.8% of a 1.25 MiB slot.
With `huge_app.csv` there are **1.87 MB free** for TLS, the LittleFS ring
buffer and future code. The OTA slot is gone; USB flashing is the update path.
The history module costs ~230 KB of flash and ~1 KB of RAM at rest; the TLS
client is allocated only during a batch.

| Item | Value |
|---|---|
| PlatformIO | 6.2.0 |
| Framework | Arduino-ESP32 3.3.12 |
| Board | `esp32doit-devkit-v1`, 4 MB flash |
| Libraries | PubSubClient 2.8.0, TinyGPSPlus 1.1.0 |
| Serial | COM4, 115200 |

## Partition layout (from the Arduino core package)

`huge_app.csv`, **applied and flashed** (`board_build.partitions` in
`platformio.ini`):

| Partition | Size | Note |
|---|---|---|
| nvs | 20 KB | boot counter |
| otadata | 8 KB | |
| app0 | 3,145,728 B (3 MiB) | 33.3% used |
| spiffs | 917,504 B (896 KB) | LittleFS ring buffer target |
| coredump | 64 KB | |

**Decision:** approved by the owner. It triples application space and keeps
896 KB for the batch buffer, at the cost of the OTA slot that nothing uses.
Flashing the new table requires one USB reflash; done on 2026-11-09.

## TLS and ECDSA on the board (measured)

One-shot bench build (`pio run -e esp32-bench`), ESP32-D0WD-V3, RSSI -40,
`cloudflare.com:443` (the future Worker's front end):

| Measurement | Result |
|---|---|
| TLS connect, `setInsecure()` | 800 ms, 43.4 KB heap |
| TLS connect, built-in CA bundle | 1,731–1,981 ms, 42.6 KB heap |
| Peak transient | ~98 KB below the pre-connect free heap |
| Low-water free heap | 132,072 B (bench had 230 KB before) |
| ECDSA P-256 keygen | 163 ms |
| ECDSA P-256 sign | **174 ms** avg (20 runs), 72 B signature |
| ECDSA key heap | ~1 KB |

Consequences for W3:

- A 30 s batch fits comfortably: one handshake per batch, not per frame.
- Verification is affordable, so `setInsecure()` is not needed.
- **Never sign per frame.** 174 ms at 1 Hz is 17% of one core; one signature
  per 30 s batch is ~0.6% duty and still proves the whole batch.

## Transport

| Item | Value |
|---|---|
| Broker | `broker.hivemq.com` |
| Firmware port | 1883, **plain TCP, no TLS** |
| Dashboard port | 8884, WSS |
| QoS | 0 |
| Retained | yes, on both data and status |
| Publish cadence | 500 ms → **1000 ms** (changed on this branch) |
| Buffer | `mqtt.setBufferSize(2048)`, payload buffer 1200 B |
| Offline queue | 3 slots × 1024 B, oldest dropped |

Visible consequence: the live position is world-readable on a public broker,
and anyone can publish to the same topic. That is accepted (public data is
intended) and mitigated on the dashboard by `web/ui/guard.js`.

## Payload fields (as published today)

```
seq, ts (GPS epoch, 0 when unknown), up (uptime s), mpu,
roll, pitch, yaw, tilt, ax, ay, az, temp, lvl, warn, danger, maxTilt, peakA,
acs{ok, amps, v, zero},
gps{chars, view, snr, q, bad, sats, fix, lat, lng, alt, kmh, cog, hdop,
    dist_m, utc_h, utc_m, utc_s, utc_y, utc_mo, utc_d},
sys{heap, rssi, wifi{ssid, bssid, channel, status, ip, mac}}
```

Position is withheld entirely (`lat`/`lng` = `null`) unless sats ≥ 4 **and**
HDOP ≤ the configured gate. The gate moved from 20 to 8 on this branch.

## Dashboard

| Item | Value |
|---|---|
| Files | `web/index.html`, `web/ui/app.js`, `web/ui/map.js`, `web/ui/mqtt-mini.js`, `web/ui/guard.js` |
| MQTT client | custom, read-only; cannot publish |
| Stale threshold | 6 s (`STALE_AFTER_MS`) |
| Map | MapLibre 3.6.2 (local, `-csp` build), OpenFreeMap Liberty vector |
| Raster fallback | Esri World Street → Esri Topo → OSM tiles |
| Geocoding | public Nominatim, min 8 s and 80 m between calls, 110 m cache cells |
| CSP | present, `script-src 'self'`, no CDN |
| Tests | none before this branch |

## Secrets

| Secret | Location | Status |
|---|---|---|
| Wi-Fi password | `src/wifi_config.h` | in source and git history — burned |
| `TOPIC_KEY` | `mqtt_simple.cpp`, `web/ui/app.js` | **not a secret**; fixed slug `race-tracker` |
| `.env` | repo root | gitignored, AI provider keys |

`TOPIC_KEY` is now a readable default shared by firmware and dashboard, so a
fork works with no edits. It was never secret (it shipped in public JS); the
20-hex value only created a two-file edit. A second tracker changes that one
firmware line and opens the dashboard with `#t=<slug>`. The plausibility gate,
not the topic name, is the protection.

## Long-uptime diagnostics (published in `sys`)

| Field | Source | Use |
|---|---|---|
| `sys.heap` | `ESP.getFreeHeap()` at publish time | current headroom |
| `sys.heap_min` | lowest free heap seen since boot | catches a slow leak before it bites |
| `sys.boot` | `RTC_DATA_ATTR bootCount` | a rising value across sessions is a reboot loop |

The task watchdog is armed at the end of `mqtt_simple_setup()` with a 30 s
timeout, and `esp_task_wdt_reset()` runs at the top of `mqtt_simple_loop()`.
A hang therefore reboots the chip, and the next payload's `sys.boot` proves it.
The heap warning is logged once per boot below 40,000 bytes.

**Verified on the board** (flash 2026-11-09): boot without an IMU, `task
watchdog armed (30 s)`, `ready`, Wi-Fi + MQTT up, 1 Hz on the new topic, and
`heap_min` present in every frame. Over 7.5 minutes: `boot=1`, `seq=421`,
`heap=216120`, `heap_min=206456` — no reboot and no downward heap trend.

## History path on the board (measured)

Self-test build (`pio run -e esp32-history-test`, which adds `-DHISTORY_SELFTEST`),
continuous serial capture, `race-tracker-history.pages.dev`:

| Step | Observed |
|---|---|
| Mount + task start | `history ready: ...pages.dev/ingest, 0 B buffered, offset 0` |
| Enqueue | `self-test: 3 synthetic frames queued` |
| RAM buffer → flash | `stored 1` after the first 10 s flush, `stored 3` after the next |
| TLS + POST | `POST /ingest -> 200 in 3711 ms` |
| Ack + delete | `3 frames acked, queue 0 B` |
| Read back | `/history` returned all 3 points, `ts` ascending, `lat -6.9123` |

The request body is 3 × 161 B = 483 B, i.e. one TLS handshake per 30 s costs
~1.8 s of core time and ~43 KB of peak heap, matching the bench numbers. The
test rows were deleted from D1 afterwards.

The watchdog did not fire during the TLS handshake, confirming the history task
and the loop task coexist without a stall.

## Dashboard history view (measured)

`dev/check-history.mjs` drives a real Chromium against the local static server,
opens the HIST tab and asks for the last hour. Three synthetic fixes were
inserted through `POST /ingest` first and deleted from D1 afterwards.

| Check | Result |
|---|---|
| Points shown | `3` |
| Distance | `0.02 km` (two 60 s steps) |
| Max gap | `60 s` |
| Window | `07:02 - 07:04 UTC` |
| Status | `drawn as 1 line(s)` |
| GeoJSON features | `1` polyline |
| Page / CSP errors | none |
| Phone viewport 390x844 | same result |
| Live GitHub Pages `?v=25` | `check-live` PASS (map ready, broker OK, no errors/CSP); `check-history` points 3, drawn as 1 line |

The probe found a real bug before release: the 1 h / 6 h / 24 h buttons used
`.mini-btn`, which is absolutely positioned for the odometer reset, so all
three landed on the same spot and the 24 h button swallowed the click. They now
have their own `.hist-btn` segmented style.

## INFO tab: interactive glossary (measured)

The first version was one long list of 72 definitions, which is unreadable in a
390 px bottom sheet. It is now an index: 9 collapsible areas, a search box, a
chip per area, and one term open at a time. Tapping a field label anywhere in
the dashboard opens the matching entry.

| Check | Result |
|---|---|
| Unit tests | 5/5: data parses, 73 terms, unique, every displayed field covered, label-to-term resolution (`Tilt` -> LIVE vs `Tilt (MPU)`, `Status` -> WIFI/ACS/HIST) |
| `dev/check-info.mjs` local | desktop 1440x900 and phone 390x844 PASS |
| Collapsed start | 9 area headers, 0 terms, 0 paragraphs visible |
| Area open | first area lists 5 term rows, still 0 paragraphs |
| Search `hdop` | 1 hit, auto-opened, `1 of 73 terms`, text mentions dilution |
| Chip `WiFi` | 1 area, 11 terms |
| Label tap | HDOP label on LIVE -> INFO active, LIVE area open, HDOP definition |
| Layout | no horizontal overflow (0 px), no clipped tab buttons, panel scrolls |

Search prefers term matches over body text: "hdop" used to return 5 hits because
other entries mention HDOP in passing.

## Long-uptime soak (measured)

A serial capture writes every panel line, so `up`, `heap`, `rssi` and the HIST
counters can be read back with `dev/`-style parsing (ANSI stripped first).

| Session | Continuous run | Boots | Heap | Watchdog | Fatal |
|---|---|---|---|---|---|
| interrupted by host restart | 8 min 59 s (539 s) | 1, power-on | 184-192 KB, 187 KB at the end | armed, never fired | none |
| 60 min soak | running | | | | |

Heap over the 9-minute session: 192, 187, 187, 187, 186, ... 187 KB. There is
no downward trend, `boot` stayed at 1 and no `Guru Meditation` / `panic` line
appeared. HIST counters stayed `queued 0 stored 0 sent 0 fail 0 drop 0`, which
is expected indoors: the GPS had no NMEA, so no fix was ever enqueued.

The 60-minute run is the one that backs the "long uptime" claim; this table is
updated with its numbers when it finishes.

## ACS712 presence: the false "OK" (found by the owner)

With nothing wired to GPIO34 the dashboard showed `ACS OK`. Two independent
checks were both wrong in the same way:

| Layer | Old check | Why it passed with no sensor |
|---|---|---|
| Firmware `acsWiringOK()` | `acsFiltV` in 0.3-4.9 V | the floating pin sits at 0.51 V and calibration adopts it as the zero |
| Dashboard `acsUpdate()` | raw `vTrue` in 0.3-4.9 V | same window, and it overrode the firmware bit |

Both now require the **calibrated zero** to be near mid-supply, 2.2-2.8 V
(the ACS712 rests at half its 5 V supply; 0.51 V means "nothing attached").
The live reading stays bounded only by the ADC range, because it moves with
current by design: +/-30 A would leave any mid-supply band.

Evidence:

| Check | Result |
|---|---|
| Firmware build | green, RAM 16.3% (53,288 B), flash 40.6% (1,276,000 B) |
| Dashboard unit probe (Chromium) | `ok=false, v=0.51` -> `inRange=false`; `ok=true, v=2.50` -> `inRange=true` |
| Live `?v=26` | deployed, `check-live` PASS, no page/CSP errors |
| Serial `acs FAIL` after flash | pending: the board is off USB (no COM ports at the time of writing) |

## Wide-window sampling (fixed, verified)

A day at 1 Hz is ~86k rows; the old API returned the first 5000 rows and called
that "24 hours". `/history` now counts the window, picks
`step = ceil(total / limit)`, and returns every step-th real row (never an
average of coordinates) with `total`, `step` and `sampled` in the body.

| Check | Result |
|---|---|
| Unit tests | 17/17 (new: 1000 rows, limit 100 -> `step 10`, spans the window) |
| Real D1 | 600 seeded rows -> `count 100`, `total 600`, `step 6`, first at `t0`, last at `t0+594` |
| Gap semantics | `maxGap` comes from the raw rows (LAG), so a sampled window still reports real outages, not the sample interval |
| Probe cleanup | 600 rows deleted, `/history` back to 0 |

## Retention in production (fixed, verified)

The Worker's `scheduled()` handler plus `[triggers] crons` never ran in
production: the API is a **Pages Function**, and Pages has no cron triggers, so
the 365-day delete was dead code. D1 would have grown forever.

Ingest now drives it, throttled by a `meta` row (`key='retention'`):

| Check | Result |
|---|---|
| Unit tests | 16/16, including "purges once, then reports skipped, then purges again after 24 h" |
| Remote schema | `meta` table applied (`num_tables: 2`) |
| Production purge | seeded a 400-day-old row, `POST /ingest` -> `"retention":1` |
| Read back | ancient window `0 points`; fresh probe `1 point`; probe deleted -> `0` |
| Failure mode | purge errors reset the marker and never fail the ingest |

## Watchdog init (fixed in code, needs flash)

The boot log carried two lines that should not be there:

```
E task_wdt: esp_task_wdt_init(517): TWDT already initialized
E task_wdt: esp_task_wdt_reset(707): task not found
```

The first is cosmetic: the Arduino core initialises the TWDT before setup, and
the code called `init()` again. The second appeared once, meaning at least one
`reset()` ran while the loop task was not registered as a subscriber.

`setup()` now probes with `esp_task_wdt_status(NULL)` and chooses `init()` vs
`reconfigure()`, and it checks the `add()` result while accepting "already
subscribed". Build is green (flash 40.6%); runtime confirmation is pending
because the board is off USB.

## Still needs the board

1. Flash `0dd61cd` + watchdog commit; confirm `acs FAIL`, `zero 0.510 V`, and
   that the two `task_wdt` error lines are gone.
2. The 60-minute soak, on that binary.
3. Real parked wander radius (lat/lon spread over 10 minutes).
4. One drive capture (route, speed, odometer).

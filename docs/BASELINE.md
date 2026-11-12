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
roll, pitch, yaw, tilt, ax, ay, az, temp, lvl, warn, danger, maxTilt,
gps{chars, view, snr, q, bad, sats, fix, lat, lng, alt, kmh, cog, hdop,
    dist_m, ttff_s, rej, still, mode, utc_h, utc_m, utc_s, utc_y, utc_mo, utc_d},
lap{on, n, last_ms, best_ms, la[lat,lng], lb[lat,lng]},
sys{heap, heap_min, boot, rssi, wifi{ssid, bssid, channel, status, ip, mac}}
```

Position is withheld entirely (`lat`/`lng` = `null`) unless sats ≥ 5, HDOP ≤ 4
and the receiver reports a 3D fix. Two further gates run on the accepted fixes:
one implying over 200 km/h is dropped (`gps.rej`), and below 1 km/h the published
coordinate is frozen until 8 m of real displacement (`gps.still`). There is no
current sensor: `acs`, `peakA` and the ADC pin are gone.

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
| Tests | 94 unit tests (`guard` 14, `info` 5, `lap` 15, `gps` 6, `led` 15, `mpu3d` 13, `sessions` 16, `ui` 10) plus browser probes in `dev/` |

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

## Map cost on a phone (measured)

`node dev/check-map-perf.mjs` opens the page at 390x844 with a 3x screen, applies
a 4x CPU slowdown and records frame pacing, long tasks, the drawing buffer size,
visible layers and how often each source is re-uploaded. Chromium here renders
through SwiftShader (software rasteriser), so the absolute numbers are far worse
than a real phone; they are useful only as a before/after on the same probe.

| Measurement | Before | After |
|---|---|---|
| Drawing buffer | `1098x1107` (3x) | `732x738` (2x cap) |
| Decorative layers drawn | 117/117 | 112/117 (5 hidden) |
| Text/symbol layers visible | 25/25 | **25/25 - unchanged** |
| Frame rate (12 s sample) | 3.2 fps | 4.4-6.4 fps |
| p95 frame time | 400 ms | 200-350 ms |
| Long tasks / 8 s | 7030 ms | ~6300 ms |
| `accuracy` uploads | 11.98 /s | ~5 /s (one per fix) |

What changed, and what deliberately did not:

- The drawing buffer is capped at `pixelRatio` 2. On a 3x phone that removes
  more than half the pixels painted per frame and is invisible at arm's length.
- Only decoration is hidden on phones: `building`, `building-3d`,
  `aeroway_fill`, `aeroway_runway`, `aeroway_taxiway`. These are fills and lines.
- **Every label stays.** All 25 symbol layers remain visible, so street names,
  district and city names, POIs and airport names still render - the probe
  asserts `highway-name-major` and `label_city` are never hidden.
- Tile fade is shortened from 300 ms to 100 ms on phones, because a fade repaints
  every freshly loaded tile.
- The accuracy circle was uploaded twice per fix and the heading wedge on every
  fix even when nothing changed. Both now cache a small key and skip the
  upload, and the accuracy payload is smaller.
- `resize()` ignores changes under 2 px and the dashboard debounces
  `resize` / `orientationchange` / `visualViewport` by 150 ms. A roaming phone
  fires these constantly as the URL bar tucks away; each one used to rebuild the
  whole map surface.

The dev simulator publishes at 5 Hz; the board publishes 50 frames/s over MQTT,
but its NMEA source is 1 Hz out of the box and 5 Hz once the UBX configuration
is acknowledged, so positions only change at that rate.

## Phone controls: lock, sheet, full screen (measured)

| Check (`dev/check-mobile.mjs`) | Result |
|---|---|
| Sheet open at start | 321 px tall, handle 24 px tall |
| Sheet folded | 90 px (tab bar only), map 381 -> 612 px |
| Full screen | map 844 px of 844, top bar and panel hidden, canvas resized |
| `Esc` / `F` | leaves full screen, panel returns |
| Camera lock | `aria-pressed`, `MAP.isFollowing()`, `localStorage.followLock` all agree |
| Lock survives reload | yes |
| Pan releases lock | yes (real CDP touch drag moves the camera, lock clears, stored `0`) |
| Tab switch resets panel scroll | yes (`scrollTop` back to 0) |
| Document scrolling | none (`html`/`body` `overflow: hidden`, `overscroll-behavior: none`) |

Two real bugs were found by this probe rather than by eye:

1. A locked camera used to `easeTo` the vehicle on **every** fix. MapLibre
   refuses to begin a drag while the camera is animating, so a locked map could
   not be panned to release the lock - the log showed `touchstart` and then
   nothing. Lock now uses a 30-70% band, so the camera is idle most of the time,
   and a capture-phase `touchstart`/`mousedown` listener calls `map.stop()`
   before MapLibre sees the gesture.
2. The map button icons are inline SVGs and the generic `button` padding applied
   to them, squeezing a 21 px icon into a 4 px box. `.map-btn` now has
   `padding: 0` and `.map-btn svg { flex: 0 0 auto }`.

Page-level pull-to-refresh was the "mobile page keeps refreshing" report:
`html`/`body` now set `overscroll-behavior: none`, the panel scroller sets
`overscroll-behavior: contain`, and the phone layout makes the document itself
non-scrollable. All three are static invariants in `test/ui.test.js`.

## INFO tab: interactive glossary (measured)

The first version was one long list of 72 definitions, which is unreadable in a
390 px bottom sheet. It is now an index: 8 collapsible areas, a search box, a
chip per area, and one term open at a time. Tapping a field label anywhere in
the dashboard opens the matching entry.

| Check | Result |
|---|---|
| Unit tests | 5/5: data parses, 69 terms, unique, every displayed field covered, label-to-term resolution (`Tilt` -> LIVE vs `Tilt (MPU)`, `Status` -> WIFI/HIST) |
| `dev/check-info.mjs` local | desktop 1440x900 and phone 390x844 PASS |
| Collapsed start | 8 area headers, 0 terms, 0 paragraphs visible |
| Area open | first area lists 4 term rows, still 0 paragraphs |
| Search `hdop` | 1 hit, auto-opened, `1 of 69 terms`, text mentions dilution |
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
| 2026-11-11, after flash, no sensors | not completed - the board was re-flashed during the window | - | 187-194 KB observed | armed, never fired | none |
| 2026-11-12, 1-minute capture, ESP32 only | 65 s | 0 resets (boot #14 throughout) | 189 → 188 KB | armed, never fired | none |

The 1-minute capture (2026-11-12) ran on the flashed binary with no GPS and no
IMU attached: `SYS up` went 00:04:02 → 00:05:06, heap 189 → 188 KB, RSSI -48 →
-58 dBm, `tx` 230 → 294 (64 frames in 64 s, 1 Hz publish), `ok` matched `tx` and
`fail`/`drop` stayed 0, HIST stayed `0/0/0/0/0, buf 0 B`, 33 panel refreshes
arrived on the 2 s cadence, no `boot #` line and no panic/watchdog line in the
window.

Heap over the 9-minute session: 192, 187, 187, 187, 186, ... 187 KB. There is
no downward trend, `boot` stayed at 1 and no `Guru Meditation` / `panic` line
appeared. HIST counters stayed `queued 0 stored 0 sent 0 fail 0 drop 0`, which
is expected indoors: the GPS had no NMEA, so no fix was ever enqueued.

The 60-minute run is the one that backs the "long uptime" claim; this table is
updated with its numbers when it finishes.

## Real board, flashed and verified (measured)

The board came back on USB (COM4, CP210x) and the branch was flashed with
`pio run -e esp32-mqtt-simple -t upload`:

| Check | Result |
|---|---|
| Upload | `SUCCESS`, 1,294,880 bytes written, hash of data verified |
| Chip | `ESP32-D0WD-V3 rev 3.1`, 2 cores @ 240 MHz, 4096 KB flash, 265 KB heap at boot |
| Firmware | `esp32-dash 1.3.0` |
| Boot after reset | `rst:0xc (SW_CPU_RESET), boot:0x13 (SPI_FAST_FLASH_BOOT)` |
| Task watchdog | `task watchdog armed (30 s)`; **no `task_wdt` error lines** |
| GPS | fresh boot: `no NMEA data on the RX pin`; module not attached |
| MPU6050 | `mpu FAIL`; module not attached |
| Publish rate | `seq` and the `tx` counter advance once per second |
| Heap over 28 min | 187-194 KB, no downward trend |
| Boot counter | increments once per deliberate `x` reboot, not in between |
| Live dashboard `?v=33` | `BROKER OK`, `DEVICE LIVE`, `GPS NO DATA`, `NO FIX`, no errors |

The watchdog fix is now confirmed at runtime, not just in code: the two lines

```
E task_wdt: esp_task_wdt_init(517): TWDT already initialized
E task_wdt: esp_task_wdt_reset(707): task not found
```

are gone from a real boot log, and `task watchdog armed (30 s)` follows them.

The no-sensor state also exposed a dashboard bug: with no fix the map kept the
vehicle marker at `DEFAULT_CENTER`, which is a real town, and the address line
said "locating address..." forever. The marker is now hidden until the first
fix (and stays at the last known spot, greyed, after a lost fix), and the
address line says "no fix yet". `test/ui.test.js` locks that in.

Evidence that the board is the publisher and the dashboard is the consumer:
`dev/mqtt-watch.mjs --dur 15000` on the public broker showed `seq` 197..208 at
one per second, `sys.boot 1`, `heap 194080`, and the dashboard probe read
`ui/app.js?v=33` with the marker `display: none`.

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

## Watchdog init (fixed and verified)

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
subscribed". A real boot log after the first flash shows `task watchdog armed
(30 s)` and neither `E task_wdt` line.

## GPS conditioning, 5 Hz and lap timing (screen-verified)

The firmware changes are compiled and the dashboard side is verified against the
dev simulator; the board bring-up on 2026-11-12 reached the wiring limits: with
the NEO-6M and MPU6050 mounted, the receiver reports `$GPTXT ... ANTENNA OK` and
one satellite in view indoors (no fix, which is expected without sky view), and
the UBX probe prints `no reply on GPIO 33 - wire module RX to it`, so the 5 Hz
configuration cannot be exercised until that wire exists. Boot count advanced
`#14 -> #19` across the flashes, and the IMU retry produced 0 error lines in 40 s.

| Check | Result |
|---|---|
| Build | `SUCCESS`, RAM 16.3% (53,296 B), flash 40.8% (1,284,064 B), no format warnings |
| ACS removal | grep over `src/`, `web/`, `test/`, `dev/` and the docs: no driver, pin, payload key, tab, pill or glossary entry left |
| Publish gate | sats ≥ 5, HDOP ≤ 4, GSA mode 3 (2D rejected), over-200 km/h jump rejected |
| Shadow gate | `GPS_STRICT_SATS 6` / `GPS_STRICT_HDOP 2.0` are counted per boot, never enforced: the POS line prints `tight n/N (%)`, the share of accepted fixes a stricter gate would have dropped. `test/gps.test.js` proves the strict values cannot reach `gpsFixUsable()` |
| Fix reference | only an accepted fix advances `fixPrev*`; a fix that failed the gate can be 20 m out and must not become a chord endpoint for the finish line |
| Parked hold | speed < 1 km/h freezes the published coordinate; 8 m of real movement releases it |
| Lap engine | forward segment crossing A→B, time interpolated between fixes, minimum 3 s and 5 km/h |
| Lap persistence | `lap/n`, `lap/last`, `lap/best` written once per completed lap and restored by `gpsLoadGates()`; arming a new gate persists the zeroed counters; `l` clears the namespace. `lapCrossMs` is not restored (millis() restarts), so the line re-arms after a reboot |
| UBX | probe at 9600/38400/115200 on GPIO 33; when a module answers: 38400, 5 Hz, automotive, static hold 0.5 m/s (mask 0x0105), SBAS, config saved in the module; with the pin unwired the link stays 9600 8N1 |
| UBX masks | `CFG-NAV5` applies field by field: dynModel bit 0, fixMode bit 2, static-hold threshold bit 8. The previous 0x0041 mask left static hold off while the log claimed it was on |
| UBX diagnostic | when the 38400 switch is not acknowledged, the firmware polls `UBX-MON-VER` on GPIO 33 and prints two different lines: `no reply on GPIO 33 - wire module RX to it` (no wire / wrong pin) versus `module answers on GPIO 33 but ignored 38400` (module refuses the rate). Measured on the mounted unit: **no reply**, which is why the link stayed at 9600 and 5 Hz never engaged |
| IMU I2C | `mpuRead()` retries the 14-byte burst once after 200 µs, so one NACK on a patch cable no longer flips `mpu` to FAIL and back. Measured: 0 `MPU6050 stopped responding` lines in a 40 s capture, versus one pair every 5 s before |
| Wi-Fi latency | `WiFi.setSleep(false)`; the scan matcher now builds one `String` per visible AP instead of one per (AP, candidate) pair, which removes N×M heap churn on every rescan |
| Unit tests | 94/94 (`node --test test/gps.test.js test/guard.test.js test/info.test.js test/lap.test.js test/led.test.js test/mpu3d.test.js test/sessions.test.js test/ui.test.js`) |
| Lap geometry | `test/lap.test.js` (15 tests) mirrors the firmware cross-product and asserts the source still matches; a 144 km/h crossing 37 ms after a fix is timed at 37 ms, where nearest-sample rounding costs up to 100 ms and next-sample up to 163 ms. Five further tests pin the NVS session: saved after `lapCount++`, all three keys written, counters restored at boot with `lapCrossMs = 0`, reset persisted when a gate is armed, namespace cleared by `l` |
| `dev/check-live.mjs` local | PASS, no page/CSP/console errors; `mode 3D`, `ttff 27`, `rejected 3`, laps `15`, last `41.23`, best `39.87`, gate `armed` |
| Gate layer | `queryRenderedFeatures(['gate-line'])` = 1, 3 features (line + 2 ends) |
| Marker | inline SVG arrow, not an emoji glyph |
| `dev/check-info.mjs` | desktop and phone PASS, 8 areas / 69 terms |
| `dev/check-mobile.mjs` | PASS, sheet 321→90 px, map 405→636 px, no scroll |

Two bugs were found by these probes and fixed before the commit: a gate that
arrived while the style was still loading was never drawn (the change was
consumed before the map was ready), and the gate coordinates were passed to
GeoJSON as `[lat, lng]` instead of `[lng, lat]`.

Still missing for this block: flash over USB, a real 3D fix outdoors, the
60-minute soak on this binary, and the extra wire from the module RX to GPIO 33
before the 5 Hz claim can be measured.

## Status LEDs and the "all three on" fault (2026-11-12)

Reported symptom: the three LEDs on GPIO 26/27/32 appeared to light all at once.
Two different faults look identical, and the old code could not tell them apart:

1. **Active-low wiring** (anode to 3V3, cathode to the pin): `ledsOff()` drove all
   three pins LOW, which *lit* all three. The old firmware assumed active-high.
2. **Shorted signal nodes** (one breadboard row for all three anodes): any single
   pin HIGH lights all three, and danger level 0 keeps blue HIGH, so the board is
   steady "all on" even though `mpuValid` is true.

Fault mode (`ledsFault()`, all three blinking every 500 ms) was ruled out on the
mounted board: a 22 s capture shows `mpu OK` on every panel and 0
`MPU6050 stopped responding` lines, so the loop is calling `setLeds()`, not
`ledsFault()`.

| Check | Result |
|---|---|
| Single write path | no `digitalWrite(LED_*_PIN, ...)` remains outside `ledWrite()`; `ledWrite(pin, on)` applies `(on != ledActiveLow) ? HIGH : LOW` |
| Polarity is runtime | `y` inverts `ledActiveLow`, saves it as `sys/ledLow` in NVS, and prints the new state; loaded by `ledLoadPolarity()` *before* the first write at boot |
| Self-test names the colour | boot and `d` run `ledSelfTest()`: 900 ms each for `only BLUE`, `only WHITE`, `only RED`, then all off, each line naming the pin |
| Observed on the board | boot self-test prints `polarity active-low` after `y` was used once, then `active-high` after the next `y`; both survived a soft reset, proving the NVS load |
| Health after change | boot #38, `mpu OK`, `GPS ... nmea 0s ago`, `IMU` tilt live, 0 faults in the capture |
| Build | `SUCCESS`, RAM 16.3% (53,296 B), flash 40.9% (1,285,148 B) |
| Unit tests | 64/64, including `test/led.test.js` (15) |

The three outcomes of the self-test map to three fixes, which is why it exists:

| What "only BLUE" actually shows | Cause | Fix |
|---|---|---|
| blue only | correct | none |
| white + red | polarity inverted | press `y` once (saved) |
| all three | signal nodes shorted | rewire, separate the three LED legs |

Still open: the physical observation of `only BLUE` on this unit, which selects
one of those three rows. Until then the firmware is correct under both polarities
and the boot test says which one it is using.

## HIST tab as a timeline (2026-11-12)

The HIST tab used to be one summary card over the whole window. It is now a list
of sessions: one row per run of stored fixes, with a day header, the local clock
range, duration, distance, top speed and point count. Tapping a row draws only
that stint and frames it; tapping again returns to the whole window.

No backend or firmware change: `boot` is not in `/history`, so a session is
defined by a gap, which the stored telemetry already provides.

| Check | Result |
|---|---|
| Grouping | `web/ui/sessions.js`; a gap strictly greater than 120 s starts a new session, so exactly 120 s stays in one |
| Grouping is pure | no DOM, no map, no fetch; loaded as a classic script and `require()`-able from node, so the tests run the same code the page runs |
| Row content | day header (`Today` / `Yesterday` / `12 Nov`), `HH:MM - HH:MM`, duration, `km`, `km/h max`, `pts` |
| Selection | reuses the points already in memory, calls `MAP.setHistory(session.points)` and `MAP.fitPoints`; no extra request per row |
| Text safety | rows are built with `createElement` + `textContent`; stored device data is never parsed as HTML |
| Kept contract | `#histPoints`, `#histDist`, `#histGap`, `#histWindow`, `#histStatus` still exist and `histStatus` still says `drawn as N line(s)`, so `dev/check-history.mjs` keeps working |
| Browser probe | `dev/check-timeline.mjs` (local static server + stubbed `/history`, three synthetic sessions): 3 rows, `3 sessions · 1.59 km · 3m 04s`, select → `session 2 of 3`, zoom 5 → 16.67, 3 → 1 drawn lines, deselect → 3 lines, 0 CSP/page errors |
| Screenshots | desktop 1280×900 and phone 390×844, both reviewed: rows readable in the sheet, no overlap with the telemetry cards |
| Unit tests | `test/sessions.test.js` 16: gap split at 121 vs 120 s, single point, junk rows, distance, max/avg speed, missing km/h, summary, duration and local clock/day formatting, page contract |
| Full suite | 80/80 |

Two defects the probe caught before the commit:

| Defect | Symptom | Fix |
|---|---|---|
| Cross-gap distance | window said **6.13 km** for **1.59 km** of driving, because it summed the straight line from the last fix of one stint to the first of the next | total is `SESSIONS.summarize(...).distKm`; the chord code was removed |
| UTC day headers | fixtures near midnight landed under the wrong day for a UTC+7 owner, while the rest of the page is local | `fmtClock`/`fmtDay`/`dayKey` use local time; the window line says `local` |


## Map camera: trackpad rotation and lock release (2026-11-12)

Two complaints, one cause each. A trackpad cannot rotate a MapLibre map: the
only desktop rotate gestures are ctrl+drag and a right-drag, and two-finger
scrolling was zoom only. And the camera lock was released by a pan or a wheel,
but not by a rotate, a pitch or a plain click, so the next fix pulled the view
back.

| Check | Result |
|---|---|
| Handlers enabled before the change | `dragPan`, `dragRotate`, `scrollZoom`, `touchZoomRotate`, `keyboard`, `doubleClickZoom` all true - the camera was never broken |
| Root cause, rotation | MapLibre has no trackpad rotate gesture; the horizontal part of a wheel event was unused |
| Fix | `enableTrackpadRotate()` in `web/ui/map.js`: a horizontal two-finger swipe (or Shift+scroll) turns the map; pinch (`ctrlKey`) is left to MapLibre, vertical scrolling still zooms |
| Root cause, lock | `dragstart` and `zoomstart` called `releaseFollow()`, but `rotatestart`/`pitchstart` and a click did not |
| Fix | `userCameraMove()` runs on `dragstart`, `rotatestart`, `pitchstart`, an event-bearing `zoomstart` and `pointerdown` on the map - any press takes the camera |
| No new buttons | an explicit rotate/tilt icon row was built and rejected by the owner as clutter; the gesture replaces it |
| Probe | `dev/check-camera.mjs`, real Chromium: swipe bearing 96 -> 168 deg with zoom unchanged at 12; wheel 12 -> 12.334; pinch 12.334 -> 12.668 with bearing unchanged; compass drag rotates; lock true -> false for drag, click, swipe and ctrl+drag |
| Unit tests | `test/ui.test.js` 10 checks, including the gesture handler and every release path |

## MPU tab: 3D attitude view (2026-11-12)

The MPU tab had a number grid and a tilt-history chart. It now opens with a 3D
view of the sensor board, tilted by the same roll/pitch/yaw the firmware
publishes.

| Check | Result |
|---|---|
| Renderer | `web/ui/mpu3d.js`, software projection on a 2D canvas. No WebGL, no three.js, no new vendor file; works with the existing CSP |
| Model | blue board + yellow MPU6050 chip, a fixed ground grid and world x/y/z axes; the body rotates, the grid does not, so tilt is readable |
| Placement | top of `#tab-mpu`, above the numbers and the chart |
| Cost | 100 ms repaint throttle for 1 Hz telemetry, `min(devicePixelRatio, 2)`, 170 px tall |
| Hidden tab | `draw()` returns when the panel has no width; opening the tab paints the last frame (`showTab('mpu')`), and a window resize repaints |
| Offline | a flat grey board plus `NO MPU DATA` until the first valid frame |
| Math tests | `test/mpu3d.test.js` 13: identity, yaw/roll/pitch basis, 360 deg wrap, junk angles, origin, screen-up, perspective, scale, unit() |
| Browser probe | `dev/check-mpu3d.mjs`: 282x170 canvas, 8,854 inked pixels level, 7,531 tilted, 8,678 offline; level and tilted checksums differ; 0 page/CSP errors |
| Live wiring | repo simulator (`dev/server.js`, topic `dev-test-1234`): roll -4.7 -> -4.8, pitch -1.0 -> 0.8, yaw 251.2 -> 285.5, canvas checksum changed between samples |
| Full suite | 94/94 |

## GPS: GPIO 33 wired, module at 5 Hz (2026-11-12)

The second UART wire (ESP32 GPIO 33 -> module RX) was missing, so the UBX
configuration was written into an unconnected pin. It is now wired and the
module accepted the whole sequence.

| Check | Result |
|---|---|
| Boot banner | `gps uart2 RX=25 TX=33 9600/38400/115200 8N1` |
| Module answered | `info GPS module already at 38400 baud` - it had a saved rate from an earlier boot, so CFG-PRT was skipped |
| Configuration | `OK GPS UBX: 5 Hz, 38400 baud, automotive, static hold 1.8 km/h, SBAS on (saved)` |
| Rate proof, sentences | 34 s console capture: GGA 125, RMC 123, GSA 123, **GSV 24**. GSV is configured to 1 Hz while the rest run at nav rate, so 125/24 = 5.2 Hz |
| Rate proof, bytes | MQTT `gps.chars` 132,706 -> 133,613 in 1.0 s = **907 B/s**; a 1 Hz stream of the same no-fix sentences is about 200 B/s |
| Publish path | `LINK wifi OK mqtt OK tx 9 ok 9 fail 0 drop 0 q 0` |
| Still no fix | `sats 0 view 0 hdop 25.50 mode 1` - antenna has no sky view indoors; the firmware says so itself rather than blaming the wire |
| Build / flash | `esp32-mqtt-simple` SUCCESS, RAM 16.3%, Flash 40.9%, 794,072 bytes written, hash verified |

### Odometer retuned for 5 Hz

Two constants were 1 Hz assumptions and would have gone quiet or loose at the
new rate. Both are in `mqtt_simple.cpp` and changed in the same commit as the
wire.

| Old | What it did at 5 Hz | Now |
|---|---|---|
| `d > 2.0f` per fix | a 10 km/h car moves 0.55 m per fix, so every step failed the floor: **no distance at all below ~36 km/h** | distance is measured from an anchor fix and the anchor advances once 2 m of real travel is confirmed, at any fix rate |
| `GPS_ODO_MAX_STEP_M 60` fixed | 60 m was 216 km/h at 1 Hz but 1080 km/h at 5 Hz - no gate | allowed = `1.5 * v * dt + 10 m`, clamped to 60 m, with `dt` the real spacing between counted fixes |

## Session log, laps, lean and export (2026-11-12)

Six things that were discussed were built together because they share one data
path: the stored frame.

| Feature | Where it lives | Contract |
|---|---|---|
| Lap log | worker + HIST tab | device sends `lap_n`, `lap_last_ms`, `lap_best_ms`; ingest writes one `laps` row when the counter changes; `/history` returns `laps: [[ts, n, dur_ms, best_ms], ...]` |
| GPX / CSV export | browser only | built from the points already in memory, no backend and no new host |
| Lean in history | firmware + worker + tab | `roll`, `pitch` added to `fixes`; `/history` points are now `[ts, lat, lon, kmh, cog, hdop, roll, pitch, boot]` |
| Quality overlay | map + HIST | points with `hdop > 3` are drawn red on top of the grey history line; the panel shows average HDOP and `% poor` |
| Lifetime odometer | firmware NVS | namespace `odo`, key `m`, written every 500 m (`ODO_SAVE_STEP_M`), restored at boot |
| Event log | HIST tab, derived from stored fixes | chronological reboots, data gaps, HDOP transitions and laps, merged by time; no extra board path, table or upload |

The `/history` point list grew from 6 to 9 elements. This is additive on
purpose: every existing consumer indexes 0-5 and keeps working if the worker and
the page are deployed out of step.

### Migration order matters

`worker/migrations/2026-11-laps-lean.sql` uses `ALTER TABLE ... ADD COLUMN`,
which is not idempotent. Apply it **before** deploying the new worker:

```
npx wrangler@latest d1 execute race-tracker --remote \
  --file=migrations/2026-11-laps-lean.sql
```

The worker is defensive anyway: the lap insert is wrapped in try/catch and the
`/history` lap query too, so a database without the table still stores and
serves positions. Losing the lap log is better than losing fixes, and a 503 on
every ingest would make the board retry the same batch forever.

### Evidence

| Check | Result |
|---|---|
| Firmware build | `esp32-mqtt-simple` SUCCESS, RAM 16.3%, Flash 40.9% |
| JS suite | 105/105 pass, including lap summary, quality, lean, events, GPX and CSV |
| Worker suite | 17/17 pass against the in-memory D1, including lap de-duplication and 9-column history |
| Browser probe | `dev/check-laps-export.mjs` PASS: 2 chips, `hdop 1.47 · 17% poor`, max lean 14.4, 1 red overlay line, 5 derived events (lap, gap, poor, recovery), GPX 24 points / 2370 B, CSV 24 rows / 1831 B, session selection narrows to 1 lap and 1 event |

## W10 — Session replay and chart (2026-11-12)

The stored points already carry speed, course, HDOP and lean, so replay is a
drawing problem, not a data one. It uses the same `/history` response as the
timeline: no new endpoint, table or board change.

| Piece | Decision |
|---|---|
| Transport | Play / Pause / Reset plus a scrubber and 1x–30x speed, enabled only for a selected session (near 1:1 points) |
| Time model | playback advances by wall-clock × speed and looks the position up with `SESSIONS.indexAt`, so a real gap in the data is a pause, not a teleport |
| Map overlay | two separate sources (`playbackLine`, `playbackDot`) so replay never mutates the session line it is replaying |
| Chart | speed (black) and lean (red) share one canvas with independent scales; HDOP > 3 bands are shaded behind both |
| Lifetime | leaving HIST or hiding the tab stops the timer; pressing Play at the end restarts from the first point |
| Load safety | a request token (`histRequest`) lets only the newest `/history` answer touch the panel, so a slow older window cannot clear a fresh selection |

One bug fell out of the probe: the range buttons, Export and Play all share
`.hist-btn`, and every one of them was wired to `loadHistory`. Pressing Export or
Play therefore reloaded history and disabled the transport. The handler is now
scoped to `.hist-btn[data-min]`, and a unit test pins that selector.

### Evidence

| Check | Result |
|---|---|
| JS suite | 107/107 pass, including `indexAt` boundaries and the playback controls/hooks |
| Worker suite | 17/17 pass (unchanged path) |
| Playback probe | `dev/check-playback.mjs` PASS: transport enabled, chart 9112 painted pixels, Play advanced into the session with a travelled line matching the marker, Pause held position, scrub to end landed on the last point, Reset returned to the first, auto-stop at the end returned the button to Play |
| Regression probes | `dev/check-laps-export.mjs` PASS, `dev/check-timeline.mjs` PASS |

## Still needs the board

1. ~~Flash `0dd61cd` + watchdog commit; confirm the two `task_wdt` error lines
   are gone.~~ Done 2026-11-11: no `task_wdt` lines, watchdog armed.
2. The 60-minute soak, on that binary. Running; the table above is updated when
   it finishes.
3. Real parked wander radius (lat/lon spread over 10 minutes). The module is
   now wired on both UART2 pins and running 5 Hz; it still needs an open-sky
   position (`sats` is 0 indoors), then 10 minutes parked with `dist_m`
   watched for creep.
4. One drive capture (route, speed, odometer). Same blocker as (3): sky, not
   wiring. This is also the first real test of the 5 Hz lap interpolation and
   of the retuned odometer gates.

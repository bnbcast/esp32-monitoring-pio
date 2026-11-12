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
| Tests | 47 unit tests (`guard` 14, `info` 5, `lap` 15, `gps` 4, `ui` 9) plus browser probes in `dev/` |

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
dev simulator; the board itself has not been re-flashed because COM4 is absent.

| Check | Result |
|---|---|
| Build | `SUCCESS`, RAM 16.3% (53,288 B), flash 40.7% (1,281,496 B), no format warnings |
| ACS removal | grep over `src/`, `web/`, `test/`, `dev/` and the docs: no driver, pin, payload key, tab, pill or glossary entry left |
| Publish gate | sats ≥ 5, HDOP ≤ 4, GSA mode 3 (2D rejected), over-200 km/h jump rejected |
| Shadow gate | `GPS_STRICT_SATS 6` / `GPS_STRICT_HDOP 2.0` are counted per boot, never enforced: the POS line prints `tight n/N (%)`, the share of accepted fixes a stricter gate would have dropped. `test/gps.test.js` proves the strict values cannot reach `gpsFixUsable()` |
| Fix reference | only an accepted fix advances `fixPrev*`; a fix that failed the gate can be 20 m out and must not become a chord endpoint for the finish line |
| Parked hold | speed < 1 km/h freezes the published coordinate; 8 m of real movement releases it |
| Lap engine | forward segment crossing A→B, time interpolated between fixes, minimum 3 s and 5 km/h |
| Lap persistence | `lap/n`, `lap/last`, `lap/best` written once per completed lap and restored by `gpsLoadGates()`; arming a new gate persists the zeroed counters; `l` clears the namespace. `lapCrossMs` is not restored (millis() restarts), so the line re-arms after a reboot |
| UBX | probe at 9600/38400/115200 on GPIO 33; when a module answers: 38400, 5 Hz, automotive, static hold 0.5 m/s (mask 0x0105), SBAS, config saved in the module; with the pin unwired the link stays 9600 8N1 |
| UBX masks | `CFG-NAV5` applies field by field: dynModel bit 0, fixMode bit 2, static-hold threshold bit 8. The previous 0x0041 mask left static hold off while the log claimed it was on |
| Wi-Fi latency | `WiFi.setSleep(false)`; the scan matcher now builds one `String` per visible AP instead of one per (AP, candidate) pair, which removes N×M heap churn on every rescan |
| Unit tests | 47/47 (`node --test test/gps.test.js test/guard.test.js test/info.test.js test/lap.test.js test/ui.test.js`) |
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

## Still needs the board

1. ~~Flash `0dd61cd` + watchdog commit; confirm the two `task_wdt` error lines
   are gone.~~ Done 2026-11-11: no `task_wdt` lines, watchdog armed.
2. The 60-minute soak, on that binary. Running; the table above is updated when
   it finishes.
3. Real parked wander radius (lat/lon spread over 10 minutes). Needs the GPS
   module on UART2 RX=25; it is not attached yet (`gps.chars` stays 0).
4. One drive capture (route, speed, odometer). Same blocker as (3).

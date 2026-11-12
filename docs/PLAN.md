# Plan — simplified

The earlier eight-phase draft assumed subsystems this repo does not have. This
version keeps four workstreams, each one shippable and testable on its own.

## Principles

1. **One bug, one diff.** No refactor rides along with a fix.
2. **No new moving part unless a measurement demands it.** TLS, crypto and a
   filesystem only appear when the board proves it has room.
3. **Live path stays dumb.** Publish at 1 Hz, QoS 0, retained. Durability is a
   separate path if it ever exists.
4. **Every claim has evidence**: a test result, a build log or a recorded
   capture.

## Workstreams

| # | Workstream | Status | Evidence |
|---|---|---|---|
| W1 | **Stabilize** — parked drift, odometer creep, heading decay, 1 Hz, HDOP gate | **done on this branch** | `npm test`, `pio run`, diff below |
| W2 | **Protect** — plausibility gate on every live frame | **done on this branch** | `test/guard.test.js` 14/14 |
| W3 | **History** — Pages Function + D1 + device buffer | **done, needs soak + capture** | `worker/` 15/15, `POST /ingest -> 200`, 3 acks on the board |
| W4 | **Mobile + lock mode** — one DOM, spectator default | **done on this branch** | single panel, 5 viewports, lock probe |
| W5 | **GPS conditioning, 5 Hz, lap timing** | done, hardware verification pending | `test/gps.test.js`, `test/lap.test.js`, flash logs |
| W6 | **HIST tab as a timeline** - sessions grouped from stored fixes, tap to draw and frame one stint | **done 2026-11-12** | `test/sessions.test.js` 16/16, `dev/check-timeline.mjs` PASS |
| W7 | **Trackpad camera** - horizontal two-finger swipe rotates, every press releases the camera lock | **done 2026-11-12** | `dev/check-camera.mjs` PASS |
| W8 | **MPU 3D attitude** - software-projected board on the MPU tab | **done 2026-11-12** | `test/mpu3d.test.js` 13/13, `dev/check-mpu3d.mjs` PASS |
| W9 | **Session log** - lap rows, GPX/CSV export, lean trace, HDOP overlay, lifetime odometer | **done 2026-11-12**, migration before deploy | `npm test` 103/103, `worker/test` 17/17, `dev/check-laps-export.mjs` PASS, `pio run` SUCCESS |

## W1 — Stabilize (this branch)

| Fix | File | Why |
|---|---|---|
| Odometer only counts while the module reports ≥ 3 km/h, max 60 m per fix | `mqtt_simple.cpp` | a parked receiver added 2–10 m per fix forever |
| HDOP gate 20 → 8 | `mqtt_simple.cpp` | HDOP 20 is a ~100 m error circle |
| Publish 500 ms → 1000 ms | `mqtt_simple.cpp` | half the traffic, half the log, same usefulness |
| Exact GPS date → epoch | `mqtt_simple.cpp` | the old formula drifted ~30 min |
| chars/s computed before the no-fix return | `app.js` | health panel was dead exactly when it mattered |
| Stale fix no longer feeds heading 0 | `app.js` | the compass decayed to north while parked |
| Parked state needs 2 consecutive samples | `map.js` | single noisy sample flipped parked/moving |
| English strings, detailed address line | `app.js`, `index.html` | owner-facing |
| IMU probe retries 5 s, then boots without tilt/yaw | `mqtt_simple.cpp` | a missing MPU6050 used to block setup forever: no watchdog, no `ready`, no publishing |

## W2 — Protect (this branch)

`web/ui/guard.js` is now the only path from broker to map. It rejects, in order:
shape, flood (> 20/s), duplicate/regressed `seq` within a boot, coordinate
range, optional venue bbox, speed > 150 km/h, teleports the clock cannot
explain, and absurd timestamps.

Reboots are detected by `up` going backwards, so rejecting a seq restart is
safe.

**Not done:** ECDSA signing. Measured: 174 ms per P-256 signature, so signing
every frame is not viable; one signature per 30 s batch is. Until that exists
the gate is plausibility only, and a determined attacker who knows the topic
can still publish a plausible-looking fake. Known, documented limitation.

## W3 — History (device path done)

The free Pages Function, D1 schema and device buffer are all in the repo; the
owner walkthrough is `docs/CLOUDFLARE.md`. The API does verification, idempotent
inserts, parked downsampling, `/history`, and 365-day retention.

Gates:

1. Host reachable from the venue-class ISP — **done**. `workers.dev` is
   DNS-hijacked on XL Axiata, so the same handler runs as a Pages Function at
   `https://race-tracker-history.pages.dev` (`pages.dev` resolves normally).
2. `huge_app.csv` is flashed — **done**, app slot 3 MiB; the full build is now
   40.6% of it.
3. TLS handshake heap and ECDSA timing — **done** (see `BASELINE.md`):
   verified handshake 1.7–2.0 s / 42.6 KB, low-water 132 KB;
   ECDSA P-256 sign 174 ms, so **no per-frame signing**.

Device path (`src/mqtt_simple/history.cpp`):

- The main loop only pushes a 40-byte `HistoryFix` into a 64-slot FreeRTOS
  queue. One task on core 0 owns LittleFS and the TLS client, so there is no
  file locking and no second writer.
- Frames are appended as compact NDJSON (~160 B) to `/hist.ndjson`, flushed to
  flash at most every 10 s. The ring is capped at 512 KB and drops the oldest
  half, never the newest.
- Every 30 s the task posts up to 40 frames / 8 KB to `/ingest` with the key,
  using a verified TLS connection (CA bundle, not `setInsecure`).
- A 2xx advances a byte offset persisted in `/hist.off`; the batch is thus
  deleted exactly once. A crash before the offset write re-sends one batch,
  which the server's `INSERT OR IGNORE` plus `(boot, seq)` duplicate check make
  harmless.
- A corrupt tail (only possible after a power cut mid-write) is dropped rather
  than retried forever, so the queue cannot jam.
- Uploads are skipped below 90 KB free heap, so TLS can never starve MQTT.
- Configuration is one gitignored header, `src/history_secret.h`, generated by
  `dev/gen-history-secret.mjs`; without it the module compiles to a no-op and a
  fresh clone still builds.

Proven on the board (2026-11-09, self-test build):

```
HIST history ready: race-tracker-history.pages.dev/ingest, 0 B buffered, offset 0
HIST self-test: 3 synthetic frames queued
HIST POST /ingest -> 200 in 3711ms
HIST 3 frames acked, queue 0 B
```

and `/history` then returned all three points. Test rows were deleted
afterwards. Still missing: a real drive (the buffer is only exercised by
synthetic frames until the vehicle is outdoors) and a multi-hour soak.

Decision recorded: the topic is now the fixed slug `race-tracker` (firmware and
dashboard), removing the burned random key. A second tracker uses `#t=<slug>`.

## W4 — Mobile + lock mode

Lock mode is done: `body.locked` is the default, reset/measure controls carry
`operator-only` and are removed from the layout, a 1.2 s hold on the LOCK button
reveals them, a single click hides them again, and two idle minutes relock.
Verified in Chromium: hidden on load, visible after a real 1.4 s hold, hidden
after one click, and a short tap does not unlock.

The DOM is consolidated: there is exactly one `.side-panel`, one row of tabs and
one copy of every HUD field. On a phone that same element becomes the bottom
sheet, so a value is rendered once instead of twice and cannot drift.
`index.html` now has 84 ids and zero duplicates. Measured at 1440×900, 360×800,
390×844, 430×932 and 844×390: no horizontal scroll, one panel, map and sheet
both visible, tab switching works, zero page errors. Short landscape gets a
one-row HUD so it cannot spill over the sheet.

## Long-uptime measures

Already present: Wi-Fi reconnect with backoff and network scan, publish queue,
retained status with last-will, free heap and RSSI in every payload.

Added here:

1. **Task watchdog** — `esp_task_wdt` armed with a 30 s timeout at the end of
   `mqtt_simple_setup()`. A deadlock reboots the chip instead of freezing it.
   Armed *after* hardware probing so a missing MPU6050 cannot become a boot
   loop. Compiles on IDF 5 (config struct) and IDF 4 (two-arg init).
2. **Heap low-water counter** — `minFreeHeap` is sampled every loop and
   published as `sys.heap_min`; a single warning is logged per boot below
   40,000 bytes.
3. **Boot counter** — published as `sys.boot`, so a reboot loop is visible from
   the dashboard without any external storage. It first lived in
   `RTC_DATA_ATTR`, which turned out not to survive a normal reset on this
   board: every boot reported `1`, so the diagnostic could never fire. It now
   lives in NVS (`sys/boot`), one write per boot.

`sys.heap_min` and `sys.boot` are bound to rows in the WIFI tab
(`wifiHeapMin`, `wifiBoot`), next to the live heap and uptime.

**Verified on the board.** Watchdog armed, IMU-less boot, `boot=1` across
minutes, `heap_min` present in every frame, and the history task running
alongside MQTT without a reboot. The soak is restarted after each firmware
change so the measured window always describes the final binary; see
`BASELINE.md`.

A fourth measure came out of W3: the history task skips uploads below 90 KB
free heap. A TLS handshake costs ~43 KB, so this keeps a transient spike from
starving the Wi-Fi/MQTT stack — the failure mode that would otherwise show up
as random disconnects under load.

## W5 — GPS conditioning, 5 Hz and lap timing

The tracker now treats the receiver as a racing sensor rather than a map toy.

1. **Fix gate:** 5 satellites, HDOP ≤ 4 and a 3D fix. A 2D fix is not published:
   without an altitude constraint the horizontal error is far worse than HDOP
   suggests.
2. **Parked hold:** below 1 km/h the published coordinate is frozen, and only a
   real 8 m displacement moves it. Multipath wander therefore never reaches the
   map, the trail or D1.
3. **Jump gate:** a fix implying over 200 km/h is rejected and counted, so one
   wild solution cannot teleport the marker or add fake distance.
4. **UBX at boot:** the firmware probes 9600/38400/115200, then sets 38400 baud,
   5 Hz navigation, automotive model, static hold 0.5 m/s, SBAS on, GGA/GSA/RMC
   every fix, GSV at 1 Hz and VTG/GLL/ZDA off. The configuration is saved in the
   module (BBR + flash), so the next power-up starts already at 5 Hz and the probe
   keeps a saved rate from locking the tracker out. It runs only when the module
   answers on GPIO 33; otherwise the link stays at 9600 and nothing else changes.
   GSA is kept because it is the only 2D/3D flag available, and GSV at 1 Hz
   because the dashboard reports satellites in view.
5. **Finish line:** two points captured from the console (`a`, `b`; `l` clears,
   `k` shows) are stored in NVS. A lap is a forward crossing of A→B, with the
   time interpolated between the two fixes, so a 5 Hz stream is not rounded to
   200 ms. Crossings under 3 s or 5 km/h are ignored. `test/lap.test.js` mirrors
   the geometry and checks it against the firmware source: a 144 km/h crossing
   37 ms after a fix is reported as 37 ms. The count, last and best are written
   to NVS (`lap/n`, `last`, `best`) on every completed lap and restored at boot,
   so a brownout or a reset on the grid does not erase the session; the crossing
   timestamp is deliberately not restored, because `millis()` starts at 0 again
   and the line simply re-arms on the next forward crossing.
6. **Payload/UI:** `gps` gains `ttff_s`, `rej`, `still` and `mode`; `lap` carries
   the count, last/best and the gate. The LIVE tab shows laps, last, best and
   gate state; the map draws the gate as a red dashed line. The emoji marker was
   replaced by an inline SVG arrow.

**HDOP 2.0 or 4.0?** An HDOP gate is a geometry filter, not an accuracy promise:
position error ≈ UERE × HDOP, and multipath under a gantry or tree biases the
solution *without* moving HDOP. Tightening to 2.0/6 therefore buys a modest
per-fix improvement and costs dropped fixes exactly where the track is worst,
which lengthens the chord the lap interpolator has to draw and can skip a
crossing altogether. Rather than guess, the firmware counts what a 6/2.0 gate
*would* reject (`GPS_STRICT_SATS`, `GPS_STRICT_HDOP`) and prints it in the POS
line as `tight n/N (%)`; the strict values are never applied to publishing
(`test/gps.test.js` enforces that). Decision rule: if `tight` stays in the low
single digits on a real session, switch the live gate to 6/2.0; if it is double
digits, the current 5/4.0 is the faster and more continuous choice.

Every ACS712 reference is gone: ADC pin, calibration, `amps`/`peakA`, the payload
block, the console line, the `z` key, the tab, the pill, the graph, the glossary
and the tests.

## W9 — Session log, laps, lean, export (2026-11-12)

One frame already travels from the board to D1, so all six requested items ride
on it instead of adding a second stream.

| Item | Decision |
|---|---|
| Lap log | the frame carries `lap_n` / `lap_last_ms` / `lap_best_ms`; ingest writes one `laps` row per counter change, keyed `(device, boot, n)` so a retry is free |
| GPX / CSV | built in the browser from the points already fetched; no endpoint, no host, works offline once the panel is loaded |
| Lean in history | `roll` and `pitch` are columns on `fixes`; `/history` points grow to `[ts, lat, lon, kmh, cog, hdop, roll, pitch, boot]` |
| Quality overlay | `hdop > 3` pairs are a red line over the grey trail, and the panel reports average HDOP plus `% poor` |
| Lifetime odometer | NVS `odo/m`, restored at boot, written every 500 m; a reboot loses at most half a kilometre |
| Event log | no duplicate stream: laps are the events, derived from stored frames |

Order of release: apply `worker/migrations/2026-11-laps-lean.sql` **first**,
then deploy the worker, then publish the page. The worker tolerates a database
without the lap table (positions still store, `/history` still answers), but the
migration itself is not idempotent and must not be re-run.

## Still open

| Item | Why it is open |
|---|---|
| LED wiring | firmware now handles both polarities (`y`, saved) and `d` names each LED, but nobody has watched `only BLUE` yet; the answer picks rewire vs `y`: blue only = correct, white+red = inverted, all three = shorted signal legs |
| Flash + outdoor check | firmware compiled but the board is not on USB; needs `boot #n` increment, a 3D fix, TTFF and hold verification |
| HDOP 2.0 vs 4.0 | the live gate stays 5/4.0 until one track session reports `tight n/N (%)`; near 0 on a clean track means the strict gate is free, double digits means it costs segments |
| 60-minute soak | restarted after the GPS/lap change so the window describes the final binary; needs the board idle on USB |
| Parked + drive captures | needs the vehicle outdoors; the Worker rules are covered by 15 tests, but real wander radius is unmeasured |
| Power path (MT3608 + pack) | owner is still describing the pack and the USB board; not started on purpose |
| ECDSA batch signing | measured as viable (174 ms per batch) but not implemented; the gate is plausibility only |
| Custom domain | optional; `pages.dev` already works on the venue-class ISP |

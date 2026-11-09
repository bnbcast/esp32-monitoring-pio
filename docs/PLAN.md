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
| W3 | **History** — Worker + D1 + device buffer | **Worker ready, device path next** | `worker/`, `docs/CLOUDFLARE.md`, TLS/ECDSA measured |
| W4 | **Mobile + lock mode** — one DOM, spectator default | **done on this branch** | single panel, 5 viewports, lock probe |

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

## W3 — History (Worker ready, account pending)

The free Worker and D1 schema are in `worker/`; the owner walkthrough is
`docs/CLOUDFLARE.md`. The Worker does verification, idempotent inserts,
parked downsampling, `/history`, and 365-day retention.

Gates:

1. Cloudflare account exists and the Worker is deployed (owner) — **pending**.
2. `huge_app.csv` is flashed — **done**, app slot 3 MiB, 33.3% used.
3. TLS handshake heap and ECDSA timing — **done** (see `BASELINE.md`):
   verified handshake 1.7–2.0 s / 42.6 KB, low-water 132 KB;
   ECDSA P-256 sign 174 ms, so **no per-frame signing**.

Design, unchanged: LittleFS ring buffer, 30 s HTTPS batch, Worker verifies and
inserts into D1, ack deletes the batch, weekly GitHub export.

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
3. **Boot counter** — `RTC_DATA_ATTR bootCount`, published as `sys.boot`, so a
   reboot loop is visible from the dashboard without any storage.

The dashboard shows `sys.heap`; binding `heap_min` and `boot` to visible rows is
the next diagnostic step, but the data is already on the wire.

**Not yet proven on hardware.** The watchdog and the heap warning compile but
have not run on the board (it still has the old build). That is called out
rather than claimed.

## Blocked on the owner

| Item | Why it blocks |
|---|---|
| Flash `huge_app.csv` + the bench sketch | needs the board on COM4 |
| 10 min parked capture + one drive capture | needs the vehicle outdoors |
| Cloudflare account | W3 only |
| Rotate `TOPIC_KEY` | changes the public topic; firmware + dashboard must ship together |

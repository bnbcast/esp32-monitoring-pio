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
| W3 | **History** — Worker + D1 + device buffer | **blocked** | needs Cloudflare account, board measurement, partition decision |
| W4 | **Mobile + lock mode** — one DOM, spectator default | **lock mode done; DOM consolidation pending** | browser probe below |

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

## W2 — Protect (this branch)

`web/ui/guard.js` is now the only path from broker to map. It rejects, in order:
shape, flood (> 20/s), duplicate/regressed `seq` within a boot, coordinate
range, optional venue bbox, speed > 150 km/h, teleports the clock cannot
explain, and absurd timestamps.

Reboots are detected by `up` going backwards, so rejecting a seq restart is
safe.

**Not done:** ECDSA signing. It cannot be designed until the board reports sign
time and heap. Until then the gate is plausibility only, and a determined
attacker who knows the topic can still publish a plausible-looking fake. That
is a known, documented limitation.

## W3 — History (blocked)

Do not start until all three are true:

1. Cloudflare account exists (owner).
2. `huge_app.csv` is flashed (frees 3 MB of app space — see `BASELINE.md`).
3. Board reports TLS handshake heap and ECDSA timing.

Design, unchanged: LittleFS ring buffer, 30 s HTTPS batch, Worker verifies and
inserts into D1, ack deletes the batch, weekly GitHub export.

## W4 — Mobile + lock mode

Lock mode is done: `body.locked` is the default, reset/measure controls carry
`operator-only` and are removed from the layout, a 1.2 s hold on the LOCK button
reveals them, a single click hides them again, and two idle minutes relock.
Verified in Chromium: hidden on load, visible after a real 1.4 s hold, hidden
after one click, and a short tap does not unlock.

Still to do: consolidate the duplicated desktop/mobile DOM
(`index.html:97-170` vs `:197-300+`, four `@media (max-width: 900px)` blocks in
`layout.css`). Measured today at 360×800, 390×844, 430×932 and 844×390: no
horizontal scroll and both the map and the sheet are visible, so the duplicate
DOM is debt rather than an active breakage.

## Long-uptime measures

Already present: Wi-Fi reconnect with backoff and network scan, publish queue,
retained status with last-will, free heap and RSSI in every payload.

Added here: 1 Hz cadence, tighter fix gate, flood cap.

Still to add, in order of value:

1. **Heap low-water counter** in `sys` so a slow leak is visible before it bites.
2. **Task watchdog** on the main loop, so a hang reboots instead of freezing.
3. **Boot counter** in RTC memory, so reboot loops are detectable from the
   dashboard without new storage.

## Blocked on the owner

| Item | Why it blocks |
|---|---|
| Flash `huge_app.csv` + the bench sketch | needs the board on COM4 |
| 10 min parked capture + one drive capture | needs the vehicle outdoors |
| Cloudflare account | W3 only |
| Rotate `TOPIC_KEY` | changes the public topic; firmware + dashboard must ship together |

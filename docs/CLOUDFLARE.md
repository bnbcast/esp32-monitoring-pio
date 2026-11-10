# Cloudflare history API (W3) — deployed setup

The live path is unchanged: the ESP32 publishes to HiveMQ at 1 Hz over MQTT.
History is a **separate** HTTPS batch path, so a history outage can never stop
the live map:

```
ESP32 ── LittleFS ring buffer ──30 s batch──▶ Pages Function ──▶ D1
   └─ MQTT 1 Hz ──────────────────────────────────────────────▶ HiveMQ
```

Hosted as a **Pages Function**, not a Worker, because `*.workers.dev` is
DNS-hijacked by some venue-class ISPs while `*.pages.dev` resolves normally.
Both run the identical handler in `worker/src/index.js`.

| Item | Value |
|---|---|
| API base | `https://race-tracker-history.pages.dev` |
| Endpoints | `GET /health`, `GET /history`, `POST /ingest` |
| D1 database | `race-tracker`, `916e0115-1d0e-482b-8e08-14b75b56ecec` (APAC) |
| Account | `1eb96d94afa9eeab9fd7920b2ed4b251` |
| Retention | ingest-driven, once per day, 365-day delete (Pages has no cron triggers) |
| Secret | `INGEST_KEY` on the Pages project |
| Local key copy | `%USERPROFILE%\.esp32-race-tracker\ingest.key` |

---

## Redeploy after a code change

```powershell
cd C:\Users\User\Documents\PlatformIO\Projects\esp32\worker\pages
npx wrangler@4 pages deploy
```

`worker/pages/functions/[[path]].js` imports `../../src/index.js`, so the Pages
Function and the Worker can never drift apart. The static output
(`worker/pages/public/`) is only a landing page.

The first deploy of a project needs the project to exist:

```powershell
npx wrangler@4 pages project create race-tracker-history --production-branch=main
```

## Retention (why there is no cron here)

Pages Functions do not support cron triggers, so the `scheduled()` handler in
`worker/src/index.js` only applies to the Worker variant. Production runs the
purge from `/ingest`: the first successful batch after 24 h deletes rows older
than 365 days and records the timestamp in the `meta` table (key `retention`).
That is two small statements plus one indexed `DELETE` per day, and a failed
purge resets the marker instead of failing the ingest.

Upgrading an existing database needs the new table once:

```powershell
cd worker
npx wrangler@4 d1 execute race-tracker --remote --file=schema.sql
```

Verified in production: seeded a 400-day-old row, posted one batch, got
`"retention":1`, the old row disappeared from `/history`, and the next batch
reported `"retention":"skipped"`.

## Rotate the ingest key

Generate once, store outside the repo, push to the host, then rebuild firmware:

```powershell
$dir = Join-Path $env:USERPROFILE ".esp32-race-tracker"
New-Item -ItemType Directory -Force $dir | Out-Null
node -e "require('fs').writeFileSync(process.argv[1], require('crypto').randomBytes(32).toString('hex'))" "$dir\ingest.key"

cd worker\pages
Copy-Item "$dir\ingest.key" ingest.key
cmd /c "npx.cmd wrangler@4 pages secret put INGEST_KEY --project-name race-tracker-history < ingest.key"
Remove-Item ingest.key

# the firmware compiles the same key from the safe copy
cd ..\..
node dev\gen-history-secret.mjs
pio run -e esp32-mqtt-simple -t upload
```

**Gotcha, verified the hard way:** a Pages secret only reaches deployments
created *after* it is set. After `secret put`, run `pages deploy` again or
`/ingest` answers `{"ok":false,"error":"ingest-key-not-set"}` (503) while
`/health` still works.

## Smoke test

```powershell
$key = (Get-Content "$env:USERPROFILE\.esp32-race-tracker\ingest.key" -Raw).Trim()
$h   = "race-tracker-history.pages.dev"
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

$body = @{ device = "esp32-01"; frames = @(
  @{ seq=1; ts=$now; up=10; boot=1; fix=$true; lat=-6.9; lng=107.6; kmh=12.5; hdop=0.9; sats=9; dist_m=0 },
  @{ seq=2; ts=$now; up=11; boot=1; fix=$true; lat=999;  lng=107.6 }
) } | ConvertTo-Json -Depth 5 -Compress

curl.exe -sS -H "X-Ingest-Key: $key" -H "Content-Type: application/json" `
  --data-binary $body "https://$h/ingest"
curl.exe -sS "https://$h/history?from=$($now-60)&to=$($now+60)"
```

Expected `{"ok":true,"received":2,"stored":1,"rejected":[{"seq":2,"reason":"range"}]}`
and one point from `/history`. Measured on 2026-11-09:

```
{"ok":true,"received":2,"stored":1,"duplicates":0,"rejected":[{"seq":2,"reason":"range"}]}
{"ok":true,"device":"esp32-01","count":1,"points":[[1794206089,-6.9123,107.6098,12.5,null,0.9]]}
```

## Test the rule set without the cloud

```powershell
node --test worker/test/ingest.test.mjs     # 17 tests, in-memory D1
```

Covers: key required, bad key 401, unset key 503, moving stored, parked
throttled to 10 s, no-fix skipped, duplicate vs stale seq, teleport and clock
rejection, hdop/speed gates, empty and oversized batches, window queries,
365-day retention, the once-a-day marker that stops ingest from purging on
every batch, and wide-window sampling.

`/history` returns `count`, `total`, `step` and `sampled`. When a window has
more rows than `limit`, the server returns every `step`-th real fix (oldest
kept) so a 24 h request covers 24 h instead of the first ~83 minutes.

## Prove the device path (no GPS needed)

```powershell
node dev\gen-history-secret.mjs          # bakes a fresh epoch
pio run -e esp32-history-test -t upload  # adds -DHISTORY_SELFTEST
```

Open the serial monitor; after ~15 s the board queues 3 synthetic frames, at
~45 s it posts them. Console key `t` repeats it. Expected:

```
HIST history ready: race-tracker-history.pages.dev/ingest, 0 B buffered, offset 0
HIST self-test: 3 synthetic frames queued
HIST POST /ingest -> 200 in 3711ms
HIST 3 frames acked, queue 0 B
```

Then flash `esp32-mqtt-simple` again to remove the test key.

## Known network issue: `workers.dev` is filtered

Verified on 2026-11-09 on an XL Axiata hotspot:

- `race-tracker-history.<subdomain>.workers.dev` resolves to
  `blockpage.xlaxiata.id`, not Cloudflare.
- Forcing 1.1.1.1 or 8.8.8.8 returns the same block page, so the interception
  is transparent and changing DNS on the ESP32 cannot help.
- The Worker itself is healthy: connecting to Cloudflare's real IP with
  `--resolve ...:443:172.67.187.103` returns `{"ok":true,...}`.
- `pages.dev` resolves normally on the same network — hence the Pages Function.

The Worker deployment at
`https://race-tracker-history.zakyazhari393.workers.dev` still exists and works
where that hostname resolves. A custom domain would also fix it, but needs a
domain the owner controls.

## Free-plan budget

| Limit | Free plan | This project |
|---|---|---|
| Requests | 100,000/day | ~2,900/day at one batch per 30 s |
| D1 rows written | 100,000/day | ≤ 86,400 (only while moving) |
| D1 rows read | 5,000,000/day | ~3,000 |
| D1 storage | 5 GB | ~1–2 GB for 365 days |
| Cron triggers | not usable on Pages | not needed: ingest runs retention once a day |

Storage policy is in `worker/src/index.js`: every frame while moving, one frame
every 10 s while parked, no GPS fix = not stored. That keeps a full year well
inside 5 GB.

## What is public

- The `pages.dev` URL and `/history` are public, like the map. A precise public
  track is a frozen product decision.
- `/ingest` requires the key. Without it, writes are refused.
- No accounts, no cookies, no PII stored.

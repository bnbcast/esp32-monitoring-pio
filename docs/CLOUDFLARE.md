# Cloudflare Worker + D1 setup (W3 history)

One free Worker and one free D1 database. Nothing here touches the live path:
the ESP32 keeps publishing to HiveMQ at 1 Hz over MQTT, and history arrives
later as HTTPS batches. If the Worker is down, the live map is unaffected.

The code is already in `worker/`. Your part is the account, the database, and
one secret.

Time: about 10 minutes. Cost: 0. No card required for the free plan.

---

## 1. Create the account

1. Open <https://dash.cloudflare.com/sign-up>.
2. Use the owner's email, confirm the verification mail.
3. Skip any domain/paid prompt. The free `workers.dev` subdomain is enough.

## 2. Log the CLI in

From the repo:

```powershell
cd C:\Users\User\Documents\PlatformIO\Projects\esp32
npx wrangler@4 login
```

`npx` asks to install the package the first time; answer yes. A browser window
opens; click **Allow**. The CLI prints `Successfully logged in`.

## 3. Create the database

```powershell
npx wrangler@4 d1 create race-tracker
```

Copy the printed `database_id` (a UUID). Open `worker/wrangler.toml` and replace

```toml
database_id = "PASTE_DATABASE_ID_HERE"
```

with that UUID. This file is safe to commit; the ID is not a secret.

## 4. Create the tables

```powershell
npx wrangler@4 d1 execute race-tracker --remote --file=worker/schema.sql
```

Expect `Executed 2 queries`. The second query is the index.

## 5. Set the ingest key

The device will send this key in `X-Ingest-Key`. Make a random one:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Store it in your password manager, then:

```powershell
npx wrangler@4 secret put INGEST_KEY
```

Paste the 64-character hex string when prompted. Do **not** commit it and do
not paste it into chat; I only need the Worker URL.

## 6. Deploy

```powershell
npx wrangler@4 deploy
```

First deploy asks to register a `workers.dev` subdomain; accept the suggested
name (for example `bnbcast`). It then prints:

```
https://race-tracker-history.<subdomain>.workers.dev
```

That URL is what the firmware and (later) the history panel use.

## 7. Smoke test

Replace `KEY` and `URL` below. This sends two frames: one valid fix, one with a
bad latitude.

```powershell
$key = "PASTE_THE_INGEST_KEY"
$url = "https://race-tracker-history.<subdomain>.workers.dev"
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

$body = @{
  device = "esp32-01"
  frames = @(
    @{ seq = 1; ts = $now; up = 10; boot = 1; fix = $true;  lat = -6.9; lng = 107.6; kmh = 12.5; hdop = 0.9; sats = 9; dist_m = 0 },
    @{ seq = 2; ts = $now; up = 11; boot = 1; fix = $true;  lat = 999;  lng = 107.6; kmh = 12.5; hdop = 0.9; sats = 9; dist_m = 0 }
  )
} | ConvertTo-Json -Depth 4

Invoke-RestMethod -Method Post -Uri "$url/ingest" `
  -Headers @{ "X-Ingest-Key" = $key } -ContentType "application/json" -Body $body
```

Expected:

```json
{ "ok": true, "received": 2, "stored": 1, "duplicates": 0,
  "rejected": [ { "seq": 2, "reason": "range" } ] }
```

Then read it back:

```powershell
Invoke-RestMethod "$url/history?from=$($now-60)&to=$($now+60)"
```

You should see one point. A wrong key returns `401`, a missing key returns `401`.

## 8. Send me only this

```
https://race-tracker-history.<subdomain>.workers.dev
```

I will wire the firmware batch upload and the dashboard history panel. Keep the
`INGEST_KEY` out of chat; it goes into the device build, not the public repo.

---

## Free-plan budget

| Limit | Free plan | This project |
|---|---|---|
| Worker requests | 100,000/day | ~2,900/day at one batch per 30 s |
| D1 rows written | 100,000/day | ≤ 86,400 (only while moving) |
| D1 rows read | 5,000,000/day | ~3,000 |
| D1 storage | 5 GB | ~1-2 GB for 365 days |
| Cron triggers | included | 1/day for retention |

Storage policy is in `worker/src/index.js`: every frame while moving, one frame
every 10 s while parked, no GPS fix = not stored. That keeps a full year well
inside 5 GB.

## Later: rotating the key

```powershell
npx wrangler@4 secret put INGEST_KEY   # paste the new value
```

Then rebuild and reflash the firmware with the same value. The dashboard does
not need it: `/history` is read-only and public.

## What is public

- The `workers.dev` URL and `/history` are public, like the map. A precise
  public track is a frozen product decision.
- `/ingest` requires the key. Without it, writes are refused.
- No accounts, no cookies, no PII stored.

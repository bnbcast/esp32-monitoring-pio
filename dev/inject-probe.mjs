/*
 * dev/inject-probe.mjs - insert a few synthetic fixes into the live API so the
 * dashboard history tab can be exercised without driving. Test-only helper.
 *
 *   node dev/inject-probe.mjs [count] [delete]
 *
 * The key is read from %USERPROFILE%\.esp32-race-tracker\ingest.key and is
 * never printed. Rows are written for device esp32-01, the same device the
 * dashboard queries; run with "delete" afterwards to remove them.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const API = 'https://race-tracker-history.pages.dev';
const keyFile = path.join(os.homedir(), '.esp32-race-tracker', 'ingest.key');
const key = fs.readFileSync(keyFile, 'utf8').trim();

const count = Number(process.argv[2] || 3);
const mode = process.argv[3] || 'insert';
const now = Math.floor(Date.now() / 1000);

if (mode === 'delete') {
  // No delete endpoint by design; the beacon is a plain SQL purge via wrangler.
  console.log('delete rows with: DELETE FROM fixes WHERE device=\'esp32-01\' AND seq BETWEEN 990000 AND 990099;');
  process.exit(0);
}

// A short, plausible walk: ~9 m per 60 s step, moving, good HDOP.
const base = { lat: -6.914744, lng: 107.609810 };
const frames = [];
for (let i = 0; i < count; i++) {
  frames.push({
    seq: 990000 + i,
    ts: now - (count - 1 - i) * 60,
    up: 500 + i * 60,
    boot: 990,
    gps: {
      fix: true,
      lat: base.lat + i * 0.00008,
      lng: base.lng + i * 0.00006,
      kmh: 22 + i,
      cog: 45,
      hdop: 0.8,
      sats: 9,
      dist_m: i * 9
    }
  });
}

const res = await fetch(`${API}/ingest`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-ingest-key': key },
  body: JSON.stringify({ device: 'esp32-01', frames })
});
console.log('POST /ingest ->', res.status, await res.text());

/*
 * worker/src/index.js - race history ingestion and read API.
 *
 * One free Worker + one free D1 database. The ESP32 keeps publishing live data
 * to HiveMQ exactly as today; history is a separate, best-effort HTTPS batch
 * path, so a Worker outage can never stop the live map.
 *
 * Endpoints
 *   POST /ingest    X-Ingest-Key: <secret>
 *                   {"device":"esp32-01","frames":[<mqtt payload>, ...]}
 *   GET  /history   ?device=&from=<epoch>&to=<epoch>&limit=<n>
 *   GET  /health
 *
 * Storage policy - 365 days must fit the free 5 GB D1:
 *   - only frames with a GPS fix are stored
 *   - moving (kmh >= 3): every frame (1 Hz)
 *   - parked: one frame every 10 s
 * That is roughly 9-10 M rows a year, comfortably under the limit.
 *
 * The device deletes a batch on any 2xx, including frames rejected here, so one
 * permanently bad reading cannot jam the ring buffer.
 */

const DEVICE = 'esp32-01';
const MAX_FRAMES = 120;              // two minutes at 1 Hz
const MAX_BODY_CHARS = 64 * 1024;
const MAX_KMH = 150;
const MAX_HDOP = 8;
const CLOCK_FUTURE_S = 3600;         // same generosity as web/ui/guard.js
const CLOCK_PAST_S = 7 * 24 * 3600;
const PARKED_STORE_S = 10;
const RETENTION_S = 365 * 24 * 3600;
const RETENTION_EVERY_S = 24 * 3600;  // Pages has no cron; ingest drives this
const TELEPORT_FACTOR = 1.5;
const TELEPORT_SLACK_M = 20;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-ingest-key'
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/health') return json({ ok: true, service: 'race-tracker-history' });
    if (url.pathname === '/history' && request.method === 'GET') return history(url, env);
    if (url.pathname === '/ingest' && request.method === 'POST') return ingest(request, env);
    return json({ ok: false, error: 'not-found' }, 404);
  },

  async scheduled(event, env, ctx) {
    // Kept for the Worker variant (worker/wrangler.toml has the cron). The
    // production deployment is a Pages Function, which has no cron triggers,
    // so ingest() performs the same purge at most once a day.
    ctx.waitUntil(purge(env, Math.floor(Date.now() / 1000)));
  }
};

async function ingest(request, env) {
  if (!env.INGEST_KEY) return json({ ok: false, error: 'ingest-key-not-set' }, 503);
  if (!safeEqual(request.headers.get('x-ingest-key') || '', env.INGEST_KEY)) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return json({ ok: false, error: 'body-too-large' }, 413);

  let body;
  try { body = JSON.parse(text); } catch (e) { return json({ ok: false, error: 'bad-json' }, 400); }

  const frames = Array.isArray(body) ? body : body && body.frames;
  if (!Array.isArray(frames) || frames.length === 0) {
    return json({ ok: false, error: 'no-frames' }, 400);
  }
  if (frames.length > MAX_FRAMES) return json({ ok: false, error: 'too-many-frames' }, 413);

  const device = String((body && body.device) || DEVICE).slice(0, 32);
  const nowS = Math.floor(Date.now() / 1000);

  const anchor = await env.DB.prepare(
    'SELECT boot, seq, ts, lat, lon FROM fixes WHERE device = ? ORDER BY boot DESC, seq DESC LIMIT 1'
  ).bind(device).first();

  let prev = anchor ? { boot: anchor.boot, seq: anchor.seq, ts: anchor.ts, lat: anchor.lat, lon: anchor.lon } : null;
  let lastStoredTs = anchor ? anchor.ts : null;

  const rows = [];
  const rejected = [];
  let duplicates = 0;

  for (const f of frames) {
    const reason = checkFrame(f, prev, nowS);
    if (reason === 'duplicate') { duplicates++; continue; }
    if (reason) { rejected.push({ seq: f && f.seq, reason }); continue; }

    const g = gpsOf(f);
    if (g.fix) {
      const stored = shouldStore(g, f.ts, lastStoredTs);
      if (stored) {
        rows.push(f);
        lastStoredTs = f.ts;
      }
      prev = { boot: bootOf(f), seq: f.seq, ts: f.ts, lat: g.lat, lon: g.lng };
    }
  }

  if (rows.length) {
    const stmt = env.DB.prepare(
      `INSERT OR IGNORE INTO fixes
       (device, boot, seq, ts, up, lat, lon, alt, kmh, cog, hdop, sats, dist_m, received)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    await env.DB.batch(rows.map(f => {
      const g = gpsOf(f);
      return stmt.bind(
        device, bootOf(f), f.seq, f.ts, f.up, g.lat, g.lng,
        numOrNull(g.alt), numOrNull(g.kmh), numOrNull(g.cog),
        numOrNull(g.hdop), intOrNull(g.sats), numOrNull(g.dist_m), nowS
      );
    }));
  }

  let retention = 'skipped';
  try {
    const purged = await runRetention(env, nowS);
    if (purged != null) retention = purged;
  } catch (e) {
    // A missing meta table or a failed purge must never fail an ingest: the
    // device deletes the batch on any 2xx, and a 5xx would only make it retry.
    retention = 'error';
  }

  return json({
    ok: true,
    received: frames.length,
    stored: rows.length,
    duplicates,
    rejected,
    retention
  });
}

// Deletes rows past the retention window and returns how many went.
async function purge(env, nowS) {
  const cutoff = nowS - RETENTION_S;
  const res = await env.DB.prepare('DELETE FROM fixes WHERE ts < ?').bind(cutoff).run();
  return res.meta ? res.meta.changes : 0;
}

// Pages Functions have no cron triggers, so ingest drives retention. Claim the
// once-a-day slot in `meta`, then purge. Returns null when not due yet, else
// the number of deleted rows.
async function runRetention(env, nowS) {
  const dueBefore = nowS - RETENTION_EVERY_S;

  const bumped = await env.DB.prepare(
    "UPDATE meta SET value = ? WHERE key = 'retention' AND CAST(value AS INTEGER) < ?"
  ).bind(String(nowS), String(dueBefore)).run();
  let due = !!(bumped.meta && bumped.meta.changes);

  if (!due) {
    const created = await env.DB.prepare(
      "INSERT OR IGNORE INTO meta (key, value) VALUES ('retention', ?)"
    ).bind(String(nowS)).run();
    due = !!(created.meta && created.meta.changes);
  }
  if (!due) return null;

  try {
    return await purge(env, nowS);
  } catch (e) {
    // Let the next ingest try again instead of waiting another 24 h.
    try { await env.DB.prepare("UPDATE meta SET value = '0' WHERE key = 'retention'").run(); } catch (e2) { /* ignore */ }
    throw e;
  }
}

async function history(url, env) {  const now = Math.floor(Date.now() / 1000);
  const from = intParam(url, 'from', now - 24 * 3600);
  const to = intParam(url, 'to', now);
  const limit = Math.min(Math.max(intParam(url, 'limit', 2000), 1), 5000);
  if (!(from < to)) return json({ ok: false, error: 'bad-window' }, 400);

  const device = (url.searchParams.get('device') || DEVICE).slice(0, 32);
  const { results } = await env.DB.prepare(
    `SELECT ts, lat, lon, kmh, cog, hdop FROM fixes
     WHERE device = ? AND ts >= ? AND ts <= ? ORDER BY ts LIMIT ?`
  ).bind(device, from, to, limit).all();

  return json({
    ok: true,
    device,
    from,
    to,
    count: results.length,
    truncated: results.length === limit,
    points: results.map(r => [r.ts, r.lat, r.lon, r.kmh, r.cog, r.hdop])
  });
}

// Returns null when the frame is acceptable, otherwise a reason string.
// "duplicate" is special: it is skipped, not counted as an error.
function checkFrame(f, prev, nowS) {
  if (!f || typeof f !== 'object') return 'shape';
  if (!isNum(f.seq) || !isNum(f.up)) return 'shape';
  if (!isNum(f.ts) || f.ts <= 0) return 'shape';
  if (f.ts > nowS + CLOCK_FUTURE_S || nowS - f.ts > CLOCK_PAST_S) return 'clock';

  const boot = bootOf(f);
  if (prev) {
    if (boot < prev.boot) return 'stale-boot';
    if (boot === prev.boot) {
      if (f.seq === prev.seq) return 'duplicate';
      if (f.seq < prev.seq) return 'stale-seq';
    }
  }

  // The device publishes {"seq":..,"gps":{"fix":..,"lat":..},...}. Accept the
  // flat form too, so a hand-written smoke test is easy to send.
  const g = gpsOf(f);
  if (!g.fix) return null;                       // no-fix frames are valid, not stored

  if (!isNum(g.lat) || !isNum(g.lng)) return 'shape';
  if (g.lat < -90 || g.lat > 90 || g.lng < -180 || g.lng > 180) return 'range';
  if (isNum(g.kmh) && (g.kmh < 0 || g.kmh > MAX_KMH)) return 'speed';
  if (isNum(g.hdop) && g.hdop > MAX_HDOP) return 'hdop';

  if (prev && isNum(prev.lat) && isNum(prev.lon)) {
    let dt = f.ts - prev.ts;
    if (!isNum(dt) || dt < 0.5) dt = 0.5;        // buffered frames can be close
    const allow = (MAX_KMH / 3.6) * dt * TELEPORT_FACTOR + TELEPORT_SLACK_M;
    if (haversineM(prev.lat, prev.lon, g.lat, g.lng) > allow) return 'teleport';
  }

  return null;
}

function shouldStore(g, ts, lastTs) {
  if (isNum(g.kmh) && g.kmh >= 3) return true;   // moving
  return !isNum(lastTs) || ts - lastTs >= PARKED_STORE_S;
}

// GPS fields live under "gps" in the real payload; the flat fallback keeps
// curl smoke tests short.
function gpsOf(f) {
  return f.gps && typeof f.gps === 'object' ? f.gps : f;
}

function bootOf(f) {
  return isNum(f.boot) ? f.boot : 0;
}

function isNum(v) {
  return typeof v === 'number' && isFinite(v);
}

function numOrNull(v) {
  return isNum(v) ? v : null;
}

function intOrNull(v) {
  return isNum(v) ? Math.round(v) : null;
}

function intParam(url, name, fallback) {
  const n = Number(url.searchParams.get(name));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Constant-time compare so the key cannot be guessed byte by byte.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS }
  });
}

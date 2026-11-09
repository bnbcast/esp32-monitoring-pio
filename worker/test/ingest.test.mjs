/*
 * worker/test/ingest.test.mjs - ingest/history rules against an in-memory D1.
 *
 *   node --test worker/test/ingest.test.mjs
 *
 * A fake D1 is enough here: the interesting logic is in index.js (frame
 * validation, parked suppression, duplicate detection, window queries), not in
 * SQLite. The fake recognises the exact statements the worker prepares.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const KEY = 'test-key-0123456789abcdef0123456789abcdef';

function fakeD1() {
  const rows = [];
  let lastId = 0;

  const db = {
    rows,
    prepare(sql) {
      // Mirror real D1: bind() returns a NEW statement; mutating one and
      // reusing it would make batch() insert only the last frame.
      const make = (args) => ({
        bind(...a) { return make(a); },
        async first() {
          if (!sql.includes('SELECT boot, seq, ts, lat, lon FROM fixes')) throw new Error('first: ' + sql);
          const device = args[0];
          const mine = rows.filter(r => r.device === device)
            .sort((a, b) => (b.boot - a.boot) || (b.seq - a.seq));
          return mine[0] || null;
        },
        async run() {
          if (sql.includes('DELETE FROM fixes WHERE ts <')) {
            const cutoff = args[0];
            const before = rows.length;
            for (let i = rows.length - 1; i >= 0; i--) if (rows[i].ts < cutoff) rows.splice(i, 1);
            return { meta: { changes: before - rows.length } };
          }
          throw new Error('run: ' + sql);
        },
        async all() {
          if (!sql.includes('SELECT ts, lat, lon, kmh, cog, hdop FROM fixes')) throw new Error('all: ' + sql);
          const [device, from, to, limit] = args;
          const out = rows
            .filter(r => r.device === device && r.ts >= from && r.ts <= to)
            .sort((a, b) => a.ts - b.ts)
            .slice(0, limit)
            .map(r => ({ ts: r.ts, lat: r.lat, lon: r.lon, kmh: r.kmh, cog: r.cog, hdop: r.hdop }));
          return { results: out };
        },
        _insert() {
          // device, boot, seq, ts, up, lat, lon, alt, kmh, cog, hdop, sats, dist_m, received
          const [device, boot, seq, ts, up, lat, lon, alt, kmh, cog, hdop, sats, dist_m, received] = args;
          if (rows.some(r => r.device === device && r.boot === boot && r.seq === seq)) return { meta: { changes: 0 } };
          rows.push({ id: ++lastId, device, boot, seq, ts, up, lat, lon, alt, kmh, cog, hdop, sats, dist_m, received });
          return { meta: { changes: 1 } };
        }
      });
      return make([]);
    },
    async batch(stmts) {
      return stmts.map(s => s._insert());
    }
  };
  return db;
}

const now = () => Math.floor(Date.now() / 1000);

function frame(over = {}) {
  return {
    seq: 1, ts: now(), up: 10, boot: 1,
    gps: { fix: true, lat: -6.9, lng: 107.6, kmh: 12, hdop: 0.9, sats: 8, dist_m: 0 },
    ...over
  };
}

function post(env, frames, key = KEY) {
  const headers = { 'content-type': 'application/json' };
  if (key !== null) headers['x-ingest-key'] = key;
  return worker.fetch(new Request('https://x/ingest', {
    method: 'POST', headers, body: JSON.stringify({ device: 'esp32-01', frames })
  }), env);
}

const env = () => ({ DB: fakeD1(), INGEST_KEY: KEY });

test('health needs no key', async () => {
  const r = await worker.fetch(new Request('https://x/health'), env());
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, service: 'race-tracker-history' });
});

test('missing and wrong key are rejected', async () => {
  assert.equal((await post(env(), [frame()], null)).status, 401);
  assert.equal((await post(env(), [frame()], 'nope')).status, 401);
});

test('key not configured returns 503, not 401', async () => {
  const e = { DB: fakeD1(), INGEST_KEY: '' };
  assert.equal((await post(e, [frame()])).status, 503);
});

test('moving fix is stored, out-of-range lat is rejected', async () => {
  const e = env();
  const r = await post(e, [frame({ seq: 1 }), frame({ seq: 2, gps: { fix: true, lat: 999, lng: 107.6 } })]);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.received, 2);
  assert.equal(body.stored, 1);
  assert.deepEqual(body.rejected, [{ seq: 2, reason: 'range' }]);
  assert.equal(e.DB.rows.length, 1);
});

test('a frame without a fix is accepted but never stored', async () => {
  const e = env();
  const r = await post(e, [frame({ seq: 1, gps: { fix: false } })]);
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.stored, 0);
  assert.deepEqual(body.rejected, []);
  assert.equal(e.DB.rows.length, 0);
});

test('parked frames are throttled to one per 10 s', async () => {
  const e = env();
  const t = now();
  const parked = (seq, ts) => frame({ seq, ts, gps: { fix: true, lat: -6.9, lng: 107.6, kmh: 0, hdop: 0.8 } });
  const body = await (await post(e, [parked(1, t), parked(2, t + 4), parked(3, t + 10)])).json();
  assert.equal(body.stored, 2, 'first and +10s kept, +4s skipped');
  assert.equal(e.DB.rows.length, 2);
});

test('a repeated seq is a duplicate, not an error', async () => {
  const e = env();
  const f = frame({ seq: 7 });
  await post(e, [f]);
  const body = await (await post(e, [f])).json();
  assert.equal(body.duplicates, 1);
  assert.equal(body.stored, 0);
  assert.deepEqual(body.rejected, []);
});

test('stale seq after the anchor is rejected', async () => {
  const e = env();
  await post(e, [frame({ seq: 20 })]);
  const body = await (await post(e, [frame({ seq: 10, ts: now() + 1 })])).json();
  assert.deepEqual(body.rejected, [{ seq: 10, reason: 'stale-seq' }]);
});

test('teleport and clock are rejected', async () => {
  const e = env();
  await post(e, [frame({ seq: 1, ts: now() })]);
  const teleport = frame({ seq: 2, ts: now() + 1, gps: { fix: true, lat: 40, lng: -74, kmh: 10 } });
  const clock = frame({ seq: 3, ts: now() - 30 * 24 * 3600 });
  const body = await (await post(e, [teleport, clock])).json();
  const reasons = body.rejected.map(x => x.reason).sort();
  assert.deepEqual(reasons, ['clock', 'teleport']);
});

test('bad hdop and speed are rejected', async () => {
  const e = env();
  const body = await (await post(e, [
    frame({ seq: 1, gps: { fix: true, lat: -6.9, lng: 107.6, hdop: 30 } }),
    frame({ seq: 2, gps: { fix: true, lat: -6.9, lng: 107.6, kmh: 400 } })
  ])).json();
  assert.deepEqual(body.rejected.map(x => x.reason).sort(), ['hdop', 'speed']);
});

test('empty and oversized batches are refused', async () => {
  const e = env();
  assert.equal((await post(e, [])).status, 400);
  const many = Array.from({ length: 121 }, (_, i) => frame({ seq: i + 1 }));
  assert.equal((await post(e, many)).status, 413);
});

test('history returns only the requested window, oldest first', async () => {
  const e = env();
  const t = now();
  await post(e, [
    frame({ seq: 1, ts: t - 100 }),
    frame({ seq: 2, ts: t - 50, gps: { fix: true, lat: -6.91, lng: 107.61, kmh: 11 } }),
    frame({ seq: 3, ts: t - 10, gps: { fix: true, lat: -6.92, lng: 107.62, kmh: 13 } })
  ]);
  const r = await worker.fetch(new Request(`https://x/history?from=${t - 60}&to=${t}`), e);
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.count, 2);
  assert.deepEqual(body.points.map(p => p[0]), [t - 50, t - 10], 'ts ascending');
  assert.equal(body.points[0][3], 11);
});

test('history rejects an inverted window', async () => {
  const e = env();
  const r = await worker.fetch(new Request('https://x/history?from=100&to=50'), e);
  assert.equal(r.status, 400);
});

test('retention deletes rows older than 365 days', async () => {
  const e = env();
  // Ingest would reject this on the clock gate, so seed it directly: retention
  // has to work on whatever is already in the table.
  e.DB.rows.push({
    id: 1, device: 'esp32-01', boot: 1, seq: 1, ts: now() - 400 * 24 * 3600,
    up: 1, lat: -6.9, lon: 107.6, alt: null, kmh: 0, cog: null, hdop: 0.9, sats: 8, dist_m: 0, received: 0
  });
  assert.equal(e.DB.rows.length, 1);
  let waited = null;
  await worker.scheduled({}, e, { waitUntil: p => { waited = p; } });
  await waited;
  assert.equal(e.DB.rows.length, 0);
});

test('unknown route is 404 and OPTIONS is CORS-only', async () => {
  assert.equal((await worker.fetch(new Request('https://x/nope'), env())).status, 404);
  const opt = await worker.fetch(new Request('https://x/ingest', { method: 'OPTIONS' }), env());
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get('access-control-allow-origin'), '*');
});

-- worker/migrations/2026-11-laps-gen.sql
--
-- Key the lap log on the device's session generation instead of its boot
-- counter. The board persists its lap counters in NVS, so after a reboot it
-- still reports "lap 5" while `boot` has advanced; the old key logged that lap
-- a second time under the new boot.
--
-- Apply once, before deploying the worker that writes `gen`:
--   npx wrangler@latest d1 execute race-tracker --remote \
--     --file=migrations/2026-11-laps-gen.sql
--
-- Existing rows keep their boot value as the generation. Boot numbers are
-- unique and monotonic per device, so nothing in the old data collides.
-- `laps` must already exist (schema.sql or 2026-11-laps-lean.sql); this file
-- is not idempotent on purpose: running it twice should stop, not guess.

CREATE TABLE laps_v2 (
  device   TEXT    NOT NULL,
  gen      INTEGER NOT NULL,
  n        INTEGER NOT NULL,
  ts       INTEGER NOT NULL,
  dur_ms   INTEGER NOT NULL,
  best_ms  INTEGER,
  received INTEGER NOT NULL,
  PRIMARY KEY (device, gen, n)
);

INSERT OR IGNORE INTO laps_v2 (device, gen, n, ts, dur_ms, best_ms, received)
  SELECT device, boot, n, ts, dur_ms, best_ms, received FROM laps;

DROP TABLE laps;

ALTER TABLE laps_v2 RENAME TO laps;

CREATE INDEX IF NOT EXISTS idx_laps_device_ts ON laps (device, ts);

-- worker/migrations/2026-11-laps-lean.sql
--
-- Upgrade an existing race-tracker database for the lap log and the lean
-- trace. schema.sql already contains all of this for a fresh database; this
-- file is only for the one that is already running.
--
-- Apply once, before deploying the worker that writes these columns:
--   npx wrangler@latest d1 execute race-tracker --remote \
--     --file=migrations/2026-11-laps-lean.sql
--
-- ALTER TABLE ADD COLUMN fails if the column already exists, so this file is
-- not idempotent on purpose: running it twice should stop, not guess.

ALTER TABLE fixes ADD COLUMN roll  REAL;
ALTER TABLE fixes ADD COLUMN pitch REAL;

CREATE TABLE IF NOT EXISTS laps (
  device   TEXT    NOT NULL,
  boot     INTEGER NOT NULL,
  n        INTEGER NOT NULL,
  ts       INTEGER NOT NULL,
  dur_ms   INTEGER NOT NULL,
  best_ms  INTEGER,
  received INTEGER NOT NULL,
  PRIMARY KEY (device, boot, n)
);

CREATE INDEX IF NOT EXISTS idx_laps_device_ts ON laps (device, ts);

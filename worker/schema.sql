-- worker/schema.sql - D1 schema for race history.
--
-- One row per stored fix. `boot` is part of the key because `seq` restarts at
-- 1 after every reboot; (device, boot, seq) is what makes a retried batch
-- idempotent.
--
-- Apply with:
--   npx wrangler@latest d1 execute race-tracker --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS fixes (
  device   TEXT    NOT NULL,
  boot     INTEGER NOT NULL DEFAULT 0,
  seq      INTEGER NOT NULL,
  ts       INTEGER NOT NULL,           -- UTC epoch seconds, from GPS
  up       INTEGER NOT NULL,           -- seconds since boot
  lat      REAL    NOT NULL,
  lon      REAL    NOT NULL,
  alt      REAL,
  kmh      REAL,
  cog      REAL,
  hdop     REAL,
  sats     INTEGER,
  dist_m   REAL,
  roll     REAL,                       -- body roll from the MPU at this fix
  pitch    REAL,
  received INTEGER NOT NULL,           -- epoch seconds, server side
  PRIMARY KEY (device, boot, seq)
);

-- Route queries are always "this device, this time window".
CREATE INDEX IF NOT EXISTS idx_fixes_device_ts ON fixes (device, ts);

-- One row per completed lap, written when the device's lap counter moves.
-- The frame carries the counter and the duration, so the server only has to
-- notice the change; INSERT OR IGNORE makes a retried batch harmless.
CREATE TABLE IF NOT EXISTS laps (
  device   TEXT    NOT NULL,
  boot     INTEGER NOT NULL,
  n        INTEGER NOT NULL,           -- lap number from the device
  ts       INTEGER NOT NULL,           -- UTC epoch of the frame that carried it
  dur_ms   INTEGER NOT NULL,           -- that lap's time
  best_ms  INTEGER,                    -- best at that moment
  received INTEGER NOT NULL,
  PRIMARY KEY (device, boot, n)
);

CREATE INDEX IF NOT EXISTS idx_laps_device_ts ON laps (device, ts);

-- Small key/value table for jobs that must run at most once a day.
-- Pages Functions have no cron triggers, so retention is driven from /ingest:
-- the first batch after 24 h deletes rows older than 365 days and records the
-- timestamp here. Two statements, only when due.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

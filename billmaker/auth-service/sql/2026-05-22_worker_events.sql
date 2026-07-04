-- worker_events: structured log of every notable Cloudflare Worker event
-- (cron runs, sync results, aggregate recomputes, errors). Powers the
-- "Worker" tab on the /admin/logs page.
--
-- Apply via Supabase SQL editor:
--   1. Open https://supabase.com/dashboard → your project → SQL Editor
--   2. Paste this file's contents
--   3. Run
--
-- Idempotent — safe to run multiple times.

CREATE TABLE IF NOT EXISTS worker_events (
  id         BIGSERIAL    PRIMARY KEY,
  ts         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  shop_code  TEXT         NOT NULL,
  level      TEXT         NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  event      TEXT         NOT NULL,
  payload    JSONB
);

-- Compound index: most queries are "events for shop X, newest first"
CREATE INDEX IF NOT EXISTS idx_worker_events_shop_ts
  ON worker_events (shop_code, ts DESC);

-- Filtering by event type ("show me all sync_completed") + by level ("show errors only")
CREATE INDEX IF NOT EXISTS idx_worker_events_event_ts
  ON worker_events (event, ts DESC);
CREATE INDEX IF NOT EXISTS idx_worker_events_level_ts
  ON worker_events (level, ts DESC);

-- Retention: 10 days. The worker's runWeeklyCleanup (Sun 03:00 UTC) prunes
-- rows older than this — keeps the table under Supabase free-tier storage
-- (~3,000 events ≈ 1.5 MB at any time at typical event volume).
COMMENT ON TABLE worker_events IS
  'Structured Cloudflare Worker events. Auto-pruned by runWeeklyCleanup to last 10 days.';

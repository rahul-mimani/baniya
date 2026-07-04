-- alert_state: throttling table for worker error email alerts.
--
-- The scheduled handler checks this table after every cron tick. If errors
-- occurred AND the last alert was sent more than 1 hour ago, it sends one
-- summary email to ADMIN_ALERT_EMAIL and updates last_alert_at to NOW.
--
-- One row per shop. Keeps a running alert_count for visibility.
--
-- Apply via Supabase SQL editor. Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS alert_state (
  shop_code            TEXT PRIMARY KEY,
  last_alert_at        TIMESTAMPTZ,
  last_alert_signature TEXT,
  alert_count          INT NOT NULL DEFAULT 0
);

COMMENT ON TABLE alert_state IS
  'Throttling state for worker error email alerts. One row per shop. The scheduled handler reads/writes this from src/lib/alerts.ts maybeAlertOnError().';

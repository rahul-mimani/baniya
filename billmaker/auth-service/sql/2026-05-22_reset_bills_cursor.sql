-- Reset the bills sync cursor.
--
-- Background: the worker's incremental sync for `bills` previously used
-- `updatedAt` (mobile's ISO string) as the cursor field. Portal admin
-- writes like Release/customer-link DON'T touch updatedAt — they only
-- stamp `lastModified`. So acks were silently dropped from incremental sync.
--
-- Fix: the worker now uses `lastModified` (Firestore Timestamp) as the
-- bills cursor. This SQL clears the existing high-water mark so the next
-- sync does a one-time full pull, then continues incrementally from
-- lastModified going forward.
--
-- Apply order:
--   1. Deploy the worker code change (auth-service/src/lib/sync.ts) FIRST
--   2. Run this SQL on the matching Supabase project (non-prod first, then prod)
--   3. Trigger /admin/sync/trigger/bills (or wait for the next 5-min cron)
--      — that one run will be a full reconcile, taking longer than usual
--   4. Subsequent runs incremental again, fast

UPDATE sync_state
   SET cursor_updated_at = NULL,
       last_error = NULL
 WHERE collection = 'bills';

-- Verify (run after the next sync):
--   SELECT shop_code, collection, cursor_updated_at, total_upserts, last_success_at
--   FROM sync_state
--   WHERE collection = 'bills';

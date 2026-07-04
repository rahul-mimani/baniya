-- Phase B / Task 2: Realtime + RLS for BillMaker mobile.
--
-- Mobile (BillMaker shopkeeper app) connects directly to Supabase Realtime
-- using a 15-minute JWT minted by the auth-service's /auth/realtime-token
-- endpoint after Firebase ID token verification.
--
-- This migration:
--   1. Publishes `replica_documents` on the `supabase_realtime` publication
--      so postgres_changes events stream to subscribers.
--   2. Enables Row-Level Security on `replica_documents`.
--   3. Adds an RLS policy allowing the `authenticated` role (which the
--      minted JWT carries) to SELECT rows where shop_code matches the
--      JWT's `shop_code` custom claim.
--   4. Leaves `service_role` (used by the worker) bypassing RLS — that's
--      the default Postgres behavior for that role.
--
-- Apply via Supabase Dashboard → SQL Editor.
-- Idempotent — safe to re-run.

-- 1. Add table to the realtime publication if not already.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'replica_documents'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.replica_documents';
  END IF;
END
$$;

-- 2. Enable RLS. Without this, ANY authenticated JWT could read everything
--    via the auto-generated PostgREST endpoints.
ALTER TABLE public.replica_documents ENABLE ROW LEVEL SECURITY;

-- 3. Per-shop SELECT policy for the `authenticated` role.
--    auth.jwt() returns the JSON claims of the currently-presented JWT.
--    Our /auth/realtime-token endpoint mints JWTs with shop_code as a
--    top-level custom claim, so `->> 'shop_code'` extracts it as text.
--
--    Mobile is read-only via this channel — writes still go through the
--    Firestore SDK directly. So we deliberately do NOT add INSERT/UPDATE
--    /DELETE policies for the authenticated role.
DROP POLICY IF EXISTS mobile_select_own_shop ON public.replica_documents;
CREATE POLICY mobile_select_own_shop ON public.replica_documents
  FOR SELECT TO authenticated
  USING (
    shop_code = (auth.jwt() ->> 'shop_code')
  );

-- 4. Realtime broadcasts use the same RLS policy when filtering events to
--    each connection. Supabase's `realtime.subscription` view applies RLS
--    automatically — no extra config needed.

-- Verify after running:
--   1. SELECT pubname, schemaname, tablename FROM pg_publication_tables
--      WHERE tablename = 'replica_documents';
--      -- should return one row
--
--   2. SELECT polname FROM pg_policies
--      WHERE tablename = 'replica_documents';
--      -- should include mobile_select_own_shop
--
--   3. With a test JWT minted via /auth/realtime-token for shop_code='X':
--        curl -H "apikey: <ANON_KEY>" \
--             -H "Authorization: Bearer <MINTED_TOKEN>" \
--             "https://<project>.supabase.co/rest/v1/replica_documents?select=collection,firestore_id&limit=5"
--      -- should return rows ONLY for shop_code='X'

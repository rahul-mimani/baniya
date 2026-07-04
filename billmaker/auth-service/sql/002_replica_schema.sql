-- ============================================================================
-- Baniya Auth Service — replica schema (Phase 2)
-- ============================================================================
-- Run this ONCE in Supabase SQL Editor AFTER 001_initial_schema.sql.
--
-- This file adds:
--   1. replica_documents     — a single generic mirror table that holds every
--                              Firestore doc the auth-service knows about.
--                              One row per (shop, collection, firestore_id).
--                              Document body is JSONB; cheap to extend without
--                              migrations when mobile/portal adds new fields.
--   2. sync_state            — bookkeeping per (shop, collection): when we last
--                              ran, the high-water cursor, error if any.
--
-- Collections mirrored (see src/lib/sync.ts):
--   bills              ← mobile, canonical
--   payments           ← mobile
--   profiles           ← mobile (seller-side, public-safe fields only)
--   _meta              ← mobile (single doc id='business')
--   portal_customers   ← admin portal (canonical Customer with class/aliases)
--   portal_products    ← admin portal (canonical Product with prices/images)
--   portal_labels      ← admin portal
--   portal_classes     ← admin portal (class display names + colors)
--   portal_deals       ← admin portal
--   portal_bills_meta  ← admin portal (per-bill acknowledgments)
-- ============================================================================


-- ----------------------------------------------------------------------------
-- replica_documents
--
-- Generic mirror. Generated columns expose the common query paths
-- (customer_id, customer_name, bill_id, visible_to_client) so that read
-- endpoints can filter without scanning JSONB. All other fields are read out
-- of `data` at serve time.
-- ----------------------------------------------------------------------------
create table if not exists replica_documents (
  shop_code             text        not null references shops(code) on delete cascade,
  collection            text        not null,
  firestore_id          text        not null,
  data                  jsonb       not null,

  -- Generated columns — kept in sync automatically with data->>'...'.
  -- `stored` (not virtual) so they can be indexed.
  customer_id           text        generated always as (data->>'customerId') stored,
  customer_name         text        generated always as (data->>'customerName') stored,
  bill_id               text        generated always as (data->>'billId') stored,
  visible_to_client     boolean     generated always as
                         (case when data ? 'visibleToClient'
                               then (data->>'visibleToClient')::boolean
                               else null end) stored,

  -- The doc's own updatedAt/createdAt from Firestore (whichever is newest).
  -- Used for incremental sync — we fetch docs with source_updated_at > cursor.
  source_updated_at     timestamptz,

  -- When this row was last refreshed by the sync engine.
  last_synced_at        timestamptz not null default now(),

  primary key (shop_code, collection, firestore_id)
);

-- Fast: list all docs in a collection for a shop.
create index if not exists replica_docs_collection_idx
  on replica_documents (shop_code, collection);

-- Fast: client looks up their own bills by customer id or name (mobile bills
-- store the customer as a name string, portal bills carry customerId).
create index if not exists replica_docs_customer_id_idx
  on replica_documents (shop_code, collection, customer_id)
  where customer_id is not null;

create index if not exists replica_docs_customer_name_idx
  on replica_documents (shop_code, collection, customer_name)
  where customer_name is not null;

-- Fast: client looks up payments for one of their bills.
create index if not exists replica_docs_bill_id_idx
  on replica_documents (shop_code, collection, bill_id)
  where bill_id is not null;

-- Fast: client product/deal catalogue — only items flagged for clients.
create index if not exists replica_docs_visible_idx
  on replica_documents (shop_code, collection)
  where visible_to_client = true;

-- Fast: incremental sync cursor scan.
create index if not exists replica_docs_updated_idx
  on replica_documents (shop_code, collection, source_updated_at desc)
  where source_updated_at is not null;


-- ----------------------------------------------------------------------------
-- sync_state
--
-- Per shop/collection sync bookkeeping. The cron handler reads cursor_updated_at,
-- queries Firestore for documents where updatedAt > cursor, upserts them, and
-- advances the cursor.
-- ----------------------------------------------------------------------------
create table if not exists sync_state (
  shop_code              text        not null references shops(code) on delete cascade,
  collection             text        not null,
  last_run_started_at    timestamptz,
  last_run_finished_at   timestamptz,
  last_success_at        timestamptz,
  -- High-water mark on source_updated_at. Null = never synced yet → next run
  -- does a full pull from the start of time.
  cursor_updated_at      timestamptz,
  -- Last error, cleared on success.
  last_error             text,
  -- Cumulative count of docs upserted across all runs. Sanity number.
  total_upserts          int         not null default 0,
  -- Doc count seen on the most recent run. Useful for the admin status page.
  last_run_doc_count     int         not null default 0,
  primary key (shop_code, collection)
);


-- ----------------------------------------------------------------------------
-- Helper view: latest sync activity per shop.
-- ----------------------------------------------------------------------------
create or replace view v_sync_status as
  select
    shop_code,
    collection,
    last_run_finished_at,
    last_success_at,
    cursor_updated_at,
    total_upserts,
    last_run_doc_count,
    last_error,
    case
      when last_error is not null then 'error'
      when last_success_at is null then 'pending'
      when last_run_finished_at > last_success_at then 'running'
      else 'ok'
    end as status
  from sync_state;


-- ----------------------------------------------------------------------------
-- Cleanup suggestion: nothing to prune routinely — replica rows reflect live
-- Firestore state. If a doc is deleted in Firestore, the sync engine
-- detects the absence on the next full pass and removes it from replica.
-- ----------------------------------------------------------------------------

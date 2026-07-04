-- ============================================================================
-- Baniya Auth Service — quote requests
-- ============================================================================
-- Run this ONCE after 004_shop_settings.sql.
--
-- A "quote request" is a client-initiated message to the shop admin asking
-- for a price on a specific product, optionally at a proposed price + with a
-- note. Admin sees them in their dashboard and can respond by setting a
-- status + writing a reply comment.
--
-- Latency-tolerant: clients see their submissions in their own /client/quotes
-- list immediately; admin reads /admin/quotes on demand. No realtime needed.
-- ============================================================================

create table if not exists quote_requests (
  id                 uuid primary key default gen_random_uuid(),
  shop_code          text not null references shops(code) on delete cascade,

  -- Who submitted the quote (the logged-in client user).
  user_id            uuid not null references users(id) on delete cascade,
  -- Snapshot of the user's portal_customer id + name at submission time, so
  -- the admin view can show "Ravi Kumar" even if the customer is renamed.
  customer_id        text,
  customer_name      text,

  -- The product being quoted on. We store an id + name snapshot rather than
  -- joining live to portal_products, so deleted products still render
  -- coherently in the quotes table.
  product_id         text not null,
  product_name       text,
  product_unit       text,

  -- Required: how many units they want
  quantity           numeric not null check (quantity > 0),
  -- Optional: a price they're hoping for (per unit). Null = no proposal.
  proposed_price     numeric check (proposed_price is null or proposed_price >= 0),
  -- Optional client-side note (e.g. "I need this by Friday").
  note               text,

  -- Workflow status. Admin updates this via PATCH /admin/quotes/:id.
  status             text not null default 'pending'
                       check (status in ('pending', 'accepted', 'rejected', 'fulfilled')),
  -- Optional admin reply (visible to client).
  admin_response     text,

  created_at         timestamptz not null default now(),
  responded_at       timestamptz
);

-- Common admin queries: list quotes for a shop, optionally filtered by status,
-- sorted newest first.
create index if not exists quotes_shop_status_idx
  on quote_requests (shop_code, status, created_at desc);

-- Client "my quotes" lookup.
create index if not exists quotes_user_idx
  on quote_requests (user_id, created_at desc);

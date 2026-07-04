-- ============================================================================
-- Baniya Auth Service — bill reprint requests
-- ============================================================================
-- Run this ONCE after 005_quote_requests.sql.
--
-- A "reprint request" is a client-initiated request asking the shop to send a
-- new physical bill. Admin sees them in /admin/reprints and "releases" them
-- (resolves) when done, after which the client can request again for the
-- same bill.
--
-- Single-pending-per-bill invariant enforced by a partial unique index on
-- (bill_id, status='pending'). This prevents accidental double-submissions
-- AND lets the same bill be re-requested after the previous one is released.
-- ============================================================================

create table if not exists reprint_requests (
  id            uuid primary key default gen_random_uuid(),
  shop_code     text not null references shops(code) on delete cascade,

  -- The bill this reprint is for. We store id + number + customer name
  -- snapshots so the admin UI can render quickly without joins, and the row
  -- still makes sense even if the bill is later deleted in Firestore.
  bill_id       text not null,
  bill_number   text,
  customer_name text,
  customer_id   text,

  -- Who asked
  user_id       uuid not null references users(id) on delete cascade,

  -- Workflow: pending until admin marks it released. Admin can also reject.
  status        text not null default 'pending'
                  check (status in ('pending', 'released', 'rejected')),

  -- Optional client note (e.g. "lost the original")
  note          text,
  -- Optional admin note when releasing/rejecting
  admin_note    text,

  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);

-- Lookup: admin pulls pending requests, sorted oldest-first for FIFO handling.
create index if not exists reprint_shop_status_idx
  on reprint_requests (shop_code, status, created_at);

-- Lookup: client checks if a specific bill has a pending request.
create index if not exists reprint_bill_status_idx
  on reprint_requests (bill_id, status);

-- Lookup: client lists their own history.
create index if not exists reprint_user_idx
  on reprint_requests (user_id, created_at desc);

-- One pending request per bill. Released/rejected rows don't count toward the
-- conflict, so the bill can be re-requested after a previous one resolves.
create unique index if not exists reprint_one_pending_per_bill
  on reprint_requests (bill_id)
  where status = 'pending';

-- ============================================================================
-- BillMaker Auth Service — initial schema
-- ============================================================================
-- Run this ONCE in Supabase SQL Editor (Database → SQL Editor → New query).
-- All tables live in the default `public` schema and are accessed only via
-- the service_role key (which bypasses RLS). The anon key is disabled at the
-- API gateway level — only our Worker can connect.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- shops: one row per BillMaker installation. The `code` matches the Shop Code
-- you configured in the web portal's Admin Settings and in BillMaker mobile.
-- ----------------------------------------------------------------------------
create table if not exists shops (
  code        text primary key,
  name        text not null,
  created_at  timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- users: every person who can log into the web portal (clients + admin).
-- `identifier` is the email (or eventually phone) used to log in. unique
-- across the system so a single email can't belong to two roles/shops.
-- ----------------------------------------------------------------------------
create table if not exists users (
  id                  uuid primary key default gen_random_uuid(),
  identifier          text not null unique,
  identifier_type     text not null default 'email' check (identifier_type in ('email','phone')),
  name                text not null,
  role                text not null check (role in ('client','admin')),
  shop_code           text not null references shops(code) on delete cascade,
  customer_id         text,
  class               text,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  last_login_at       timestamptz,
  created_by_user_id  uuid references users(id) on delete set null,
  unique (shop_code, customer_id)
);

create index if not exists users_shop_role_idx on users (shop_code, role);
create index if not exists users_active_idx on users (active) where active;

-- ----------------------------------------------------------------------------
-- otp_requests: every OTP we've generated. PBKDF2 hash stored (not the OTP
-- itself). Used for rate-limit derivation (count rows by identifier or ip in
-- the last hour) and for verify-otp matching.
-- ----------------------------------------------------------------------------
create table if not exists otp_requests (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references users(id) on delete cascade,
  identifier      text not null,
  ip_address      text,
  otp_hash        text not null,
  prefix          text not null,
  expires_at      timestamptz not null,
  attempts        int not null default 0,
  used            boolean not null default false,
  created_at      timestamptz not null default now()
);

create index if not exists otp_identifier_idx on otp_requests (identifier, created_at desc);
create index if not exists otp_ip_idx on otp_requests (ip_address, created_at desc) where ip_address is not null;
create index if not exists otp_user_pending_idx on otp_requests (user_id, used, expires_at);

-- ----------------------------------------------------------------------------
-- sessions: every issued JWT registers a session row. JWT carries the `jti`
-- (UUID); every protected request verifies that the jti exists, is_not_revoked,
-- and is not past `expires_at`. Lets us revoke any token instantly.
-- ----------------------------------------------------------------------------
create table if not exists sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  token_jti     uuid not null unique,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz not null default now(),
  user_agent    text,
  ip_address    text,
  revoked       boolean not null default false
);

create index if not exists sessions_jti_idx on sessions (token_jti);
create index if not exists sessions_user_id_idx on sessions (user_id);

-- ----------------------------------------------------------------------------
-- Helper view: pending OTP for an identifier (most recent, unused, unexpired)
-- ----------------------------------------------------------------------------
create or replace view v_pending_otp as
  select distinct on (identifier) *
  from otp_requests
  where used = false
    and expires_at > now()
  order by identifier, created_at desc;

-- ----------------------------------------------------------------------------
-- Cleanup job suggestion: prune expired OTPs + old sessions weekly.
-- Run manually or set up a Supabase cron extension later.
--
--   delete from otp_requests where expires_at < now() - interval '7 days';
--   delete from sessions where expires_at < now() - interval '7 days';
-- ----------------------------------------------------------------------------

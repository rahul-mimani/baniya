-- ============================================================================
-- BillMaker Auth Service — shop-level settings
-- ============================================================================
-- Run this ONCE after 003_case_insensitive_match.sql.
--
-- Adds admin-editable settings to the shops table:
--   - admin_contact_email: shown to a client during login if their account has
--     no email configured ("Please contact <admin email>"). Optional — if
--     null, the login page falls back to a generic message.
--   - admin_contact_phone: same idea, optional secondary contact.
--   - display_name: human-readable shop name shown in the login page header.
-- ============================================================================

alter table shops
  add column if not exists admin_contact_email text,
  add column if not exists admin_contact_phone text,
  add column if not exists display_name text;


-- ----------------------------------------------------------------------------
-- Phone lookup index on replica_documents
--
-- Clients log in by phone. The portal stores phone numbers in various formats
-- ("+91 98765 43210", "9876543210", etc.), so we normalize to digits-only and
-- index that for fast lookups. The generated column ignores all non-digit
-- characters, including +, spaces, hyphens, parens.
-- ----------------------------------------------------------------------------
alter table replica_documents
  add column if not exists phone_normalized text
  generated always as (
    case when data ? 'phone'
      then regexp_replace(coalesce(data->>'phone', ''), '[^0-9]', '', 'g')
      else null
    end
  ) stored;

create index if not exists replica_docs_phone_normalized_idx
  on replica_documents (shop_code, collection, phone_normalized)
  where phone_normalized is not null and phone_normalized <> '';

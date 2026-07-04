-- ============================================================================
-- Baniya Auth Service — case-insensitive customer name matching
-- ============================================================================
-- Run this ONCE after 002_replica_schema.sql.
--
-- The portal stores `data.customerName` exactly as the user typed it — so a
-- portal_customer "John Doe" might be linked to bills written by mobile as
-- "john doe" or "John Doe ". To make the client lookup robust to these
-- harmless differences, add a normalized generated column + index that the
-- /client/bills query can target.
--
-- Normalization: lowercased + trimmed. Mirrors the portal's existing dedup
-- logic in dummyData.ts (which uses .toLowerCase()).
-- ============================================================================

alter table replica_documents
  add column if not exists customer_name_norm text
  generated always as (
    case when data ? 'customerName'
      then lower(trim(data->>'customerName'))
      else null
    end
  ) stored;

create index if not exists replica_docs_customer_name_norm_idx
  on replica_documents (shop_code, collection, customer_name_norm)
  where customer_name_norm is not null;

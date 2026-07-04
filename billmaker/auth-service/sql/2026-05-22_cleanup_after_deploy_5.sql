-- Cleanup SQL — run AFTER deploying Phase 5 changes.
--
-- Removes Supabase artifacts for things that are no longer used:
--   1. payments collection (now in bills.payments[])
--   2. Aggregate recompute function (admin_aggregates fields now maintained
--      by portal+mobile atomic increment; only customer.outstanding still
--      needs SQL).
--   3. sync_state row for payments.
--
-- Run order: deploy code FIRST, then run this. Otherwise the worker still
-- tries to sync payments and you get errors.

-- 1. Stop tracking payments in sync_state so worker stops trying to sync it.
DELETE FROM sync_state
 WHERE collection = 'payments';

-- 2. Delete replica rows for the payments collection (the data is now
--    embedded in bills.data->'payments'). Keep for now if you want a
--    backup; otherwise drop.
-- (Uncomment to actually delete)
-- DELETE FROM replica_documents
--  WHERE collection = 'payments';

-- 3. Update the admin_aggregates SQL function so it only returns
--    perCustomerOutstanding (the only field worker still computes). Other
--    fields (totalBilled, totalRevenue, outstanding, totalBillCount,
--    pendingCount) are now maintained by portal+mobile atomic increment.
--    bills.data->'payments' is the source for revenue/outstanding sums.

create or replace function admin_aggregates_recompute(p_shop text)
returns jsonb
language plpgsql
stable
as $$
declare
  result jsonb;
begin
  with
  -- Customer name → customer id lookup.
  customer_lookup as (
    select
      firestore_id as customer_id,
      coalesce(data->>'name', '')  as customer_name,
      lower(trim(coalesce(data->>'name', ''))) as match_name
    from replica_documents
    where shop_code = p_shop and collection = 'portal_customers'
    union
    select
      firestore_id as customer_id,
      coalesce(data->>'name', '')  as customer_name,
      lower(trim(alias)) as match_name
    from replica_documents,
         jsonb_array_elements_text(coalesce(data->'aliases', '[]'::jsonb)) as alias
    where shop_code = p_shop and collection = 'portal_customers'
      and alias is not null and alias <> ''
  ),
  -- Per-bill totals from data.total + embedded payments sum.
  per_bill as (
    select
      lower(trim(coalesce(data->>'customerName', ''))) as customer_match,
      coalesce(data->>'customerName', '') as customer_name_raw,
      coalesce(nullif(data->>'total', '')::numeric, 0) as bill_total,
      -- Sum amounts from the embedded payments array.
      coalesce(
        (select sum(coalesce(nullif(item->>'amount','')::numeric, 0))
         from jsonb_array_elements(coalesce(data->'payments', '[]'::jsonb)) as item),
        0
      ) as bill_paid
    from replica_documents
    where shop_code = p_shop and collection = 'bills'
  ),
  -- Resolve customer key.
  per_bill_with_key as (
    select
      b.bill_total,
      b.bill_paid,
      coalesce(cl.customer_id, b.customer_name_raw) as customer_key,
      coalesce(cl.customer_name, b.customer_name_raw, '') as customer_display_name,
      (cl.customer_id is not null) as has_customer_id
    from per_bill b
    left join customer_lookup cl on cl.match_name = b.customer_match
  ),
  per_customer as (
    select
      customer_key,
      customer_display_name,
      has_customer_id,
      sum(bill_total - bill_paid) as outstanding
    from per_bill_with_key
    where customer_key <> ''
    group by customer_key, customer_display_name, has_customer_id
    having sum(bill_total - bill_paid) > 0
  )
  select jsonb_build_object(
    'perCustomerOutstanding', coalesce(
      (
        select jsonb_object_agg(
          customer_key,
          jsonb_build_object(
            'name', customer_display_name,
            'outstanding', outstanding,
            'hasId', has_customer_id
          )
        )
        from per_customer
      ),
      '{}'::jsonb
    )
  ) into result;

  return result;
end;
$$;

grant execute on function admin_aggregates_recompute(text) to service_role;

-- Verify after running:
--   SELECT collection, count(*) FROM replica_documents GROUP BY collection;
--   -- payments should be 0 (if you uncommented step 2)
--   SELECT * FROM sync_state ORDER BY collection;
--   -- payments row should be gone

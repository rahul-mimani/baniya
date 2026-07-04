-- Phase B / EMERGENCY RECONCILE function.
--
-- Restores the full admin_aggregates_recompute() SQL function, which the
-- worker uses ONLY when an admin clicks "Reconcile aggregates" in the
-- portal (via /admin/sync/reconcile?force_aggregates=true).
--
-- Routine aggregate maintenance is NOT done by this function anymore.
-- After Phase B incremental refactor, the worker maintains
-- admin_aggregates via atomic increment() per bill delta (computeBillDelta
-- in src/lib/aggregates.ts), matching the portal's patchAdminAggregates
-- pattern. The SQL function here is the safety net: if increments ever
-- drift (e.g. a worker crash mid-tick), the admin can force a full
-- recompute that overwrites the doc with the authoritative SQL result.
--
-- Returned shape (unchanged from prior versions):
--   {
--     totalBilled, totalRevenue, outstanding,
--     totalBillCount, pendingCount,
--     perCustomerOutstanding
--   }
--
-- Returned shape:
--   {
--     totalBilled,         numeric
--     totalRevenue,        numeric  (sum of bill.payments[].amount)
--     outstanding,         numeric  (totalBilled - totalRevenue)
--     totalBillCount,      integer
--     pendingCount,        integer  (bills where acknowledged != true)
--     perCustomerOutstanding: { <customer_key>: { name, outstanding, hasId } }
--   }
--
-- productCount is fetched separately via PostgREST HEAD count on
-- portal_products and merged on the worker side. Keeps this function focused
-- on bills-derived numbers.
--
-- Apply via Supabase Dashboard → SQL Editor. Replaces prior version
-- (function name unchanged — drop+recreate via CREATE OR REPLACE).

create or replace function admin_aggregates_recompute(p_shop text)
returns jsonb
language plpgsql
stable
as $$
declare
  result jsonb;
begin
  with
  -- Customer name → customer id lookup (canonical name + each alias).
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
  -- Per-bill totals from data.total + embedded payments sum + ack flag.
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
      ) as bill_paid,
      coalesce((data->>'acknowledged')::boolean, false) as is_acked
    from replica_documents
    where shop_code = p_shop and collection = 'bills'
  ),
  -- Resolve customer key (matched portal_customer id, or raw name fallback).
  per_bill_with_key as (
    select
      b.bill_total,
      b.bill_paid,
      b.is_acked,
      coalesce(cl.customer_id, b.customer_name_raw) as customer_key,
      coalesce(cl.customer_name, b.customer_name_raw, '') as customer_display_name,
      (cl.customer_id is not null) as has_customer_id
    from per_bill b
    left join customer_lookup cl on cl.match_name = b.customer_match
  ),
  -- Roll-up per customer (only positive outstanding shows up).
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
  ),
  -- Shop-wide totals.
  totals as (
    select
      sum(bill_total)::numeric as total_billed,
      sum(bill_paid)::numeric  as total_revenue,
      count(*)::integer        as bill_count,
      sum(case when is_acked then 0 else 1 end)::integer as pending_count
    from per_bill
  )
  select jsonb_build_object(
    'totalBilled',    coalesce((select total_billed from totals), 0),
    'totalRevenue',   coalesce((select total_revenue from totals), 0),
    'outstanding',    coalesce((select total_billed - total_revenue from totals), 0),
    'totalBillCount', coalesce((select bill_count from totals), 0),
    'pendingCount',   coalesce((select pending_count from totals), 0),
    'customerCount',  coalesce(
      (select count(*)::integer from replica_documents
        where shop_code = p_shop and collection = 'portal_customers'),
      0
    ),
    'dealCount',      coalesce(
      (select count(*)::integer from replica_documents
        where shop_code = p_shop and collection = 'portal_deals'),
      0
    ),
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

-- Verify with: SELECT admin_aggregates_recompute('your-shop-code');

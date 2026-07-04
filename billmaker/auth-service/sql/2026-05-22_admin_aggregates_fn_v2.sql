-- Admin aggregates v2 — reads ack from `bills` collection directly.
--
-- WHY: After retiring portal_bills_meta (2026-05-22), ack lives on the bill
-- doc itself at `bills/<id>.acknowledged`. The previous version of this
-- function still counted acks from the legacy portal_bills_meta collection,
-- which has been purged — so it always returned acked_count = 0, making
-- pendingCount equal to totalBillCount, and the Released tab badge stuck at 0.
--
-- This version reads `bills.data->>'acknowledged'` directly. portal_bills_meta
-- is no longer referenced.
--
-- Apply order:
--   1. Run this in non-prod Supabase → verify aggregates correct
--   2. Run in prod Supabase
--   3. Trigger /admin/sync/trigger?force_aggregates=true → aggregate doc refreshes

create or replace function admin_aggregates_recompute(p_shop text)
returns jsonb
language plpgsql
stable
as $$
declare
  result jsonb;
begin
  with
  -- Customer name → customer id lookup. Two rows per portal_customer:
  -- one for the canonical name and one per alias.
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
  -- Bills with per-item total derived from products[] (mobile shape) AND the
  -- acknowledged flag. NULL/missing acknowledged → false (= still pending).
  bill_data as (
    select
      coalesce(data->>'customerName', '') as customer_name_raw,
      lower(trim(coalesce(data->>'customerName', ''))) as customer_match,
      coalesce(
        (
          select sum(
            coalesce(
              nullif(item->>'amount', '')::numeric,
              coalesce(nullif(item->>'price', '')::numeric,
                       nullif(item->>'rate', '')::numeric, 0)
              *
              coalesce(nullif(item->>'quantity', '')::numeric,
                       nullif(item->>'qty', '')::numeric, 0)
            )
          )
          from jsonb_array_elements(
            coalesce(data->'products', data->'items', '[]'::jsonb)
          ) as item
        ),
        0
      ) as total,
      firestore_id as bill_id,
      -- NEW: pull ack directly off the bill doc. Treat missing/null as false.
      coalesce((data->>'acknowledged')::boolean, false) as acknowledged
    from replica_documents
    where shop_code = p_shop and collection = 'bills'
  ),
  -- Per-bill payment totals.
  payment_sums as (
    select
      data->>'billId' as bill_id,
      sum(coalesce(nullif(data->>'amount', '')::numeric, 0)) as paid_total
    from replica_documents
    where shop_code = p_shop and collection = 'payments'
    group by data->>'billId'
  ),
  -- Join bills with their resolved customer id and payment totals.
  per_bill as (
    select
      b.bill_id,
      b.total          as bill_total,
      coalesce(p.paid_total, 0) as bill_paid,
      b.acknowledged   as acknowledged,
      -- Resolve customer key: real id if matched, else fall back to raw name.
      coalesce(cl.customer_id, b.customer_name_raw) as customer_key,
      coalesce(cl.customer_name, b.customer_name_raw, '') as customer_display_name,
      (cl.customer_id is not null) as has_customer_id
    from bill_data b
    left join payment_sums p using (bill_id)
    left join customer_lookup cl on cl.match_name = b.customer_match
  ),
  -- Per-customer outstanding (>0 only).
  per_customer as (
    select
      customer_key,
      customer_display_name,
      has_customer_id,
      sum(bill_total - bill_paid) as outstanding
    from per_bill
    where customer_key <> ''
    group by customer_key, customer_display_name, has_customer_id
    having sum(bill_total - bill_paid) > 0
  ),
  totals as (
    select
      coalesce(sum(bill_total), 0)::numeric as total_billed,
      coalesce(sum(bill_paid), 0)::numeric  as total_revenue,
      count(*)::int                          as total_bill_count,
      -- NEW: count acks directly from bills, not from portal_bills_meta.
      count(*) filter (where acknowledged)::int as acked_count
    from per_bill
  )
  select jsonb_build_object(
    'totalBilled',     t.total_billed,
    'totalRevenue',    t.total_revenue,
    'outstanding',     t.total_billed - t.total_revenue,
    'totalBillCount',  t.total_bill_count,
    'pendingCount',    greatest(t.total_bill_count - t.acked_count, 0),
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
  ) into result
  from totals t;

  return result;
end;
$$;

grant execute on function admin_aggregates_recompute(text) to service_role;

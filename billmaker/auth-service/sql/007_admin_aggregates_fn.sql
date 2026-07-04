-- Admin aggregates — full recompute function.
--
-- Used by the Worker's daily safety recompute (heals drift from delta-update
-- bugs) and the manual reconcile button. The 5-min cron does cheap delta
-- updates instead and never calls this.
--
-- Returns a single JSONB matching the structure of the
-- shops/<shop>/_meta/admin_aggregates Firestore doc.
--
-- KEY CONVENTIONS (matched against portal logic):
--
--   Bill total: mobile bills don't carry a top-level `total`. Computed per
--     item as: amount || (price|rate) * (quantity|qty). Sum across items.
--     Mirrors applyBillsSnapshot / reviveItems in web-portal/data/dummyData.
--
--   Bill paid: SUM of payments.amount where payments.billId = bill id.
--     Mirrors recomputeBillPaidFromPayments.
--
--   Pending: total_bill_count - count(portal_bills_meta WHERE acknowledged=true).
--     Bills with no meta doc are implicitly pending. Mirrors AdminHome.tsx.
--
--   Customer key: portal_customers.id (via case-insensitive match of bill's
--     customerName against portal_customers.name and aliases[]). Falls back
--     to the raw customerName when no portal_customer exists (mirrors the
--     `b.customerId || b.customerName` pattern in AdminCustomers.tsx).

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
  -- Bills with per-item total derived from products[] (mobile shape).
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
      firestore_id as bill_id
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
      count(*)::int                          as total_bill_count
    from per_bill
  ),
  -- Count of acked meta docs that correspond to a bill that still exists in
  -- replica. Filters out orphan metas (meta exists, bill was deleted) so we
  -- don't over-subtract from the pending count.
  acked_count as (
    select count(*)::int as acked
    from replica_documents m
    where m.shop_code = p_shop
      and m.collection = 'portal_bills_meta'
      and (m.data->>'acknowledged')::boolean = true
      and exists (
        select 1 from replica_documents b
        where b.shop_code = m.shop_code
          and b.collection = 'bills'
          and b.firestore_id = m.firestore_id
      )
  )
  select jsonb_build_object(
    'totalBilled',     t.total_billed,
    'totalRevenue',    t.total_revenue,
    'outstanding',     t.total_billed - t.total_revenue,
    'totalBillCount',  t.total_bill_count,
    'pendingCount',    greatest(t.total_bill_count - (select acked from acked_count), 0),
    -- Map keyed by customer_id (or raw name fallback). Value carries name +
    -- amount so the portal can display without a second lookup.
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

-- Grant execute to the service role used by the Worker.
grant execute on function admin_aggregates_recompute(text) to service_role;

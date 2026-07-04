// /client/* — read-only endpoints for logged-in customers.
//
// All routes:
//   - require a valid JWT (requireAuth)
//   - serve data ONLY from the Supabase replica (never touch Firestore)
//   - are scoped strictly by the JWT's shop_code; bills/payments additionally
//     filtered by the JWT's customer_id
//
// Phase 2 is read-only: no client routes mutate state. If/when clients need
// to acknowledge a bill or similar, that goes through a write route that
// proxies to Firestore via the auth-service (Phase 3).

import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { requireAuth } from '../lib/middleware';
import {
  listCollection,
  getDocById,
  listBillsByCustomerNames,
  type ReplicaDoc,
} from '../lib/replica';
import { insert, select } from '../lib/db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', requireAuth);

interface PortalCustomerData {
  id?: string;
  name?: string;
  email?: string;
  phone?: string;
  class?: string;
  aliases?: string[];
  [k: string]: any;
}

// Helper — load the client's portal_customer record. Most endpoints need it
// either for the customer's name+aliases (to filter bills) or for the class
// (to filter products/deals).
const loadClientCustomer = async (
  env: Env,
  shopCode: string,
  customerId: string | null,
): Promise<ReplicaDoc<PortalCustomerData> | null> => {
  if (!customerId) return null;
  return getDocById<PortalCustomerData>(env, shopCode, 'portal_customers', customerId);
};


// ---------------------------------------------------------------------------
// GET /client/me — the client's own profile + customer record + business info
// + the shop's class definitions (so ClassBadge etc. resolve correctly without
// a separate round-trip).
// ---------------------------------------------------------------------------
app.get('/me', async c => {
  const user = c.get('user');
  const [customer, business, classes] = await Promise.all([
    loadClientCustomer(c.env, user.shop_code, user.customer_id),
    getDocById(c.env, user.shop_code, '_meta', 'business'),
    listCollection(c.env, user.shop_code, 'portal_classes'),
  ]);
  return c.json({
    user: {
      id: user.id,
      identifier: user.identifier,
      name: user.name,
      role: user.role,
      class: user.class,
    },
    customer: customer?.data ?? null,
    business: business?.data ?? null,
    // Class definitions for the shop — { code, name, color } per row. Used by
    // the client portal to render Class A/B/C... badges with the admin's
    // chosen display names instead of fallback "Class A".
    classes: classes.map(c => ({ id: c.id, ...c.data })),
  });
});


// ---------------------------------------------------------------------------
// GET /client/bills — all bills for this customer (by name + aliases),
// bundled with acknowledgment metadata + payments so the portal hook can
// render the list with one round-trip.
//
// The response is intentionally a flat union — the client merges them. A
// single endpoint here is cheap and keeps the auth-service stateless; if we
// split into 3 endpoints, the client would need to coordinate 3 calls just
// to render the bills page.
// ---------------------------------------------------------------------------
app.get('/bills', async c => {
  const user = c.get('user');
  const customer = await loadClientCustomer(c.env, user.shop_code, user.customer_id);
  if (!customer) return c.json({ bills: [], billsMeta: [], payments: [] });

  const names = [customer.data.name, ...(customer.data.aliases || [])]
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
  if (names.length === 0) return c.json({ bills: [], billsMeta: [], payments: [] });

  const bills = await listBillsByCustomerNames(c.env, user.shop_code, names);
  const billIds = bills.map(b => b.id);

  // billsMeta is now derived inline from the bill docs themselves — ack lives
  // on bills/<id>.acknowledged + acknowledgedAt as of the schema freeze. We
  // still return it as a separate array so deployed client apps that merge
  // it keep working unchanged.
  const billsMeta = bills
    .filter(b => b.data.acknowledged === true)
    .map(b => ({
      id: b.id,
      acknowledged: true,
      acknowledgedAt: b.data.acknowledgedAt ?? null,
    }));

  // Pending reprints for any of the client's bills — used by the UI to
  // disable the "Request reprint" button while one is in flight.
  let pendingReprints: Array<{ id: string; bill_id: string; status: string; created_at: string }> = [];
  if (billIds.length > 0) {
    const quoted = billIds.map(id => `"${id.replace(/"/g, '\\"')}"`).join(',');
    pendingReprints = await select(c.env, 'reprint_requests',
      `bill_id=in.(${encodeURIComponent(quoted)})&status=eq.pending&select=id,bill_id,status,created_at`);
  }

  // Payments live INSIDE each bill's `payments[]` array (Deploy 5). Flatten
  // them out so the response keeps its existing shape — deployed clients that
  // read the top-level `payments` array continue to work, and the post-Deploy-5
  // payments (which don't exist in the legacy `payments` collection) flow
  // through correctly. Dedup by id in case a bill happens to list the same
  // payment twice.
  const payments = flattenBillPayments(bills);

  return c.json({
    bills: bills.map(b => ({ id: b.id, ...b.data })),
    billsMeta,
    payments,
    pendingReprints,
  });
});


// ---------------------------------------------------------------------------
// GET /client/bills/:id — one bill detail, plus its payments inline.
// Verifies that the bill belongs to the requesting customer.
// ---------------------------------------------------------------------------
app.get('/bills/:id', async c => {
  const user = c.get('user');
  const id = c.req.param('id');
  const customer = await loadClientCustomer(c.env, user.shop_code, user.customer_id);
  if (!customer) return c.json({ error: 'not_found' }, 404);

  const bill = await getDocById(c.env, user.shop_code, 'bills', id);
  if (!bill) return c.json({ error: 'not_found' }, 404);

  const allowedNames = new Set(
    [customer.data.name, ...(customer.data.aliases || [])]
      .filter((n): n is string => typeof n === 'string'),
  );
  if (!allowedNames.has(bill.data.customerName)) {
    // Pretend it doesn't exist rather than leak that it does but they can't see it.
    return c.json({ error: 'not_found' }, 404);
  }

  const payments = flattenBillPayments([bill]);
  return c.json({
    bill: { id: bill.id, ...bill.data },
    payments,
  });
});


// ---------------------------------------------------------------------------
// GET /client/payments — all payments for the customer's bills.
// ---------------------------------------------------------------------------
app.get('/payments', async c => {
  const user = c.get('user');
  const customer = await loadClientCustomer(c.env, user.shop_code, user.customer_id);
  if (!customer) return c.json({ payments: [] });

  const names = [customer.data.name, ...(customer.data.aliases || [])]
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
  if (names.length === 0) return c.json({ payments: [] });

  const bills = await listBillsByCustomerNames(c.env, user.shop_code, names);
  return c.json({
    payments: flattenBillPayments(bills),
  });
});


/**
 * Flatten payments from `bill.payments[]` arrays into a single list, stamping
 * `billId` on each so legacy consumers (UI grouping by billId) keep working.
 * Source of truth as of Deploy 5: the legacy `payments` collection is frozen.
 */
const flattenBillPayments = (bills: ReplicaDoc[]): Array<Record<string, any>> => {
  const seen = new Set<string>();
  const out: Array<Record<string, any>> = [];
  for (const b of bills) {
    const arr = Array.isArray(b.data.payments) ? b.data.payments : [];
    for (const p of arr) {
      if (!p || typeof p !== 'object') continue;
      const id = typeof p.id === 'string' ? p.id : '';
      // Dedup on id within this response. Multiple bills should never share
      // a payment id, but a bill that happens to have duplicate entries in
      // its array (e.g., a stale arrayUnion before deep-equality dedup
      // converged) shouldn't make the client double-count.
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      out.push({ ...p, billId: b.id });
    }
  }
  return out;
};


/**
 * Resolve the class to use for product/deal filtering. portal_customer.class
 * is the source of truth (admin edits it via the Customers page). user.class
 * is a stale copy from when the login was created — only used as a fallback
 * when no portal_customer is linked. This keeps server-side filtering and
 * client-side display in lockstep (otherwise prices end up showing as ₹0
 * because the UI reads p.prices[me.class] for a class the server didn't
 * include in the prices map).
 */
const resolveClientClass = async (
  env: Env,
  user: { shop_code: string; customer_id: string | null; class: string | null },
): Promise<string | null> => {
  if (user.customer_id) {
    const customer = await loadClientCustomer(env, user.shop_code, user.customer_id);
    const cls = customer?.data?.class;
    if (typeof cls === 'string' && cls.length > 0) return cls;
  }
  return user.class;
};


// ---------------------------------------------------------------------------
// GET /client/products — product catalog filtered for this client's class.
// Returns only products where visibleToClient=true AND enabledClasses[<class>]=true.
// Filtering is done in app code because enabledClasses is a nested JSONB map
// that's awkward to filter in PostgREST.
// ---------------------------------------------------------------------------
app.get('/products', async c => {
  const user = c.get('user');
  const classKey = await resolveClientClass(c.env, user);
  const products = await listCollection(c.env, user.shop_code, 'portal_products',
    'visible_to_client=eq.true');
  const filtered = products
    .filter(p => !classKey || p.data.enabledClasses?.[classKey] === true)
    .map(p => {
      // Strip per-class prices the client shouldn't see — only return their class.
      const d = p.data;
      const priceForClass = classKey && d.prices?.[classKey] !== undefined
        ? Number(d.prices[classKey])
        : 0;
      return {
        id: p.id,
        ...d,
        // Backward-compat: keep per-class prices map with only this class
        prices: classKey && priceForClass > 0 ? { [classKey]: priceForClass } : {},
        // Forward: a resolved single price the UI can render without
        // having to know the class. The class itself is included for clarity.
        price: priceForClass,
        classKey,
        // Drop fields that leak admin-only info.
        enabledClasses: undefined,
        source: undefined,
      };
    });
  return c.json({ products: filtered, classKey });
});


// ---------------------------------------------------------------------------
// GET /client/deals — deals visible to this client's class.
// ---------------------------------------------------------------------------
app.get('/deals', async c => {
  const user = c.get('user');
  const classKey = await resolveClientClass(c.env, user);
  const deals = await listCollection(c.env, user.shop_code, 'portal_deals');
  const filtered = deals
    .filter(d => {
      const vc = d.data.visibleClasses;
      if (!Array.isArray(vc) || vc.length === 0) return false;
      return !classKey || vc.includes(classKey);
    })
    .map(d => ({ id: d.id, ...d.data }));
  return c.json({ deals: filtered, classKey });
});


// ---------------------------------------------------------------------------
// GET /client/labels — all labels (small list, no need to scope).
// ---------------------------------------------------------------------------
app.get('/labels', async c => {
  const user = c.get('user');
  const labels = await listCollection(c.env, user.shop_code, 'portal_labels');
  return c.json({ labels: labels.map(l => ({ id: l.id, ...l.data })) });
});


// ---------------------------------------------------------------------------
// GET /client/business — shop business info (name, phone, gst, address).
// ---------------------------------------------------------------------------
app.get('/business', async c => {
  const user = c.get('user');
  const business = await getDocById(c.env, user.shop_code, '_meta', 'business');
  return c.json({ business: business?.data ?? null });
});


// ===========================================================================
// Quote requests — client side
// ===========================================================================
interface DbQuote {
  id: string;
  shop_code: string;
  user_id: string;
  customer_id: string | null;
  customer_name: string | null;
  product_id: string;
  product_name: string | null;
  product_unit: string | null;
  quantity: number;
  proposed_price: number | null;
  note: string | null;
  status: 'pending' | 'accepted' | 'rejected' | 'fulfilled';
  admin_response: string | null;
  created_at: string;
  responded_at: string | null;
}

// ---------------------------------------------------------------------------
// POST /client/quotes
// Body: { productId, productName?, productUnit?, quantity, proposedPrice?, note? }
// ---------------------------------------------------------------------------
app.post('/quotes', async c => {
  const user = c.get('user');
  let body: {
    productId?: string;
    productName?: string;
    productUnit?: string;
    quantity?: number | string;
    proposedPrice?: number | string | null;
    note?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const productId = (body.productId || '').trim();
  const productName = (body.productName || '').trim() || null;
  const productUnit = (body.productUnit || '').trim() || null;
  const quantity = Number(body.quantity);
  const proposedPrice = body.proposedPrice === null || body.proposedPrice === undefined || body.proposedPrice === ''
    ? null
    : Number(body.proposedPrice);
  const note = (body.note || '').trim() || null;

  if (!productId) return c.json({ error: 'product_required' }, 400);
  if (!Number.isFinite(quantity) || quantity <= 0) return c.json({ error: 'invalid_quantity' }, 400);
  if (proposedPrice !== null && (!Number.isFinite(proposedPrice) || proposedPrice < 0)) {
    return c.json({ error: 'invalid_price' }, 400);
  }
  if (note && note.length > 2000) return c.json({ error: 'note_too_long' }, 400);

  // Cheap anti-spam: reject if the same user has > 30 quotes pending. (Admin
  // workflow expects a manageable inbox; this isn't a flood gate, just a
  // sanity check.)
  const existing = await select<DbQuote>(c.env, 'quote_requests',
    `user_id=eq.${encodeURIComponent(user.id)}&status=eq.pending&select=id`);
  if (existing.length >= 30) return c.json({ error: 'too_many_pending' }, 429);

  // Snapshot the customer name from the user record (already populated).
  const created = await insert<DbQuote>(c.env, 'quote_requests', {
    shop_code: user.shop_code,
    user_id: user.id,
    customer_id: user.customer_id,
    customer_name: user.name,
    product_id: productId,
    product_name: productName,
    product_unit: productUnit,
    quantity,
    proposed_price: proposedPrice,
    note,
  });

  return c.json({ ok: true, quote: created });
});

// ---------------------------------------------------------------------------
// GET /client/quotes — the client's own quote history.
// ---------------------------------------------------------------------------
app.get('/quotes', async c => {
  const user = c.get('user');
  const rows = await select<DbQuote>(c.env, 'quote_requests',
    `user_id=eq.${encodeURIComponent(user.id)}&order=created_at.desc`);
  return c.json({ quotes: rows });
});


// ===========================================================================
// Reprint requests — client side
// ===========================================================================
interface DbReprintRequest {
  id: string;
  shop_code: string;
  bill_id: string;
  bill_number: string | null;
  customer_name: string | null;
  customer_id: string | null;
  user_id: string;
  status: 'pending' | 'released' | 'rejected';
  note: string | null;
  admin_note: string | null;
  created_at: string;
  resolved_at: string | null;
}

// POST /client/bills/:id/reprint — submit a reprint request for one bill.
// Verifies the bill belongs to the requesting client before queueing.
app.post('/bills/:id/reprint', async c => {
  const user = c.get('user');
  const billId = c.req.param('id');

  let body: { note?: string };
  try { body = await c.req.json(); } catch { body = {}; }
  const note = (body.note || '').trim();

  // Validate the client owns this bill.
  const customer = await loadClientCustomer(c.env, user.shop_code, user.customer_id);
  if (!customer) return c.json({ error: 'not_found' }, 404);
  const bill = await getDocById(c.env, user.shop_code, 'bills', billId);
  if (!bill) return c.json({ error: 'not_found' }, 404);
  const allowedNames = new Set(
    [customer.data.name, ...(customer.data.aliases || [])]
      .filter((n): n is string => typeof n === 'string'),
  );
  if (!allowedNames.has(bill.data.customerName)) {
    return c.json({ error: 'not_found' }, 404);
  }

  // Refuse if a pending request already exists for this bill (the unique
  // index would reject anyway, but a friendly error beats a 500).
  const existing = await select<DbReprintRequest>(
    c.env, 'reprint_requests',
    `bill_id=eq.${encodeURIComponent(billId)}&status=eq.pending&select=id&limit=1`,
  );
  if (existing.length > 0) return c.json({ error: 'already_pending' }, 409);

  try {
    const created = await insert<DbReprintRequest>(c.env, 'reprint_requests', {
      shop_code: user.shop_code,
      bill_id: billId,
      bill_number: bill.data.billNumber || null,
      customer_name: bill.data.customerName || null,
      customer_id: user.customer_id,
      user_id: user.id,
      note: note || null,
    });
    return c.json({ ok: true, reprint: created });
  } catch (e: any) {
    // Race-condition fallback if two requests arrived in parallel.
    if (String(e?.message || '').includes('reprint_one_pending_per_bill')) {
      return c.json({ error: 'already_pending' }, 409);
    }
    throw e;
  }
});

// GET /client/bills/:id/reprint — current pending request for this bill (or null).
app.get('/bills/:id/reprint', async c => {
  const user = c.get('user');
  const billId = c.req.param('id');
  const rows = await select<DbReprintRequest>(c.env, 'reprint_requests',
    `bill_id=eq.${encodeURIComponent(billId)}` +
    `&user_id=eq.${encodeURIComponent(user.id)}` +
    `&order=created_at.desc&limit=1`);
  return c.json({ reprint: rows[0] ?? null });
});


export default app;

// /admin/quotes/* — admin views of client-submitted quote requests.
//
// Endpoints:
//   GET   /admin/quotes              — list, with optional ?status filter
//   PATCH /admin/quotes/:id          — set admin_response and/or status
//
// All shop-scoped by the admin's shop_code (no cross-shop leakage).

import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { requireAuth, requireAdmin } from '../lib/middleware';
import { select, update } from '../lib/db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', requireAuth, requireAdmin);

const VALID_STATUS = ['pending', 'accepted', 'rejected', 'fulfilled'] as const;
type QuoteStatus = typeof VALID_STATUS[number];

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
  status: QuoteStatus;
  admin_response: string | null;
  created_at: string;
  responded_at: string | null;
}

// GET /admin/quotes?status=pending  (status optional)
app.get('/', async c => {
  const admin = c.get('user');
  const statusFilter = c.req.query('status');
  let filter = `shop_code=eq.${encodeURIComponent(admin.shop_code)}&order=created_at.desc`;
  if (statusFilter && (VALID_STATUS as readonly string[]).includes(statusFilter)) {
    filter += `&status=eq.${statusFilter}`;
  }
  const rows = await select<DbQuote>(c.env, 'quote_requests', filter);
  return c.json({ quotes: rows });
});

// PATCH /admin/quotes/:id  body { status?, admin_response? }
app.patch('/:id', async c => {
  const admin = c.get('user');
  const id = c.req.param('id');

  let body: { status?: string; admin_response?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const patch: Record<string, unknown> = {};
  if (body.status !== undefined) {
    if (!(VALID_STATUS as readonly string[]).includes(body.status)) {
      return c.json({ error: 'invalid_status' }, 400);
    }
    patch.status = body.status;
  }
  if (body.admin_response !== undefined) {
    const r = (body.admin_response || '').trim();
    if (r.length > 4000) return c.json({ error: 'response_too_long' }, 400);
    patch.admin_response = r || null;
  }
  if (Object.keys(patch).length === 0) return c.json({ error: 'no_fields' }, 400);

  // Stamp responded_at whenever the admin touches the row.
  patch.responded_at = new Date().toISOString();

  // Scope the update by shop_code to prevent admins of one shop touching
  // another shop's quotes (defense in depth — multi-tenant readiness).
  const updated = await update<DbQuote>(
    c.env,
    'quote_requests',
    `id=eq.${encodeURIComponent(id)}&shop_code=eq.${encodeURIComponent(admin.shop_code)}`,
    patch,
  );
  if (!updated[0]) return c.json({ error: 'not_found' }, 404);

  return c.json({ ok: true, quote: updated[0] });
});

export default app;

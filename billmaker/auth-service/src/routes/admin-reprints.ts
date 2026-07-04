// /admin/reprints/* — admin's queue of pending bill-reprint requests.
//
// Endpoints:
//   GET   /admin/reprints              — list, with optional ?status filter
//   PATCH /admin/reprints/:id          — set status (release/reject) + admin_note

import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { requireAuth, requireAdmin } from '../lib/middleware';
import { select, update } from '../lib/db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', requireAuth, requireAdmin);

const VALID_STATUS = ['pending', 'released', 'rejected'] as const;
type ReprintStatus = typeof VALID_STATUS[number];

interface DbReprint {
  id: string;
  shop_code: string;
  bill_id: string;
  bill_number: string | null;
  customer_name: string | null;
  customer_id: string | null;
  user_id: string;
  status: ReprintStatus;
  note: string | null;
  admin_note: string | null;
  created_at: string;
  resolved_at: string | null;
}

// GET /admin/reprints?status=pending
app.get('/', async c => {
  const admin = c.get('user');
  const statusFilter = c.req.query('status');
  // Default sort: pending oldest first (FIFO), resolved newest first.
  let filter = `shop_code=eq.${encodeURIComponent(admin.shop_code)}`;
  if (statusFilter && (VALID_STATUS as readonly string[]).includes(statusFilter)) {
    filter += `&status=eq.${statusFilter}`;
    filter += statusFilter === 'pending'
      ? `&order=created_at.asc`
      : `&order=resolved_at.desc.nullslast,created_at.desc`;
  } else {
    // No filter — show pending first (oldest first), then resolved (newest first).
    filter += `&order=status.asc,created_at.desc`;
  }
  const rows = await select<DbReprint>(c.env, 'reprint_requests', filter);
  return c.json({ reprints: rows });
});

// PATCH /admin/reprints/:id  body { status, admin_note? }
app.patch('/:id', async c => {
  const admin = c.get('user');
  const id = c.req.param('id');

  let body: { status?: string; admin_note?: string };
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
    if (body.status !== 'pending') {
      patch.resolved_at = new Date().toISOString();
    } else {
      patch.resolved_at = null;
    }
  }
  if (body.admin_note !== undefined) {
    const n = (body.admin_note || '').trim();
    if (n.length > 2000) return c.json({ error: 'note_too_long' }, 400);
    patch.admin_note = n || null;
  }
  if (Object.keys(patch).length === 0) return c.json({ error: 'no_fields' }, 400);

  const updated = await update<DbReprint>(
    c.env,
    'reprint_requests',
    `id=eq.${encodeURIComponent(id)}&shop_code=eq.${encodeURIComponent(admin.shop_code)}`,
    patch,
  );
  if (!updated[0]) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true, reprint: updated[0] });
});

export default app;

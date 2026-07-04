// /admin/users/* — admin-only CRUD for client logins.
// Admin creates a client user row with: email, name, customer_id (the portal
// customer ID it maps to), class. The user can then receive OTPs and log in.

import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { requireAuth, requireAdmin } from '../lib/middleware';
import { select, insert, update, remove } from '../lib/db';
import type { DbUser } from '../lib/db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', requireAuth, requireAdmin);

const isValidEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 320;

// GET /admin/users  — list every user in admin's shop (clients + admins)
app.get('/', async c => {
  const admin = c.get('user');
  const rows = await select<DbUser>(
    c.env,
    'users',
    `shop_code=eq.${encodeURIComponent(admin.shop_code)}&order=created_at.desc`,
  );
  return c.json({ users: rows });
});

// POST /admin/users  — create a client user
app.post('/', async c => {
  const admin = c.get('user');
  let body: {
    email?: string;
    name?: string;
    customer_id?: string | null;
    class?: string | null;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const email = (body.email || '').trim().toLowerCase();
  const name = (body.name || '').trim();
  if (!isValidEmail(email)) return c.json({ error: 'invalid_email' }, 400);
  if (!name) return c.json({ error: 'name_required' }, 400);

  // Reject duplicate identifier globally
  const dup = await select<DbUser>(c.env, 'users', `identifier=eq.${encodeURIComponent(email)}`);
  if (dup.length) return c.json({ error: 'email_already_used' }, 409);

  try {
    const created = await insert<DbUser>(c.env, 'users', {
      identifier: email,
      identifier_type: 'email',
      name,
      role: 'client',
      shop_code: admin.shop_code,
      customer_id: body.customer_id || null,
      class: body.class || null,
      created_by_user_id: admin.id,
      active: true,
    });
    return c.json({ ok: true, user: created });
  } catch (e: any) {
    return c.json({ error: 'create_failed', detail: String(e?.message || e) }, 500);
  }
});

// PATCH /admin/users/:id  — update client user
app.patch('/:id', async c => {
  const admin = c.get('user');
  const id = c.req.param('id');
  let body: Partial<Pick<DbUser, 'name' | 'customer_id' | 'class' | 'active'>>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  // Verify it belongs to admin's shop
  const targets = await select<DbUser>(
    c.env,
    'users',
    `id=eq.${id}&shop_code=eq.${encodeURIComponent(admin.shop_code)}`,
  );
  if (!targets[0]) return c.json({ error: 'not_found' }, 404);
  if (targets[0].id === admin.id) {
    // Admin can't deactivate themselves through this endpoint
    if (body.active === false) return c.json({ error: 'self_deactivate_forbidden' }, 400);
  }
  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.customer_id !== undefined) patch.customer_id = body.customer_id;
  if (body.class !== undefined) patch.class = body.class;
  if (body.active !== undefined) patch.active = body.active;
  const updated = await update<DbUser>(c.env, 'users', `id=eq.${id}`, patch);
  return c.json({ ok: true, user: updated[0] });
});

// DELETE /admin/users/:id  — hard-delete a client user. Admin can't delete self.
app.delete('/:id', async c => {
  const admin = c.get('user');
  const id = c.req.param('id');
  if (id === admin.id) return c.json({ error: 'self_delete_forbidden' }, 400);
  const targets = await select<DbUser>(
    c.env,
    'users',
    `id=eq.${id}&shop_code=eq.${encodeURIComponent(admin.shop_code)}`,
  );
  if (!targets[0]) return c.json({ error: 'not_found' }, 404);
  if (targets[0].role === 'admin') return c.json({ error: 'cannot_delete_admin' }, 400);
  await remove(c.env, 'users', `id=eq.${id}`);
  return c.json({ ok: true });
});

export default app;

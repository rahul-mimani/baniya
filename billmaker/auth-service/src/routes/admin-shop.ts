// /admin/shop/* — admin-editable shop settings.
//
// These settings live on the `shops` table (not the Firestore replica) because
// they're metadata about how clients interact with this shop's auth flow, not
// business data. Specifically:
//   - admin_contact_email: shown to a client during login if their record has
//     no email. Lets the admin route them to a real support address.
//   - admin_contact_phone: same idea, optional.
//   - display_name: friendly name on the login page header.

import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { requireAuth, requireAdmin } from '../lib/middleware';
import { selectOne, update } from '../lib/db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', requireAuth, requireAdmin);

interface DbShop {
  code: string;
  name: string;
  admin_contact_email: string | null;
  admin_contact_phone: string | null;
  display_name: string | null;
  created_at: string;
}

// GET /admin/shop — fetch the shop record for the admin's own shop
app.get('/', async c => {
  const admin = c.get('user');
  const shop = await selectOne<DbShop>(
    c.env, 'shops', `code=eq.${encodeURIComponent(admin.shop_code)}`,
  );
  if (!shop) return c.json({ error: 'not_found' }, 404);
  return c.json({ shop });
});

// PATCH /admin/shop — update settings
app.patch('/', async c => {
  const admin = c.get('user');
  let body: Partial<Pick<DbShop, 'admin_contact_email' | 'admin_contact_phone' | 'display_name' | 'name'>>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const patch: Record<string, unknown> = {};
  if (body.admin_contact_email !== undefined) {
    const v = (body.admin_contact_email || '').trim();
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      return c.json({ error: 'invalid_email' }, 400);
    }
    patch.admin_contact_email = v || null;
  }
  if (body.admin_contact_phone !== undefined) {
    patch.admin_contact_phone = (body.admin_contact_phone || '').trim() || null;
  }
  if (body.display_name !== undefined) {
    patch.display_name = (body.display_name || '').trim() || null;
  }
  if (body.name !== undefined) {
    const v = (body.name || '').trim();
    if (!v) return c.json({ error: 'invalid_name' }, 400);
    patch.name = v;
  }
  if (Object.keys(patch).length === 0) return c.json({ error: 'no_fields' }, 400);

  const updated = await update<DbShop>(
    c.env, 'shops', `code=eq.${encodeURIComponent(admin.shop_code)}`, patch,
  );
  return c.json({ ok: true, shop: updated[0] });
});

export default app;

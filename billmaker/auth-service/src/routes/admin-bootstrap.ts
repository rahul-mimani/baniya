// POST /admin/bootstrap — one-time-use to create the first admin.
// Gated by the BOOTSTRAP_SECRET header. The endpoint refuses once any admin
// exists for the given shop, so even if the secret leaks later it's useless.

import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { select, insert, upsertShop } from '../lib/db';
import { constantTimeEqual } from '../lib/crypto';
import type { DbUser } from '../lib/db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/bootstrap', async c => {
  const provided = c.req.header('X-Bootstrap-Secret') || '';
  if (!provided || !constantTimeEqual(provided, c.env.BOOTSTRAP_SECRET)) {
    return c.json({ error: 'forbidden' }, 403);
  }

  let body: { email?: string; name?: string; shop_code?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const email = (body.email || '').trim().toLowerCase();
  const name = (body.name || '').trim();
  const shopCode = (body.shop_code || '').trim();
  if (!email || !name || !shopCode) {
    return c.json({ error: 'missing_fields' }, 400);
  }

  // Ensure the shop row exists.
  await upsertShop(c.env, shopCode, name);

  // Check: any admin already for this shop?
  const existing = await select<DbUser>(
    c.env,
    'users',
    `role=eq.admin&shop_code=eq.${encodeURIComponent(shopCode)}&select=id`,
  );
  if (existing.length > 0) {
    return c.json({ error: 'admin_already_exists' }, 409);
  }

  const created = await insert<DbUser>(c.env, 'users', {
    identifier: email,
    identifier_type: 'email',
    name,
    role: 'admin',
    shop_code: shopCode,
    customer_id: null,
    class: null,
    active: true,
  });

  return c.json({
    ok: true,
    admin: {
      id: created.id,
      email: created.identifier,
      name: created.name,
      shop_code: created.shop_code,
    },
  });
});

export default app;

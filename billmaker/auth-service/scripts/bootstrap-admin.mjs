#!/usr/bin/env node
// One-time CLI that creates the very first admin user.
// Reads ADMIN_EMAIL + BOOTSTRAP_SECRET + SHOP_CODE from .env, then POSTs
// /admin/bootstrap on the running auth-service Worker.
//
// Usage:
//   1. Start the worker in another terminal: `npm run dev`
//   2. In this terminal:                     `npm run bootstrap`
//   3. Check your email for the first OTP and finish login on the portal.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, '..', '.env');

if (!existsSync(envPath)) {
  console.error('✗ .env not found');
  process.exit(1);
}

const env = {};
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const required = ['BOOTSTRAP_SECRET', 'ADMIN_EMAIL', 'ADMIN_NAME', 'SHOP_CODE'];
const missing = required.filter(k => !env[k]);
if (missing.length) {
  console.error(`✗ Missing in .env: ${missing.join(', ')}`);
  process.exit(1);
}

const url = process.env.AUTH_URL || 'http://localhost:8787';
const endpoint = `${url}/admin/bootstrap`;

console.log(`→ POST ${endpoint}`);
console.log(`  email: ${env.ADMIN_EMAIL}`);
console.log(`  name:  ${env.ADMIN_NAME}`);
console.log(`  shop:  ${env.SHOP_CODE}`);

const r = await fetch(endpoint, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Bootstrap-Secret': env.BOOTSTRAP_SECRET,
  },
  body: JSON.stringify({
    email: env.ADMIN_EMAIL,
    name: env.ADMIN_NAME,
    shop_code: env.SHOP_CODE,
  }),
});

const body = await r.text();
let parsed;
try { parsed = JSON.parse(body); } catch { parsed = body; }

if (!r.ok) {
  console.error(`✗ HTTP ${r.status}:`, parsed);
  process.exit(1);
}
console.log('✓ Bootstrap complete:', parsed);
console.log('  You can now open the portal and log in with this email.');

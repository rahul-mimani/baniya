#!/usr/bin/env node
// Copies .env → .dev.vars so `wrangler dev` reads our secrets at local-dev time.
// wrangler doesn't auto-load .env — it looks for .dev.vars instead. We keep the
// developer-facing file as .env (canonical Node convention) and regenerate
// .dev.vars on every `npm run dev`.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, '..', '.env');
const devVarsPath = resolve(here, '..', '.dev.vars');

if (!existsSync(envPath)) {
  console.error(`✗ .env not found at ${envPath}`);
  console.error('  Fill in auth-service/.env with your secrets first.');
  process.exit(1);
}

const raw = readFileSync(envPath, 'utf8');

// Validate required keys are present (warn, don't fail — useful for partial setup)
const required = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'RESEND_API_KEY',
  'JWT_SECRET',
  'OTP_PEPPER',
  'BOOTSTRAP_SECRET',
  'ADMIN_EMAIL',
  'SHOP_CODE',
];
const lines = raw.split('\n');
const found = new Map();
for (const line of lines) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (m) found.set(m[1], m[2].trim());
}
const missing = required.filter(k => !found.get(k));
if (missing.length) {
  console.warn(`⚠ Missing values for: ${missing.join(', ')}`);
  console.warn('  wrangler dev will still start, but those features will fail.');
}

writeFileSync(devVarsPath, raw, { mode: 0o600 });
console.log(`✓ Synced .env → .dev.vars (${found.size} vars)`);

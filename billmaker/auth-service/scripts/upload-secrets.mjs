#!/usr/bin/env node
// Uploads every key from .env as a Cloudflare Worker secret via wrangler.
// Run AFTER `wrangler deploy` (the worker has to exist first).
//
// Usage: npm run deploy:secrets

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, '..', '.env');

if (!existsSync(envPath)) {
  console.error(`✗ .env not found at ${envPath}`);
  process.exit(1);
}

const SECRETS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  // Phase B: used by /mobile/realtime-token to mint scoped Supabase JWTs
  // and to return the project's anon key to mobile (for @supabase/supabase-js).
  'SUPABASE_JWT_SECRET',
  'SUPABASE_ANON_KEY',
  // NOTE: EMAIL_PROVIDER + the RATE_LIMIT_*/*_TTL_* tuning knobs are NOT here —
  // they live in wrangler.toml [vars] (non-secret defaults). Keeping the secret
  // set disjoint from [vars] by name prevents `wrangler deploy` from clobbering
  // secrets. Only tenant-specific + sensitive values are uploaded as secrets.
  'EMAIL_FROM',
  'EMAIL_FROM_NAME',
  'BREVO_API_KEY',
  'RESEND_API_KEY',
  'RESEND_FROM',
  'RESEND_FROM_NAME',
  'JWT_SECRET',
  'OTP_PEPPER',
  'BOOTSTRAP_SECRET',
  'ADMIN_EMAIL',
  'ADMIN_NAME',
  'SHOP_CODE',
  'SHOP_NAME',
  'ALLOWED_ORIGINS',
  'PORTAL_URL',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
  // Usage analytics — optional. Skipped if blank in .env.
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_ANALYTICS_TOKEN',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
];

const raw = readFileSync(envPath, 'utf8');
const found = new Map();
for (const line of raw.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (m) found.set(m[1], m[2].trim());
}

for (const key of SECRETS) {
  const value = found.get(key);
  if (!value) {
    console.warn(`⚠ Skipping ${key} (not set in .env)`);
    continue;
  }
  console.log(`→ Uploading ${key}…`);
  const r = spawnSync('npx', ['wrangler', 'secret', 'put', key], {
    input: value,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (r.status !== 0) {
    console.error(`✗ Failed uploading ${key}`);
    process.exit(r.status ?? 1);
  }
}
console.log('✓ All secrets uploaded');

# BillMaker Auth Service

Cloudflare Worker that gates access to the BillMaker web portal via email OTP. Phase 1 of the auth migration.

## Architecture quick-look

```
[client/admin browser]
        │
        │  fetch + Bearer JWT
        ▼
[Worker: billmaker-auth]  ←──── secrets in CF env (not in code) ────
    /auth/request-otp                                        │
    /auth/verify-otp                                         │
    /auth/me                                                 │
    /auth/logout                                             │
    /admin/users (admin only)                                ▼
    /admin/bootstrap (one-time)                       [Brevo/Resend]→ inbox
        │
        ▼
[Supabase Postgres]  ← only the Worker (service_role key) reaches it
    shops, users, otp_requests, sessions
```

## One-time setup (do these in order)

### 1. Fill `.env`
Open `auth-service/.env` and fill every empty value. The file already has comments showing where each comes from. Don't commit — `.gitignore` already excludes it.

### 2. Run the SQL migrations in Supabase
- Supabase dashboard → **SQL Editor** → New query
- Run **every** file in `sql/` in filename order (not just the first). The full
  ordered list is in [../SETUP.md](../SETUP.md#step-2--supabase-auth-db--read-replica).
- Click Run for each. You should see "Success" for each statement.
- Verify in **Table Editor** that you see: `shops`, `users`, `otp_requests`,
  `sessions`, `replica_documents`, `sync_state`, `quote_requests`,
  `reprint_requests`, `worker_events`, `alert_state`.

### 3. Install + start locally
```bash
cd auth-service
npm install
npm run dev
```
You should see something like:
```
✓ Synced .env → .dev.vars (17 vars)
⎔ Starting local server...
[wrangler:info] Ready on http://localhost:8787
```

### 4. Bootstrap your first admin
In a **second terminal**, with the dev server still running in the first:
```bash
cd auth-service
npm run bootstrap
```
Expected output:
```
→ POST http://localhost:8787/admin/bootstrap
  email: you@example.com
  name:  Admin
  shop:  your-shop-code
✓ Bootstrap complete: { ok: true, admin: { ... } }
```
After this point, `/admin/bootstrap` is locked — it will refuse new requests because an admin exists for your shop.

### 5. Smoke-test the OTP flow
Still in the second terminal:
```bash
curl -X POST http://localhost:8787/auth/request-otp \
  -H "Origin: http://localhost:5173" \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com"}'
```
Response should be:
```json
{"ok":true,"prefix":"XXX","ttl_minutes":10,"message":"If this email is registered..."}
```
Check your email — you should have an OTP. Then:
```bash
curl -X POST http://localhost:8787/auth/verify-otp \
  -H "Origin: http://localhost:5173" \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","otp":"XXX-YYYY"}'
```
Response should include a JWT token.

### 6. Deploy to Cloudflare (after local works)
```bash
npx wrangler login        # one-time browser auth
npm run deploy            # deploys the Worker to CF (free *.workers.dev URL)
npm run deploy:secrets    # uploads every .env var as a Worker secret
```
After deploy you'll get a URL like `https://billmaker-auth.<your-subdomain>.workers.dev` — that's what the portal will point at.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/request-otp` | none | Send OTP to email (rate-limited, registration-status-blind) |
| POST | `/auth/verify-otp` | none | Exchange OTP for a JWT |
| GET | `/auth/me` | Bearer | Current user info |
| POST | `/auth/logout` | Bearer | Revoke current session |
| GET | `/admin/users` | Admin | List users in admin's shop |
| POST | `/admin/users` | Admin | Create client user |
| PATCH | `/admin/users/:id` | Admin | Update client user (name/class/active) |
| DELETE | `/admin/users/:id` | Admin | Delete client user (not self, not admins) |
| POST | `/admin/bootstrap` | `X-Bootstrap-Secret` header | One-time first-admin creation |
| GET | `/healthz` | none | Liveness probe |

## Security properties

- All OTPs hashed with PBKDF2 (310k iterations + 16-byte random salt + Worker-only pepper). Even a full DB dump doesn't expose codes.
- `/auth/request-otp` is registration-status-blind: same response and timing for registered vs unregistered emails.
- Per-identifier (20/hr) + per-IP (30/hr) rate limits on OTP requests.
- Per-OTP max 5 verify attempts before invalidation.
- JWT (HS256, 30-min TTL) carries `jti`; every protected request validates against `sessions` table so revocation is instant.
- CORS allowlist (no `*`); only origins in `ALLOWED_ORIGINS` accepted.
- Strict response headers (HSTS, X-Frame-Options DENY, no-store cache).
- Logger redacts JWTs, OTPs, secret keys, bearer tokens before anything reaches CF logs.
- `BOOTSTRAP_SECRET` becomes useless once first admin exists for a shop.

## Resetting if you mess up locally

```bash
# Drop and recreate just the auth tables (data lost!)
# Run in Supabase SQL Editor:
drop view if exists v_pending_otp;
drop table if exists sessions cascade;
drop table if exists otp_requests cascade;
drop table if exists users cascade;
drop table if exists shops cascade;
-- then re-run sql/001_initial_schema.sql
```

Then re-run the bootstrap step.

## What's NOT in Phase 1

- Portal login UI integration (next turn)
- Reading bills/products through the auth service (Phase 2)
- Phone OTP via SMS (Phase 3)
- Refresh tokens / silent re-auth (Phase 1.5 if needed)

# BillMaker — Production Deployment (Vercel + Cloudflare)

This guide takes a working local setup (see [SETUP.md](./SETUP.md) — Firebase,
Supabase, Brevo done) and deploys the two hosted pieces to production:

- **auth-service** → **Cloudflare Workers** (the API + cron sync)
- **web-portal** → **Vercel** (the admin + client web app)

Then it wires them together (env + CORS) and, optionally, puts both behind your
own domain.

```
                 https://portal.yourshop.com          https://auth.yourshop.com
                 (or *.vercel.app)                     (or *.workers.dev)
   ┌──────────┐   VITE_AUTH_SERVICE_URL   ┌───────────────────┐   ┌───────────┐
   │  Browser │ ───────────────────────▶ │  Vercel (portal)  │   │ Cloudflare│
   │ / mobile │                          │   static SPA      │──▶│  Worker   │──▶ Supabase
   └──────────┘                          └───────────────────┘   │ (auth-svc)│──▶ Firestore
                     the SPA calls the Worker directly ─────────▶ └───────────┘
```

The portal (Vercel) calls the Worker (Cloudflare) from the browser, so the two
must agree on **two settings**: the portal's `VITE_AUTH_SERVICE_URL` (points at
the Worker) and the Worker's `ALLOWED_ORIGINS` (must include the portal's URL).
Get those right and everything connects.

---

## Prerequisites

- [SETUP.md](./SETUP.md) steps 1–5 done (Firebase project + rules, Supabase
  migrations, `auth-service/.env` filled, Brevo key, first admin bootstrapped).
- This repo pushed to **GitHub**.
- Free **Cloudflare** and **Vercel** accounts.

---

## Part A — Deploy auth-service to Cloudflare Workers

From `billmaker/auth-service/`:

```bash
npm install
npx wrangler login          # one-time browser auth
npm run deploy              # deploys the Worker → https://billmaker-auth.<sub>.workers.dev
npm run deploy:secrets      # uploads tenant/secret values from .env as CF secrets
```

Run them in that order (the Worker must exist before secrets attach).

✓ **Verify:**
```bash
curl https://billmaker-auth.<sub>.workers.dev/healthz     # → 200
```

**Note the Worker URL** — it's your `VITE_AUTH_SERVICE_URL` for Part B. (If you
add a custom domain in Part D, use that instead.)

> Free-tier: Cron Triggers + the Rate-Limiting bindings work on the free plan
> (5 cron triggers/account). Re-running `npm run deploy` for code changes does
> **not** wipe secrets, so you don't need `deploy:secrets` every time — only when
> a secret value changes.

---

## Part B — Deploy web-portal to Vercel

The portal is a static Vite SPA. Deploy it straight from GitHub:

1. **Vercel → Add New → Project → Import** your GitHub repo.
2. **Root Directory:** click *Edit* and set it to **`billmaker/web-portal`**.
   (Critical — the repo root is not the app.)
3. **Framework Preset:** Vite (auto-detected). Leave the defaults:
   - Build Command: `npm run build`
   - Output Directory: `dist`
   - Install Command: `npm install`
4. **Environment Variables** → add:
   | Name | Value |
   |---|---|
   | `VITE_AUTH_SERVICE_URL` | your Worker URL from Part A (e.g. `https://billmaker-auth.<sub>.workers.dev`) |
   > Vite inlines `VITE_*` vars at **build** time — if you change this later, you
   > must **redeploy** for it to take effect.
5. **Deploy.** You'll get a `https://<project>.vercel.app` URL.

The included `web-portal/vercel.json` already handles SPA routing (all paths →
`index.html`), so deep links and refreshes work.

✓ **Verify:** open the `*.vercel.app` URL — you should see the login screen.

---

## Part C — Connect Vercel ⇄ Cloudflare (CORS + cross-refs)

The Worker rejects browser requests from origins not in its allow-list, so now
tell it about the Vercel URL:

1. Edit `auth-service/.env` and set `ALLOWED_ORIGINS` to include your portal
   origin(s) (comma-separated, keep the localhost entries for local dev):
   ```
   ALLOWED_ORIGINS=https://<project>.vercel.app,https://portal.yourshop.com,http://localhost:3000,http://localhost:5173,http://localhost,capacitor://localhost,https://localhost
   ```
2. Also set `PORTAL_URL=https://<project>.vercel.app` (used in alert-email links).
3. Re-upload the changed secrets and (optionally) redeploy:
   ```bash
   cd auth-service
   npm run deploy:secrets      # pushes the new ALLOWED_ORIGINS / PORTAL_URL
   ```
4. **First login:** open the portal → **Email** mode → your `ADMIN_EMAIL` → OTP.
   Then **Settings** → enter your Firebase config (`apiKey`/`projectId`/`appId`)
   + `SHOP_CODE` so the admin console can read Firestore.

✓ **Verify:** logging in returns a token (no CORS error in the browser console).
If you see a CORS error, `ALLOWED_ORIGINS` doesn't exactly match the portal
origin — check the scheme/host, redeploy secrets.

---

## Part D — Custom domains (optional but recommended)

Nicer URLs and stable endpoints. Easiest if your domain's DNS is on **Cloudflare**.

### D.1 Worker → `auth.yourshop.com`
- Cloudflare dashboard → **Workers & Pages → billmaker-auth → Settings →
  Domains & Routes → Add → Custom Domain** → `auth.yourshop.com`.
- Cloudflare creates the DNS + certificate automatically.
- Update the portal's `VITE_AUTH_SERVICE_URL` (Vercel env) to
  `https://auth.yourshop.com` and **redeploy** the portal.

### D.2 Portal → `portal.yourshop.com`
- Vercel → your project → **Settings → Domains → Add** → `portal.yourshop.com`.
- Add the DNS record Vercel shows (a `CNAME` to `cname.vercel-dns.com`) in your
  DNS provider. If DNS is on Cloudflare, add the CNAME and set it to
  **DNS-only (grey cloud)** to avoid proxy/edge conflicts.
- Add `https://portal.yourshop.com` to the Worker's `ALLOWED_ORIGINS`
  (Part C) and re-run `npm run deploy:secrets`.

### D.3 Update everything to the custom domains
- Vercel env `VITE_AUTH_SERVICE_URL` → `https://auth.yourshop.com` (redeploy).
- Worker `ALLOWED_ORIGINS` + `PORTAL_URL` → include `https://portal.yourshop.com`.
- Mobile app `.env.production` → `VITE_AUTH_SERVICE_URL=https://auth.yourshop.com`
  (rebuild the APK).

---

## Part E — Redeploys & updates

| Change | What to run |
|---|---|
| Portal code (`web-portal/`) | Push to GitHub — **Vercel auto-deploys**. |
| Portal env var | Update in Vercel → **Redeploy** (Vite inlines at build). |
| Worker code (`auth-service/src/`) | `cd auth-service && npm run deploy` |
| Worker secret value | Edit `.env` → `npm run deploy:secrets` |
| Worker non-secret default (rate limits, TTLs) | Edit `wrangler.toml [vars]` → `npm run deploy` |
| Mobile app | `npm run apk` (with `VITE_AUTH_SERVICE_URL` set) and distribute the APK |

Onboarding another shop is code-free — see the `[env.shop2]` template in
`auth-service/wrangler.toml` and [SETUP.md](./SETUP.md#3-auth-service-cloudflare-worker).

---

## (Optional) Serve the mobile app as a web app on Vercel

The mobile app (repo root) is a Capacitor/Vite app; its web build can also be
hosted as a PWA:

- Vercel → new project from the same repo, **Root Directory = `billmaker`**,
  Framework Vite, Build `npm run build`, Output `dist`.
- Env `VITE_AUTH_SERVICE_URL` = your Worker URL.

Note it relies on the in-app Firebase config + shop code entered in Settings,
same as the APK. Most deployments only host the **portal** on the web and ship
the app as an APK.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| CORS error in portal console | Worker `ALLOWED_ORIGINS` must contain the exact portal origin (scheme + host, no trailing slash). Edit `.env`, `npm run deploy:secrets`. |
| Portal calls `localhost:8787` in prod | `VITE_AUTH_SERVICE_URL` wasn't set in Vercel **or** you didn't redeploy after setting it (Vite inlines at build). |
| Vercel builds the wrong thing / 404 | Root Directory must be `billmaker/web-portal` (portal) or `billmaker` (app). |
| Worker 500s / replica empty | Check `npx wrangler tail`; verify Firebase + Supabase secrets uploaded (`npm run deploy:secrets`). |
| Custom domain won't verify | Confirm the DNS record matches exactly; on Cloudflare set the portal CNAME to DNS-only (grey cloud). |
| OTP emails not arriving | `BREVO_API_KEY` set as a secret + `EMAIL_FROM` is a verified Brevo sender. |

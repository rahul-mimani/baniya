# BillMaker

An open-source, **offline-first billing & invoicing system** for small shops, with
optional cloud sync, a multi-device admin web portal, and a customer-facing
portal. Built to run on cheap/free tiers (Firebase, Supabase, Cloudflare, Vercel).

> **Bring your own backend.** Nothing is hardcoded to a specific business. You
> point the apps at your own Firebase project and enter your shop details in
> Settings. See **[SETUP.md](./SETUP.md)** for the full self-hosting guide.

---

## What's in the box

BillMaker is a monorepo of four independently deployable pieces plus tooling:

| Directory | What it is | Runs on |
|---|---|---|
| `/` (root) | **Mobile app** — Capacitor + React + Vite. The billing app shopkeepers use. Offline-first: local JSON files on-device are the source of truth. | Android (APK) / web |
| `auth-service/` | **Cloudflare Worker** (Hono + jose). Email/phone OTP auth, JWT sessions, and the cron that mirrors Firestore → Supabase. | Cloudflare Workers |
| `web-portal/` | **Admin + client web portal** — React + Vite. Admins manage catalog/customers/bills; customers view their bills & deals. | Vercel (or any static host) |
| `tools/product-enrich/` | Optional local tool to enrich product catalog with descriptions/images. | Local Node |
| `billmaker-migration/` | Optional Firebase project→project clone / shop-delete scripts (needs admin service-account keys; gitignored). | Local Node |

## How it fits together

```
        ┌──────────────┐   writes (anon auth)    ┌───────────────┐
        │  Mobile app  │────────────────────────▶│   Firebase    │  ← system of record
        │ (Capacitor)  │◀──────────┐             │   Firestore   │     shops/<code>/...
        └──────────────┘           │             └───────┬───────┘
              ▲ reads via          │ Supabase Realtime           │ cron mirror (every 2/5 min)
              │ Supabase Realtime  │ (RLS by shop_code)          ▼
              │                    └──────────────────────┐  ┌───────────────┐
        ┌──────────────┐  admin → Firestore directly      └──│   Supabase    │
        │  Web portal  │──────────────────────────────────▶  │  (auth DB +   │
        │ (admin+client)  client → /client/* API              │  read replica)│
        └──────┬───────┘                                      └───────▲───────┘
               │  auth + admin ops                                    │ service_role
               └──────────────────────▶ ┌──────────────────┐──────────┘
                                        │   auth-service    │
                                        │ (Cloudflare Worker)│  OTP · JWT · cron sync
                                        └──────────────────┘
```

- **Firebase Firestore** is the system of record for business data (bills,
  customers, products), scoped under `shops/<SHOP_CODE>/...` and locked down by
  `firestore.rules`. Clients use **anonymous auth**; the config is entered per
  device/browser (never bundled), so you bring your own Firebase project.
- **Supabase** stores auth (shops/users/OTP/sessions), a queryable read-replica
  of Firestore, feature tables (quotes/reprints), and telemetry.
- **The Cloudflare Worker** is the only thing holding real secrets. It issues
  OTP/JWT sessions and runs the cron that mirrors Firestore → Supabase.
- The mobile app **reads** via Supabase Realtime and **writes** to Firestore
  (local-first: write the on-device JSON, then push).

## Quick start

Full step-by-step (accounts, credentials, SQL, deploy) is in
**[SETUP.md](./SETUP.md)**. In short:

1. Create a **Firebase** project (Firestore) and deploy `firestore.rules`.
2. Create a **Supabase** project and run the SQL migrations in `auth-service/sql/`.
3. Deploy the **auth-service** Worker (`cd auth-service && npm run deploy`), then
   upload secrets and bootstrap your first admin.
4. Deploy the **web-portal** (Vercel) pointing `VITE_AUTH_SERVICE_URL` at your Worker.
5. Build the **mobile app** (`npm run apk`) and enter your Firebase config + shop
   code in Settings.

For **production hosting** (portal → Vercel, worker → Cloudflare, custom domains),
see [billmaker/DEPLOYMENT.md](./billmaker/DEPLOYMENT.md). For **free-tier capacity**
(how many mobile users / admins / clients, and who it's for), see
[billmaker/docs/scale.html](./billmaker/docs/scale.html).

## Configuration model

There are no secrets in source. Each service reads its own config:

| Service | Config file (copy the `.example`) | Notes |
|---|---|---|
| Mobile app | `.env.example` → `.env.local` / `.env.production` | Only `VITE_AUTH_SERVICE_URL`. Firebase config is entered in-app in Settings. |
| auth-service | `auth-service/.env.example` → `auth-service/.env` | All real secrets. Uploaded to Cloudflare via `npm run deploy:secrets`. |
| web-portal | `web-portal/.env.example` → `web-portal/.env.local` | Only `VITE_AUTH_SERVICE_URL`. Firebase config is entered in portal Settings. |
| product-enrich | `tools/product-enrich/.env.example` → `.env` | Tavily key + shop code. |
| Firebase CLI | `.firebaserc.example` → `.firebaserc` | Your Firebase project id. |

`SHOP_NAME` (worker config) sets the display name shown in OTP emails and admin
alerts. The shop name on bills/statements comes from the business info you enter
in the app. See [SETUP.md](./SETUP.md).

## Development

Each package has its own `package.json`. Common commands:

```bash
# Mobile app (root)
npm install && npm run dev          # Vite dev server
npm run apk                         # build a debug Android APK

# auth-service
cd auth-service && npm install && npm run dev   # wrangler dev on :8787

# web-portal
cd web-portal && npm install && npm run dev
```

## License

[MIT](./LICENSE) — free to use, modify, and distribute.

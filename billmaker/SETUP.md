# Baniya — Self-Hosting Setup Guide

A complete, step-by-step guide to running your own Baniya instance from a fresh
clone. Follow it top to bottom. Nothing here is specific to any business — every
value you enter is your own.

**Time:** ~45–90 min the first time. **Cost:** $0 on the free tiers below.

---

## Table of contents

- [0. Before you start (accounts + tools)](#0-before-you-start)
- [1. Firebase (Firestore)](#1-firebase-firestore)
- [2. Supabase (auth DB + read-replica)](#2-supabase)
- [3. auth-service (Cloudflare Worker)](#3-auth-service-cloudflare-worker)
- [4. Brevo (email / OTP)](#4-brevo-email--otp)
- [5. Cloudinary (optional — product images)](#5-cloudinary-optional)
- [6. Web portal](#6-web-portal)
- [7. Mobile app](#7-mobile-app)
- [8. Product-enrich tool (optional)](#8-product-enrich-optional)
- [9. End-to-end smoke test](#9-end-to-end-smoke-test)
- [Security checklist](#security-checklist)
- [Troubleshooting](#troubleshooting)

---

## 0. Before you start

### 0.1 Create these free accounts
| Service | Sign-up | Used for |
|---|---|---|
| Firebase (Google) | <https://console.firebase.google.com> | Firestore — system of record |
| Supabase | <https://supabase.com/dashboard> | Auth DB + Firestore read-replica |
| Cloudflare | <https://dash.cloudflare.com/sign-up> | The auth-service Worker |
| Brevo | <https://www.brevo.com> | Sends OTP + statement emails |
| Cloudinary *(optional)* | <https://cloudinary.com/users/register_free> | Product image hosting |
| Vercel *(optional)* | <https://vercel.com/signup> | Hosting the web portal |

### 0.2 Install these tools
```bash
node --version      # v18+ (v20+ recommended)
npm --version
git --version
npm i -g firebase-tools     # Firebase CLI (for deploying rules)
# wrangler is installed per-project via npm — no global install needed
```
For building the Android app you'll also need **Android Studio** (or the Android
SDK) and a **JDK 17–21**. Not needed until [Step 7](#7-mobile-app).

### 0.3 Clone and install
```bash
git clone <your-fork-url> billmaker
cd billmaker
npm install
```

### 0.4 Decide two values up front (you'll reuse them everywhere)
- **`SHOP_CODE`** — a stable, hard-to-guess slug for your shop, e.g.
  `myshop-4f9c2a1b`. All your data lives under `shops/<SHOP_CODE>/…`.
- **`SHOP_NAME`** — a human-readable display name, e.g. `My Shop`. Used in OTP
  emails and alerts. (The name printed on bills comes from Business Info you
  enter in the app later — see [Step 7](#7-mobile-app).)

### 0.5 Config-file map (each is `cp <file>.example <file>` then fill in)
| File | Belongs to | Holds |
|---|---|---|
| `auth-service/.env` | Worker | **All real secrets** |
| `.firebaserc` | Firebase CLI | Your Firebase project id |
| `.env.production` / `.env.local` (root) | Mobile app | `VITE_AUTH_SERVICE_URL` only |
| `web-portal/.env.local` | Web portal | `VITE_AUTH_SERVICE_URL` only |
| `tools/product-enrich/.env` | Enrich tool | Shop code + Tavily key |
| `android/local.properties` | Android build | SDK path (machine-specific) |

> Every `*.example` file is committed; the filled-in real file is gitignored.

---

## 1. Firebase (Firestore)

**1.1 Create the project.** <https://console.firebase.google.com> → **Add
project** → name it anything → note the **Project ID** (e.g. `myshop-1a2b3`).

**1.2 Create the database.** Left nav → **Build → Firestore Database → Create
database** → choose a region near your users (reference used `asia-east2`) →
start in **production mode**.

**1.3 Register a Web app.** ⚙️ **Project settings → General → Your apps → </>
(Web)** → register. Copy the shown `firebaseConfig` — you need **`apiKey`,
`projectId`, `appId`**. (You'll type these into the app + portal Settings later;
the web `apiKey` is *not* a secret — access is gated by security rules + shop code.)

**1.4 Deploy the security rules and indexes.**
```bash
cp .firebaserc.example .firebaserc     # then edit it — see below
firebase login
firebase deploy --only firestore:rules,firestore:indexes
```
`.firebaserc` holds **only your Project ID** as JSON — nothing else. Edit it to:
```json
{ "projects": { "default": "your-firebase-project-id" } }
```
> ⚠️ **Do NOT paste the Firebase "web config" here.** The `apiKey` / `authDomain` /
> `appId` snippet the Console shows you is a *different thing* — it is **not a
> file**. You'll type those values into the **app's Settings screen** later
> ([Step 6.2](#6-web-portal) and [Step 7.2](#7-mobile-app)). `.firebaserc` is used
> only by the `firebase` CLI to know which project to deploy the rules to.

✓ **Verify:** Firebase Console → Firestore → **Rules** tab shows your deployed
security rules. `firestore.indexes.json` is intentionally empty (no composite indexes).

**1.5 Create a service account** (the Worker uses it to read Firestore).
⚙️ **Project settings → Service accounts → Generate new private key** → downloads
a JSON. Keep it safe; **never commit it.** You'll copy three fields from it into
`auth-service/.env` in [Step 3](#3-auth-service-cloudflare-worker):
`project_id`, `client_email`, `private_key`.

---

## 2. Supabase

**2.1 Create the project.** <https://supabase.com/dashboard> → **New project**.
Set a strong DB password. Note the **project ref** (the `<ref>` in
`https://<ref>.supabase.co`).

**2.2 Run the database migrations.** **SQL Editor → New query.** Open each file
in `auth-service/sql/` and run them **one at a time, in this exact order:**
```
 1. 001_initial_schema.sql               (shops, users, otp_requests, sessions)
 2. 002_replica_schema.sql               (replica_documents, sync_state)
 3. 003_case_insensitive_match.sql
 4. 004_shop_settings.sql
 5. 005_quote_requests.sql
 6. 006_reprint_requests.sql
 7. 007_admin_aggregates_fn.sql
 8. 2026-05-22_admin_aggregates_fn_v2.sql
 9. 2026-05-22_cleanup_after_deploy_5.sql
10. 2026-05-22_reset_bills_cursor.sql
11. 2026-05-22_worker_events.sql
12. 2026-05-23_admin_aggregates_full.sql
13. 2026-05-23_realtime_for_mobile.sql   (enables Realtime + RLS)
14. 2026-05-24_alert_state.sql
```
The later `admin_aggregates` files replace earlier versions of the same function
(`CREATE OR REPLACE`) — running all of them in order is correct.

✓ **Verify (Table Editor):** you should see `shops`, `users`, `otp_requests`,
`sessions`, `replica_documents`, `sync_state`, `quote_requests`,
`reprint_requests`, `worker_events`, `alert_state`.

**2.3 Confirm Realtime + RLS.** File #13 adds `replica_documents` to the
`supabase_realtime` publication and turns on row-level security so each mobile
device only sees its own shop's rows. **Database → Publications →
`supabase_realtime`** should list `replica_documents`.

**2.4 Collect your keys** (**Project Settings → API**):
| .env key | Where |
|---|---|
| `SUPABASE_URL` | "Project URL" |
| `SUPABASE_SERVICE_KEY` | **service_role** key (secret) |
| `SUPABASE_ANON_KEY` | **anon public** key |
| `SUPABASE_JWT_SECRET` | Settings → API → **JWT Secret** |

---

## 3. auth-service (Cloudflare Worker)

**3.1 Create the config file.**
```bash
cd auth-service
cp .env.example .env
```

**3.2 Generate the three app secrets.**
```bash
openssl rand -hex 32     # run 3 times → JWT_SECRET, OTP_PEPPER, BOOTSTRAP_SECRET
```

**3.3 Fill in `auth-service/.env`.** Every field has an inline note. In summary:
- Supabase keys → from [Step 2.4](#2-supabase)
- `BREVO_API_KEY`, `EMAIL_FROM`, `EMAIL_FROM_NAME` → from [Step 4](#4-brevo-email--otp)
- `FIREBASE_PROJECT_ID` / `_CLIENT_EMAIL` / `_PRIVATE_KEY` → from the JSON in
  [Step 1.5]. For `FIREBASE_PRIVATE_KEY`, paste the whole key on one line, **keep
  the `\n` escapes**, wrapped in double quotes.
- `SHOP_CODE`, `SHOP_NAME`, `ADMIN_EMAIL`, `ADMIN_NAME` → your values from
  [Step 0.4]
- `ALLOWED_ORIGINS` → add your portal URL (keep the localhost entries for dev)
- `PORTAL_URL` → your portal URL (optional; used in alert emails)

> You do **not** edit `wrangler.toml` — it holds only non-secret defaults (rate
> limits, TTLs, `WORKER_PROFILE`). Secrets and `[vars]` are disjoint by name, so
> deploys never clobber your secrets.

**3.4 Run locally.**
```bash
npm install
npm run dev        # syncs .env → .dev.vars, starts wrangler on http://localhost:8787
```
✓ **Verify:** you see `Ready on http://localhost:8787`. In another terminal:
```bash
curl http://localhost:8787/healthz     # → {"ok":true} (or similar 200)
```

**3.5 Bootstrap your first admin** (second terminal, dev server still running):
```bash
cd auth-service
npm run bootstrap
```
✓ **Verify:** prints `✓ Bootstrap complete`. After this, `/admin/bootstrap`
self-locks for your shop.

**3.6 Deploy to Cloudflare.**
```bash
npx wrangler login      # one-time browser auth
npm run deploy          # deploys the Worker → free https://billmaker-auth.<sub>.workers.dev
npm run deploy:secrets  # uploads tenant/secret values from .env as CF secrets
```
Run these **in order** (the Worker must exist before secrets attach). Re-running
`npm run deploy` later for code changes will **not** wipe secrets.

✓ **Verify:** `curl https://billmaker-auth.<sub>.workers.dev/healthz` returns 200.
**Copy this URL — it's your `VITE_AUTH_SERVICE_URL`** for the app and portal.

**3.7 Free-tier note.** Cron Triggers + the Rate-Limiting bindings used here work
on the free plan (5 cron triggers/account cap). The primary worker uses 3 crons;
extra shops use `WORKER_PROFILE=secondary` (1 cron) via an `[env.<name>]` block.

---

## 4. Brevo (email / OTP)

**4.1** Sign up → **SMTP & API → API Keys → Create a new API key** →
`BREVO_API_KEY` in `auth-service/.env`.

**4.2** **Senders & IP → Senders** → add and **verify** your from-address (Brevo
allows a verified single sender without owning a domain). Set `EMAIL_FROM` /
`EMAIL_FROM_NAME` to match.

**4.3** Keep `EMAIL_PROVIDER=brevo` (default). *(Resend is also supported — set
the `RESEND_*` vars and flip the provider.)*

---

## 5. Cloudinary (optional)

Only needed for product images in the portal.

**5.1** Sign up → **Console → Account Details** → copy **cloud name** (public),
API key, API secret → set `CLOUDINARY_*` in `auth-service/.env`.

**5.2** **Settings → Upload → Upload presets → Add** an **unsigned** preset. In
the portal → Settings you'll enter the cloud name + preset name (stored in your
browser only).

---

## 6. Web portal

```bash
cd web-portal
cp .env.example .env.local        # set VITE_AUTH_SERVICE_URL to your Worker URL (Step 3.6)
npm install
npm run dev                       # local dev, OR:
npm run build                     # → dist/ for static hosting
```
**Deploy:** push `dist/` to **Vercel** (the included `vercel.json` handles SPA
routing) or any static host. Set `VITE_AUTH_SERVICE_URL` in the host's env for
production builds.

**6.1 First admin login.** Open the portal → **Email** mode → enter your
`ADMIN_EMAIL` → complete the OTP from your inbox.

**6.2 Connect the portal to Firestore.** Portal → **Settings** → enter your
Firebase config (`apiKey` / `projectId` / `appId` from [Step 1.3]) + your
`SHOP_CODE`. The admin console reads Firestore directly, so this is required for
bills/customers/products to appear.

---

## 7. Mobile app

**Prerequisites:** Android SDK + a **JDK 17–21** (newer JDKs can fail the Android
Gradle Plugin). For the SDK, either open the `android/` folder in Android Studio
once (it auto-creates `android/local.properties`), or:
```bash
cp android/local.properties.example android/local.properties   # then set sdk.dir
# or instead: export ANDROID_HOME=/path/to/Android/sdk
```
If your default JDK is incompatible, `export JAVA_HOME=/path/to/jdk-21` (see the
note in `android/gradle.properties`).

**7.1 Build the APK.**
```bash
cp .env.example .env.production   # set VITE_AUTH_SERVICE_URL to your Worker URL
npm install
npm run apk                       # builds a debug APK at the repo root
```
✓ **Verify:** a `billmaker-v*.apk` appears at the repo root.

**7.2 Install & configure.** Sideload the APK on an Android device. On first run,
open **Settings** and set:
- **Firebase config** — `apiKey` / `projectId` / `appId` (from [Step 1.3])
- **Shop code** — your `SHOP_CODE` (devices sharing this code sync together)
- **Business info** — name / phone / address / GST. **This is what prints on
  bills and statements** (in both the app and the portal).

The app works fully offline; once Firebase config + shop code are set, it syncs.

---

## 8. Product-enrich (optional)

A local tool to add descriptions/images to your product catalog.
```bash
cd tools/product-enrich
cp .env.example .env              # set SHOP_CODE + TAVILY_API_KEY (app.tavily.com)
# place a Firebase service-account JSON at ./prod.json (from Step 1.5)
npm install && npm start          # opens a local UI at http://localhost:3000
```
Optionally set `SEARCH_INCLUDE_DOMAINS` in `.env` to bias search toward specific
sites (comma-separated; empty = general web search).

---

## 9. End-to-end smoke test

Run these after Steps 1–7 to confirm the whole loop works:

1. **Mobile → Firestore:** create a bill in the app, tap sync. In Firebase
   Console → Firestore, confirm a doc appears under `shops/<SHOP_CODE>/bills/`.
2. **Firestore → Supabase (cron):** wait ~2 min, then in Supabase → Table Editor →
   `replica_documents`, confirm the bill row appears (collection `bills`).
3. **Portal admin:** log into the portal → the bill shows in **Bills**; the
   customer appears under **Customers**.
4. **Client portal:** create a client login (portal → **Client logins**), log in
   as that customer in a separate browser, confirm they see their bill.
5. **OTP email:** each login above should have delivered an OTP email via Brevo.

If all five pass, your instance is fully wired.

---

## Security checklist

- [ ] `firestore.rules` deployed ([Step 1.4]); confirm `/shops` can't be listed.
- [ ] `auth-service/.env`, `*-firebase-sa.json`, `prod.json`, `.dev.vars*` are
      gitignored (they are by default) — never commit them.
- [ ] `SHOP_CODE` is hard to guess.
- [ ] `ALLOWED_ORIGINS` on the Worker lists only your real portal origin(s).
- [ ] `SUPABASE_SERVICE_KEY` and the Firebase private key live only in
      `auth-service/.env` / Cloudflare secrets — nowhere in git.
- [ ] If you cloned this from another instance, **rotate every credential**.

## Troubleshooting

| Symptom | Fix |
|---|---|
| App won't sync | Confirm Firebase config + shop code in Settings and that `firestore.rules` is deployed. Check the in-app **Diagnostics** log. |
| No OTP email | Verify `BREVO_API_KEY` and that `EMAIL_FROM` is a **verified** Brevo sender. Worker logs: `cd auth-service && npx wrangler tail`. |
| Portal admin sees no data | The admin console reads Firestore directly — re-check the Firebase config + shop code entered in portal **Settings**. |
| Mobile not updating live | Confirm [Step 2.3] (replica in `supabase_realtime` publication + RLS enabled). |
| Replica stays empty | Check the Worker cron is running: `npx wrangler tail` during a `*/2` tick; verify `FIREBASE_*` creds in `.env`/secrets. |
| APK build fails on JDK | Use a JDK 17–21 (`JAVA_HOME`), see `android/gradle.properties`. |
| `wrangler deploy` errors on bindings | Ensure you ran `npx wrangler login` and your account has Workers enabled (free is fine). |

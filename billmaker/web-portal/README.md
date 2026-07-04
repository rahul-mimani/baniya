# Bill Manager — Portal (Prototype)

A web portal for clients to view their bills, deals, and product pricing — and for the shop owner to manage everything.
**This is a dummy-data prototype.** Auth and real Firestore wiring come later, once the UI is settled.

## Run locally

```bash
cd web-portal
npm install
npm run dev
```

Open http://localhost:5173 and any email/password works.

## What's in here

- **Login** — visual only; any submit lands on the dashboard.
- **Sidebar nav with view switcher** — top of the sidebar has Admin / Client toggle (prototype only). Switch instantly between perspectives without re-login.
- **Logged-in-as customer picker** — in Client view, a dropdown lets you "impersonate" each demo customer (Class A / B / C) to see how their portal differs.

### Admin perspective
- **Overview** — KPIs + recent bills
- **Bills** — every bill with an **Acknowledge / Release** toggle. Bills are NOT visible to clients until released.
- **Customers** — table with class chip (drop-down to change class)
- **Products** — catalog with class-A / B / C pricing
- **Deals** — promotions with per-class visibility chips

### Client perspective
- **Home** — personalized greeting + summary stats + recent activity
- **My Bills** — only acknowledged bills appear here. Expandable to show items.
- **Deals & Products** — products with prices for THE CLIENT'S CLASS, plus active deals targeted at that class.

## What's intentionally missing (next round)

- Real authentication (Firebase email/password)
- Real Firestore reads/writes (uses the shared `shops/{shopCode}/` data model)
- CRUD modals for Add/Edit Customer / Product / Deal
- Notifications when a bill is released
- PDF download
- Mobile-responsive sidebar (currently desktop-first)

## Architecture (when wired to Firebase)

```
BillMaker mobile (existing Android APK)
    │  pushes bills to Firestore
    ▼
Firestore: shops/{shopCode}/
    ├── bills/        ← BillMaker writes; Admin toggles `acknowledged`
    ├── customers/    ← Web admin adds; each has class + login UID
    ├── products/     ← Web admin manages catalog with class prices
    ├── deals/        ← Web admin creates; tags `visibleClasses`
    └── users/        ← Auth UID → role + customerId mapping
    ▲
    │  reads filtered data
    │
Web portal (this app, once auth is wired)
    ├── /admin/* (anonymous-auth users or explicit admins)
    └── /client/* (email/password users, scoped to their bills)
```

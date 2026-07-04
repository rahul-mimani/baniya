# Firestore Schema — Canonical Reference

**Status:** FROZEN as of 2026-05-22. Any deviation must be (a) documented here,
(b) backwards-compatible, and (c) covered by an entry in the normalization
migration. The audit tool in Settings → Maintenance enforces this in
production.

Three writers across the system:

| Writer | Writes to | Must respect this schema? |
|---|---|---|
| BillMaker mobile (Capacitor app) | `bills`, `payments`, `customers`, `products`, `_meta/business` | YES |
| Web-portal (admin dashboard) | `portal_*`, `bills` (merge), `customers` (merge), `products` (merge) | YES |
| Auth-service worker (Cloudflare) | `_meta/admin_aggregates`, `portal_customers.outstanding` (merge) | YES |

All collections live under `shops/<shopCode>/<collection>`. Below, the
collection name is the leaf.

---

## `bills/<billId>` — canonical bill document

Created by mobile when the user records a bill. Portal merges ack/lineage
fields onto it. Mobile is authoritative for the products list, customer
name, totals, payments references.

```jsonc
{
  // === IDENTITY === (mobile-authored, immutable after create)
  "id": "1763881190014",                    // string, matches doc id
  "billNumber": "LE-0000003",               // string, human-readable

  // === TIMESTAMPS === (ISO strings, except lastModified)
  "createdAt":    "2025-11-23T06:59:50.014Z",  // mobile creation timestamp
  "updatedAt":    "2025-11-23T07:01:46.033Z",  // mobile edit timestamp (= createdAt if never edited)
  "lastModified": <serverTimestamp>,            // Firestore-managed; bumped on EVERY write (mobile + portal)

  // === CUSTOMER === (mobile-authored, portal may rewrite via link)
  "customerName": "Dr farman anwar",        // string, non-empty
  "customerId":   "",                       // string, "" if not linked to a portal_customer

  // === LINE ITEMS ===
  "products": [                             // array; mobile's canonical field name
    {
      "id":       "1763880966271",          // string, per-line unique
      "name":     "Hefix 200",              // string, non-empty
      "prefix":   "Box",                    // string: "Box" | "Pieces"  (mobile's term for unit)
      "price":    "450",                    // STRING (mobile stores numeric input as string)
      "quantity": "1"                       // STRING
    }
  ],

  // === AMOUNTS === (optional — derived; written by mobile on save, ignored by portal which re-derives)
  "total":  4500.00,                        // number (optional). Computed from items if absent.
  "paid":   0,                              // number (optional). Re-derived from sum of payments where billId match.

  // === ACKNOWLEDGE (release-to-client) === (portal-authored OR mobile-authored)
  "acknowledged":   false,                  // boolean, defaults false
  "acknowledgedAt": null,                   // ISO string or null

  // === PROFILE === (mobile, optional)
  "createdByProfileId":   null,             // string | null
  "createdByProfileName": null,             // string | null

  // === LINEAGE === (portal-authored, optional, written during customer link/unlink)
  "linkedFromName":     null,               // string | null. Original customerName before link.
  "renamedFromPortal":  false,              // boolean. True if link rewrote customerName.
  "renamedAt":          null,               // ISO string | null
  "unlinkedFromPortal": false,              // boolean
  "unlinkedAt":         null                // ISO string | null
}
```

### Field-by-field rules

| Field | Required | Writer | Default if missing | Migration action |
|---|---|---|---|---|
| `id` | ✅ | mobile (create) | — | drop doc (corrupt) |
| `billNumber` | ✅ | mobile (create) | — | drop doc (corrupt) |
| `createdAt` | ✅ | mobile (create) | — | set to `lastModified` or now |
| `updatedAt` | ✅ | mobile/portal (write) | — | set to `createdAt` |
| `lastModified` | ✅ | Firestore serverTimestamp | — | set to now |
| `customerName` | ✅ | mobile (create) | — | set to `"(unknown)"` |
| `customerId` | optional | portal (link) | `""` | set to `""` |
| `products` | ✅ | mobile | — | set to `[]` (corrupt bill) |
| `acknowledged` | ✅ | portal | `false` | **backfill to false** |
| `acknowledgedAt` | ✅ | portal | `null` | **backfill to null** |
| `createdByProfileId` | optional | mobile | `null` | leave |
| `createdByProfileName` | optional | mobile | `null` | leave |
| `linkedFromName` | optional | portal | absent | leave absent |
| `total`, `paid` | optional | derived | recompute | leave |

---

## `payments/<paymentId>` — canonical payment

Created by mobile when a payment is recorded against a bill. Mobile is sole
writer.

```jsonc
{
  "id":         "1763881400000",              // string, matches doc id
  "billId":     "1763881190014",              // string, FK to bills/<id>
  "amount":     500.0,                        // number (not string — mobile records numeric)
  "receivedAt": "2025-11-24T08:00:00.000Z",   // ISO string
  "method":     "cash",                       // string | null  (e.g. cash, bank, upi)
  "note":       null,                         // string | null
  "lastModified": <serverTimestamp>
}
```

| Field | Required | Default if missing |
|---|---|---|
| `id` | ✅ | drop doc (corrupt) |
| `billId` | ✅ | drop doc (corrupt) |
| `amount` | ✅ | drop doc (corrupt) |
| `receivedAt` | ✅ | use `lastModified` ISO |
| `method` | optional | `null` |
| `note` | optional | `null` |
| `lastModified` | ✅ | now |

---

## `customers/<slug>` — mobile-canonical customer name index

Lightweight name-keyed index. Mobile + portal both write here (for cross-device
autocomplete). NOT the rich customer record — that's `portal_customers`.

```jsonc
{
  "id":        "acme-store",                  // string, matches doc id (slug of name)
  "name":      "Acme Store",                  // string, original casing preserved
  "updatedAt": "2026-05-18T15:22:52.619Z",    // ISO string
  "lastModified": <serverTimestamp>           // optional, Firestore-managed
}
```

---

## `products/<slug>` — mobile-canonical product name index

Same pattern as `customers/<slug>` but for product names.

```jsonc
{
  "id":        "hefix-200",
  "name":      "Hefix 200",
  "updatedAt": "2025-11-23T06:56:06.271Z",
  "lastModified": <serverTimestamp>           // optional
}
```

---

## `portal_customers/<id>` — rich customer (portal-owned)

Stores admin-enriched customer data. Portal-only writes (mobile doesn't touch).

```jsonc
{
  "id":         "c-1779117772619-w8oqj",       // string, matches doc id
  "name":       "Acme Store",                  // string, non-empty (canonical name; aliases list below)
  "email":      "",                            // string (empty OK)
  "phone":      "",                            // string (empty OK)
  "class":      "C",                           // "A" | "B" | "C" | "D" | "E"
  "createdAt":  "2026-05-18T15:22:52.619Z",    // ISO string
  "lastModified": <serverTimestamp>,           // Firestore-managed

  "address":    null,                          // string | null (optional)
  "gstNumber":  null,                          // string | null (optional)
  "aliases":    [],                            // string[] — raw names linked to this customer

  // Worker-managed (single writer)
  "outstanding":           0,                  // number
  "lastOutstandingUpdate": <serverTimestamp>   // Firestore-managed by worker
}
```

| Field | Required | Writer | Default if missing |
|---|---|---|---|
| `id`, `name`, `class`, `createdAt` | ✅ | portal | corrupt → drop |
| `email`, `phone` | ✅ | portal | `""` |
| `lastModified` | ✅ | portal | now |
| `address`, `gstNumber` | optional | portal | `null` |
| `aliases` | optional | portal | `[]` |
| `outstanding` | ✅ | **worker only** | `0` |
| `lastOutstandingUpdate` | ✅ | **worker only** | now |

---

## `portal_products/<key>` — rich product (portal-owned)

**Doc id = productKey(name) — SHA-256 hex of normalized name.** Single
canonical function in `web-portal/src/lib/productKey.ts`. e.g.
`portal_products/a3f9b21c4e8d...` (64 hex chars).

Why SHA-256 over a slug:
- Deterministic and collision-free for distinct names
- Fixed length (64 chars), predictable
- Two writes for the same name → same key → same doc → phantom-duplicates
  are physically impossible

Doc IDs are opaque; debug via `lookupProductByName(name)` which computes the
key and does a single `getDoc`.

Migration tool in Settings → Maintenance → "Consolidate to slug-as-id"
re-keys legacy random-id docs. Firestore Rules enforce the 64-char hex
format on write (see `firestore.rules`).

```jsonc
{
  "id":             "a3f9b21c4e8d6f...",        // matches doc id (SHA-256 of normalized name)
  "name":           "Paracetamol 500mg",
  "nameLower":      "paracetamol 500mg",       // lowercase-trimmed, for prefix search
  "description":    "",                        // string
  "labelIds":       [],                        // string[] (refs into portal_labels)
  "prices":         { "A": 50, "B": 45, "C": 40 },  // partial Record<class, number>
  "enabledClasses": { "A": true, "B": true, "C": false }, // partial Record<class, boolean>
  "visibleToClient": false,                    // boolean
  "source":          "manual",                 // "manual" | "billmaker"
  "inStock":         true,                     // boolean
  "images":          [],                       // string[] (Cloudinary URLs)
  "lastModified":    <serverTimestamp>
}
```

---

## `portal_labels/<id>`, `portal_classes/<code>`, `portal_deals/<id>`

Small portal-managed collections. Schemas are stable and small — see
`web-portal/src/types.ts` for the canonical interfaces:
- `Label`, `ClassDef`, `Deal`, `DealItem`.

All have `lastModified` (Firestore-managed).

---

## `_meta/business` — shop business info

```jsonc
{
  "name":    "Your Shop",
  "phone":   "+91...",
  "address": "123 Market Road, Your City — 000000",
  "gst":     "29ABCDE1234F1Z5"
}
```

Mobile is primary writer (during onboarding); portal can edit via Settings.

---

## `_meta/admin_aggregates` — derived aggregates (worker-owned)

```jsonc
{
  "shopCode":               "your-shop-code",
  "lastRecomputedAt":       "2026-05-22T...",
  "totalBilled":             1250000.5,
  "totalRevenue":            980000.0,
  "outstanding":             270000.5,
  "totalBillCount":          1245,
  "pendingCount":            34,
  "productCount":            418,            // NEW: counts portal_products
  "perCustomerOutstanding": {
    "<customerId>": { "name": "Foo", "outstanding": 12500, "hasId": true },
    "<rawName>":    { "name": "Bar", "outstanding":   200, "hasId": false }
  }
}
```

Worker is sole writer. Recomputed every 10 min OR after any
bill/payment/meta change.

---

## `portal_bills_meta/<billId>` — **DELETED** as of 2026-05-22

Was the per-bill ack/release record. Replaced by `acknowledged` + `acknowledgedAt`
fields on `bills/<id>` itself.

Cleanup completed:
- Web-portal no longer subscribes or writes (Deploy 2)
- Worker no longer syncs it to Supabase or uses it for aggregate triggers
- Worker's `/client/bills` derives `billsMeta` inline from `bills` docs
- Firestore collection purged via Settings → Maintenance → "Purge portal_bills_meta"

**Do not re-introduce this collection.** Ack belongs on the bill doc.

---

## Schema-drift policy (going forward)

1. **No silent field renames.** Renaming a field is a breaking change.
   Either keep both old + new for one full deploy cycle, or run a migration
   first.
2. **Every new field is optional in the schema.** Code reading the field must
   handle absence with a sensible default.
3. **Every collection write goes through one helper per writer**:
   - Portal: `pushPortalDoc()` in `firestoreSync.ts`
   - Mobile: `pushDoc()` / `pushDocMerge()` in `storage/sync.ts`
   - Worker: `setDocument()` in `lib/firestore.ts` (or `batchWrite`)
4. **Audit tool** (Settings → Maintenance) reports any doc that's missing a
   canonical field. Run after any significant change.
5. **Normalize tool** (Settings → Maintenance) backfills missing fields with
   the canonical defaults. Idempotent.

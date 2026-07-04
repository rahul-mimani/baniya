// Server-derived writes from synced bills.
//
// Mobile (Phase B) writes ONLY to `bills/<id>` in Firestore. The worker
// derives the rest after each bills sync:
//
//   - `customers/<slug>`         — lightweight name registry for mobile
//                                  autocomplete. One doc per unique
//                                  bill.customerName seen.
//   - `products/<slug>`          — same, for product name autocomplete.
//   - `portal_products/<key>`    — admin-managed product record with
//                                  default class enablement + zero prices
//                                  (admin enriches later via Manage tab).
//
// portal_customers is INTENTIONALLY NOT derived — admin promotes a raw
// customer name to portal_customer manually via the Manage UI in the
// portal, so they can set class, aliases, contact, etc. before exposing
// the customer to the client portal.
//
// Existence check happens against the Supabase replica (cheap, no Firestore
// reads). We only write Firestore docs for names that don't already exist.

import type { Env } from '../types';
import { incrementDocumentFields, batchCreateIfMissing } from './firestore';

// ---------------------------------------------------------------------------
// Slug helper. Must match the slugifyName used by mobile (storage/sync.ts
// and customerStorage.ts) and by portal (web-portal/src/data/dummyData.ts).
// Any drift here means duplicate docs — be careful editing.
// ---------------------------------------------------------------------------
const slugify = (s: string): string =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unnamed';

// SHA-256 hex of normalized name → portal_products doc id.
// Mirrors web-portal/src/lib/productKey.ts.
const productKey = async (name: string): Promise<string> => {
  const normalized = name.toLowerCase().trim().replace(/\s+/g, ' ');
  const buf = new TextEncoder().encode(normalized);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
};

// ---------------------------------------------------------------------------
// Cheap existence-check helpers against the Supabase replica. PostgREST
// returns ONLY the firestore_id column (we don't need data) and uses
// existingDocIds REMOVED — replaced by createDocumentIfMissing in firestore.ts
// which checks Firestore directly via precondition (no replica lag).

// ---------------------------------------------------------------------------
// Extract unique customer names + product names from a bills sync batch.
// Bills carry both as inline strings (mobile-canonical shape).
// ---------------------------------------------------------------------------
interface BillDoc {
  id: string;
  data: any;
}

const collectNamesFromBills = (
  bills: BillDoc[],
): { customerNames: Set<string>; productNames: Set<string> } => {
  const customerNames = new Set<string>();
  const productNames = new Set<string>();
  for (const b of bills) {
    const cn = typeof b.data?.customerName === 'string' ? b.data.customerName.trim() : '';
    if (cn) customerNames.add(cn);
    const prods = Array.isArray(b.data?.products) ? b.data.products : [];
    for (const p of prods) {
      const pn = typeof p?.name === 'string' ? p.name.trim() : '';
      if (pn) productNames.add(pn);
    }
  }
  return { customerNames, productNames };
};

// ---------------------------------------------------------------------------
// Public: run after a bills sync. Auto-creates missing customers / products
// docs in Firestore. Idempotent — safe to call on every cron tick.
// ---------------------------------------------------------------------------
export interface DeriveResult {
  customersCreated: number;
  productsLegacyCreated: number;
  productsPortalCreated: number;
  durationMs: number;
}

export const deriveFromBills = async (
  env: Env,
  shopCode: string,
  bills: BillDoc[],
): Promise<DeriveResult> => {
  const start = Date.now();
  const result: DeriveResult = {
    customersCreated: 0,
    productsLegacyCreated: 0,
    productsPortalCreated: 0,
    durationMs: 0,
  };

  if (bills.length === 0) {
    result.durationMs = Date.now() - start;
    return result;
  }

  const { customerNames, productNames } = collectNamesFromBills(bills);

  // Existence is checked via Firestore precondition (createDocumentIfMissing),
  // NOT via Supabase replica. The replica lags behind worker writes by up to
  // 15 min, so replica-based existence checks falsely fire repeat writes that
  // (a) over-count creations in admin_aggregates and (b) overwrite admin
  // edits on portal_products. The precondition guarantees one write per name.

  // ---- Build ALL derive writes into ONE batchWrite call ----
  // Previously this loop made one Firestore subrequest per unique name
  // (3 per product, 1 per customer). For shops with mixed bills this
  // routinely exceeded the free-tier 50-subrequest cap. batchWrite
  // collapses up to 500 writes into a SINGLE subrequest with per-write
  // status reporting — see batchCreateIfMissing in lib/firestore.ts.

  const now = new Date().toISOString();
  const entries: Array<{
    docPath: string;
    data: Record<string, any>;
    kind: 'customer' | 'product-legacy' | 'product-portal';
    nameOrSlug: string;
  }> = [];

  for (const name of customerNames) {
    const slug = slugify(name);
    entries.push({
      kind: 'customer',
      nameOrSlug: slug,
      docPath: `shops/${shopCode}/customers/${slug}`,
      data: {
        id: slug,
        name,
        updatedAt: now,
        lastModified: now,
        source: 'worker-derived-from-bill',
      },
    });
  }

  for (const name of productNames) {
    const slug = slugify(name);
    const key = await productKey(name);

    entries.push({
      kind: 'product-legacy',
      nameOrSlug: slug,
      docPath: `shops/${shopCode}/products/${slug}`,
      data: {
        id: slug,
        name,
        updatedAt: now,
        lastModified: now,
        source: 'worker-derived-from-bill',
      },
    });

    entries.push({
      kind: 'product-portal',
      nameOrSlug: key,
      docPath: `shops/${shopCode}/portal_products/${key}`,
      data: {
        id: key,
        name,
        nameLower: name.toLowerCase().trim(),
        prices: {},
        enabledClasses: {},
        visibleToClient: false,
        createdAt: now,
        updatedAt: now,
        lastModified: now,
        source: 'worker-derived-from-bill',
      },
    });
  }

  // Chunk to stay within Firestore's 500-writes-per-batchWrite limit
  // (we typically have well under that, but be safe).
  const CHUNK = 400;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const slice = entries.slice(i, i + CHUNK);
    try {
      const outcomes = await batchCreateIfMissing(
        env,
        slice.map(e => ({ docPath: e.docPath, data: e.data })),
      );
      outcomes.forEach((outcome, idx) => {
        const e = slice[idx];
        if (outcome === true) {
          // Newly created — bump counter.
          if (e.kind === 'customer') result.customersCreated++;
          else if (e.kind === 'product-legacy') result.productsLegacyCreated++;
          else if (e.kind === 'product-portal') result.productsPortalCreated++;
        } else if (outcome === false) {
          // Already existed — no-op (this is the steady-state path).
        } else {
          // Real error on this individual write — log but keep going.
          console.warn('derive_batch_entry_failed', {
            shopCode,
            kind: e.kind,
            target: e.nameOrSlug,
            err: outcome.message,
          });
        }
      });
    } catch (err) {
      // batchWrite call itself failed (network, auth, cap). One log line
      // per failed batch — easier to diagnose than per-entry spam.
      console.error('derive_batch_failed', {
        shopCode,
        chunkSize: slice.length,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Phase B: when the worker auto-creates new portal_products, atomically
  // increment admin_aggregates.productCount so the Overview tile reflects
  // the new count immediately via subscription — no separate count query
  // needed on the portal side. Idempotent: only counts what we actually
  // wrote this run.
  if (result.productsPortalCreated > 0) {
    try {
      await incrementDocumentFields(
        env,
        `shops/${shopCode}/_meta/admin_aggregates`,
        { productCount: result.productsPortalCreated },
        { lastRecomputedAt: new Date().toISOString(), shopCode },
      );
    } catch (err) {
      console.error('derive_product_count_increment_failed', {
        shopCode,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  result.durationMs = Date.now() - start;
  return result;
};


// ---------------------------------------------------------------------------
// Per-customer outstanding maintenance.
//
// After bills sync, the worker also nudges portal_customers.outstanding for
// any existing portal_customer whose name matches a bill's customerName.
// portal_customers itself is NOT auto-created (admin manages that via the
// Manage tab) — we only UPDATE existing rows.
//
// This mirrors the portal's incrementCustomerByName (in dummyData.ts /
// firestoreSync.ts) — same atomic increment pattern, same shape of payload.
// ---------------------------------------------------------------------------

/**
 * Sum of outstanding-deltas grouped by customer name (lowercased+trimmed).
 * The worker collects these from bill deltas and applies them in one pass
 * after sync. Customers not in portal_customers are silently skipped.
 */
export const applyCustomerOutstandingDeltas = async (
  env: Env,
  shopCode: string,
  deltasByName: Map<string, number>,
): Promise<void> => {
  if (deltasByName.size === 0) return;

  // Resolve customer name → portal_customer firestore_id by querying the
  // replica (cheap, no Firestore reads). We match on both canonical name
  // and aliases — same logic admin_aggregates_recompute SQL uses. We fetch
  // all portal_customers for the shop (typically <500 docs) and resolve
  // names in memory rather than per-key queries.
  const url =
    `${env.SUPABASE_URL}/rest/v1/replica_documents` +
    `?shop_code=eq.${encodeURIComponent(shopCode)}` +
    `&collection=eq.portal_customers` +
    `&select=firestore_id,data`;
  const r = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!r.ok) {
    console.warn('apply_customer_outstanding_lookup_failed', { status: r.status });
    return;
  }
  const rows = (await r.json().catch(() => [])) as Array<{ firestore_id: string; data: any }>;

  // Build name → id map (canonical name + each alias).
  const nameToId = new Map<string, string>();
  for (const row of rows) {
    const name = String(row.data?.name ?? '').trim().toLowerCase();
    if (name) nameToId.set(name, row.firestore_id);
    const aliases = Array.isArray(row.data?.aliases) ? row.data.aliases : [];
    for (const a of aliases) {
      const aLow = String(a).trim().toLowerCase();
      if (aLow) nameToId.set(aLow, row.firestore_id);
    }
  }

  // Apply atomic increment per matched customer. Sum deltas per id (in case
  // multiple bills for the same customer hit different alias spellings).
  const idDeltas = new Map<string, number>();
  for (const [name, delta] of deltasByName) {
    if (!isFinite(delta) || delta === 0) continue;
    const id = nameToId.get(name);
    if (!id) {
      // Customer name not in portal_customers — that's expected for fresh
      // bills whose customer hasn't been promoted yet. Skip silently.
      continue;
    }
    idDeltas.set(id, (idDeltas.get(id) || 0) + delta);
  }

  const writes: Array<Promise<void>> = [];
  for (const [id, delta] of idDeltas) {
    if (!isFinite(delta) || delta === 0) continue;
    writes.push(
      incrementDocumentFields(
        env,
        `shops/${shopCode}/portal_customers/${id}`,
        { outstanding: delta },
        {
          lastOutstandingUpdate: new Date().toISOString(),
          lastModified: new Date().toISOString(),
        },
      ).catch(err => {
        console.warn('apply_customer_outstanding_write_failed', {
          shopCode,
          id,
          err: err instanceof Error ? err.message : String(err),
        });
      }),
    );
  }
  await Promise.all(writes);
};

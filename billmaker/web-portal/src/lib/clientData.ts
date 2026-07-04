// Client-view data layer.
//
// All data comes from the auth-service /client/* endpoints, which serve from
// the Supabase replica. Firestore is never touched by the client side.
//
// Architecture: per-endpoint cache + per-endpoint hooks.
//
//   - Module-level cache keyed by endpoint key (`me`, `bills`, etc.).
//   - 30-second TTL: a hook checks the cache; if fresh, returns it
//     immediately without a network call.
//   - In-flight dedup: if two components mount at the same time and both
//     ask for /me, only ONE network request goes out — both consume it.
//   - Pub/sub: when a fetch resolves, all subscribed hooks re-render.
//   - Cache clears on logout/login so a different user's data never leaks.
//
// Per-route fetching: each Client* route uses only the hooks it needs. For
// example ClientBills uses useClientMe + useClientBills only — it does NOT
// request /products, /deals, /labels even though those endpoints exist.

import { useEffect, useMemo, useState } from 'react';
import { authedFetch, currentUser, onAuthChange } from './authClient';
import { isIdle, onIdleResume } from './idle';
import { store, notify as notifyStore } from '../data/dummyData';
import { ALL_CLASS_CODES } from '../types';
import type { Bill, BillItem, ClassDef, Customer, CustomerClass, Deal, Label, Product } from '../types';

// ---------------------------------------------------------------------------
// Module-level cache + pub/sub.
// ---------------------------------------------------------------------------
interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

const cache: Record<string, CacheEntry<any>> = {};
const inflight: Record<string, Promise<any> | undefined> = {};
const subs: Record<string, Set<() => void>> = {};

const TTL_MS = 30_000;

const notify = (key: string) => {
  subs[key]?.forEach(fn => { try { fn(); } catch {} });
};

const subscribe = (key: string, fn: () => void) => {
  if (!subs[key]) subs[key] = new Set();
  subs[key].add(fn);
  return () => { subs[key]?.delete(fn); };
};

const clearAll = () => {
  for (const k of Object.keys(cache)) delete cache[k];
  for (const k of Object.keys(inflight)) delete inflight[k];
  for (const k of Object.keys(subs)) notify(k);
};

// Only wipe cache when the user IDENTITY changes (login or logout). Token
// refreshes / validateSession pings for the same user are noisy notifies and
// must not flush the cache — otherwise a refresh races: cache populates,
// /auth/me returns, notify() fires, cache wiped, hooks left in loading state
// without a refetch trigger.
let lastUserId: string | null = currentUser()?.id || null;
onAuthChange((s) => {
  const newId = s.user?.id || null;
  if (newId !== lastUserId) {
    lastUserId = newId;
    clearAll();
  }
});

// Track URLs for cached keys so the idle-resume handler knows what to refetch.
const endpointMeta: Record<string, { url: string }> = {};

// When the user returns from idle, refresh every endpoint we know about so
// they see fresh data without having to navigate or refresh the page.
onIdleResume(() => {
  for (const key of Object.keys(cache)) {
    const meta = endpointMeta[key];
    if (meta) {
      fetchEndpoint(key, meta.url).catch(() => {});
    } else {
      delete cache[key];
    }
  }
});


// ---------------------------------------------------------------------------
// Class-defs sync — populates store.classDefs from /client/me so the client
// side renders class names + colors the admin configured. Without this,
// store.classDefs is empty (Firestore listeners only run for admin) and
// ClassBadge falls back to the generic "Class A" label.
// ---------------------------------------------------------------------------
const applyClassDefsFromMe = (meData: { classes?: unknown }) => {
  const arr = meData?.classes;
  if (!Array.isArray(arr) || arr.length === 0) return;
  const defs: ClassDef[] = arr
    .map((c: any) => ({
      code: c.code as CustomerClass,
      name: typeof c.name === 'string' ? c.name : '',
      color: c.color,
    }))
    .filter(c => c.code && c.name && c.color && ALL_CLASS_CODES.includes(c.code))
    .sort((a, b) => ALL_CLASS_CODES.indexOf(a.code) - ALL_CLASS_CODES.indexOf(b.code));
  if (defs.length === 0) return;
  // Replace contents in-place so existing array references stay alive.
  store.classDefs.length = 0;
  store.classDefs.push(...defs);
  notifyStore();
};


// ---------------------------------------------------------------------------
// Core fetcher.
// ---------------------------------------------------------------------------
const fetchEndpoint = <T>(key: string, url: string): Promise<T> => {
  if (inflight[key]) return inflight[key] as Promise<T>;
  endpointMeta[key] = { url };

  // Idle gate — skip network call when the app is idle. Returns whatever's
  // cached (or undefined), without touching inflight state. The resume
  // handler above will refetch when activity comes back.
  if (isIdle()) {
    return Promise.resolve(cache[key]?.data as T);
  }

  const p = authedFetch(url)
    .then(async r => {
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`${url} → ${r.status} ${body.slice(0, 200)}`);
      }
      return r.json();
    })
    .then((data: T) => {
      cache[key] = { data, fetchedAt: Date.now() };
      delete inflight[key];
      // Side-effect: when /client/me arrives, sync its class defs into the
      // shared store so ClassBadge / classDisplayName resolve correctly on
      // the client side. Runs BEFORE notify(key) so subscribers re-render
      // with class data already in place.
      if (key === 'me') applyClassDefsFromMe(data as any);
      notify(key);
      return data;
    })
    .catch(err => {
      delete inflight[key];
      throw err;
    });

  inflight[key] = p as Promise<any>;
  return p as Promise<T>;
};


// ---------------------------------------------------------------------------
// Per-endpoint hook factory.
// Returns cached data immediately if fresh; otherwise triggers a fetch and
// re-renders when it arrives. `refetch()` forces a fresh fetch.
// ---------------------------------------------------------------------------
interface UseEndpointResult<T> {
  data: T | undefined;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

const useEndpoint = <T>(key: string, url: string): UseEndpointResult<T> => {
  // Force-render counter.
  const [, force] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsub = subscribe(key, () => force(n => n + 1));

    const cached = cache[key];
    const stale = !cached || Date.now() - cached.fetchedAt >= TTL_MS;
    if (stale) {
      fetchEndpoint<T>(key, url)
        .then(() => setError(null))
        .catch(e => setError(e?.message || 'fetch_failed'));
    } else if (error) {
      setError(null);
    }
    return unsub;
    // url is constant per key; we intentionally don't re-fire on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, url]);

  const entry = cache[key] as CacheEntry<T> | undefined;
  return {
    data: entry?.data,
    loading: !entry,
    error,
    refetch: async () => {
      // DON'T delete the cache here — that would make `loading=true` and the
      // UI would flicker through a skeleton/empty state until the network
      // call returns (perceived as a "reload" of the list).
      // Instead, clear the inflight slot so a new fetch fires even if one
      // recently completed, and let the cache stay populated until the new
      // response atomically replaces it via fetchEndpoint's .then().
      delete inflight[key];
      try {
        await fetchEndpoint<T>(key, url);
        setError(null);
      } catch (e: any) {
        setError(e?.message || 'fetch_failed');
      }
    },
  };
};


// ---------------------------------------------------------------------------
// Endpoint response types.
// ---------------------------------------------------------------------------
export interface ClientBusinessInfo {
  name?: string;
  phone?: string;
  address?: string;
  gst?: string;
}

interface MeResponse {
  user: { id: string; identifier: string; name: string; role: string; class: string | null };
  customer: Customer | null;
  business: ClientBusinessInfo | null;
}

interface BillsResponse {
  bills: Array<any>;
  billsMeta: Array<any>;
  payments: Array<any>;
  pendingReprints?: Array<{ id: string; bill_id: string; status: string; created_at: string }>;
}

interface ProductsResponse { products: Product[] }
interface DealsResponse { deals: Deal[] }
interface LabelsResponse { labels: Label[] }

export interface ClientQuote {
  id: string;
  product_id: string;
  product_name: string | null;
  product_unit: string | null;
  quantity: number;
  proposed_price: number | null;
  note: string | null;
  status: 'pending' | 'accepted' | 'rejected' | 'fulfilled';
  admin_response: string | null;
  created_at: string;
  responded_at: string | null;
}
interface QuotesResponse { quotes: ClientQuote[] }


// ---------------------------------------------------------------------------
// Bill normalization (mirrors the portal's dummyData/applyBillsSnapshot logic
// so mobile-shape bills (`products`) and portal-shape bills (`items`) both
// render consistently).
// ---------------------------------------------------------------------------
const reviveItems = (raw: any): BillItem[] => {
  const arr = Array.isArray(raw?.products) ? raw.products
    : Array.isArray(raw?.items) ? raw.items
    : [];
  return arr.map((it: any) => {
    const quantityNum = Number(it?.quantity || it?.qty || 0);
    const rateNum = Number(it?.rate || it?.price || 0);
    return {
      productName: it?.name || it?.productName || '',
      quantity: quantityNum,
      unit: it?.unit || it?.prefix || 'Pieces',
      rate: rateNum,
      amount: Number(it?.amount) || quantityNum * rateNum || 0,
    };
  });
};

const normalizeBill = (raw: any, meta: any, paidAmount: number): Bill => {
  const items = reviveItems(raw);
  const total = Number(raw.total ?? items.reduce((s, i) => s + i.amount, 0));
  return {
    id: raw.id,
    billNumber: raw.billNumber || raw.id,
    customerId: raw.customerId || '',
    customerName: raw.customerName || '',
    items,
    total,
    paid: paidAmount,
    createdAt: raw.createdAt || new Date().toISOString(),
    acknowledged: meta?.acknowledged === true,
    acknowledgedAt: meta?.acknowledgedAt || undefined,
  };
};


// ---------------------------------------------------------------------------
// Public per-endpoint hooks. Each route imports only what it needs.
// ---------------------------------------------------------------------------

/** /client/me — user + linked customer + business info. */
export const useClientMe = () => {
  const r = useEndpoint<MeResponse>('me', '/client/me');
  return {
    me: r.data?.customer ?? null,
    user: r.data?.user ?? null,
    business: r.data?.business ?? null,
    loading: r.loading,
    error: r.error,
    refetch: r.refetch,
  };
};

/**
 * /client/bills — normalized + filtered to acknowledged-only, sorted desc by
 * createdAt. Payments merged in via `paid` field. Returns a `pendingReprintIds`
 * Set so consumers can show "Reprint requested" instead of "Request reprint".
 */
export const useClientBills = () => {
  const r = useEndpoint<BillsResponse>('bills', '/client/bills');
  const bills: Bill[] = useMemo(() => {
    if (!r.data) return [];
    // Payments live embedded in `bill.payments[]` (Deploy 5). The server's
    // top-level `payments` array is now derived from that, but read both ways
    // so a stale cached response from before the server fix still works.
    // Per-bill embedded wins; only fall back to top-level when a bill has no
    // embedded array at all (legacy data).
    const topLevelPaidByBill = new Map<string, number>();
    for (const p of (r.data.payments || [])) {
      topLevelPaidByBill.set(p.billId, (topLevelPaidByBill.get(p.billId) || 0) + Number(p.amount || 0));
    }
    const sumEmbedded = (b: any): number | null => {
      const arr = Array.isArray(b?.payments) ? b.payments : null;
      if (arr === null) return null;
      let s = 0;
      for (const p of arr) s += Number(p?.amount || 0);
      return s;
    };
    const metaByBill = new Map<string, any>();
    for (const m of (r.data.billsMeta || [])) {
      metaByBill.set(m.id, m);
    }
    return (r.data.bills || [])
      .map(b => {
        const embeddedSum = sumEmbedded(b);
        const paid = embeddedSum !== null
          ? embeddedSum
          : (topLevelPaidByBill.get(b.id) || 0);
        return normalizeBill(b, metaByBill.get(b.id), paid);
      })
      .filter(b => b.acknowledged)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [r.data]);

  const pendingReprintIds = useMemo(() => {
    const s = new Set<string>();
    for (const rp of (r.data?.pendingReprints || [])) s.add(rp.bill_id);
    return s;
  }, [r.data]);

  return {
    bills,
    pendingReprintIds,
    loading: r.loading,
    error: r.error,
    refetch: r.refetch,
  };
};

/** POST /client/bills/:id/reprint — queue a reprint request. */
export const requestReprint = async (billId: string, note?: string): Promise<void> => {
  const r = await authedFetch(`/client/bills/${encodeURIComponent(billId)}/reprint`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || 'reprint_failed');
};

/** /client/products — already filtered server-side to this client's class. */
export const useClientProducts = () => {
  const r = useEndpoint<ProductsResponse>('products', '/client/products');
  return {
    products: r.data?.products ?? [],
    loading: r.loading,
    error: r.error,
    refetch: r.refetch,
  };
};

/** /client/deals — already filtered server-side to this client's class. */
export const useClientDeals = () => {
  const r = useEndpoint<DealsResponse>('deals', '/client/deals');
  return {
    deals: r.data?.deals ?? [],
    loading: r.loading,
    error: r.error,
    refetch: r.refetch,
  };
};

/** /client/quotes — the client's own quote-request history. */
export const useClientQuotes = () => {
  const r = useEndpoint<QuotesResponse>('quotes', '/client/quotes');
  return {
    quotes: r.data?.quotes ?? [],
    loading: r.loading,
    error: r.error,
    refetch: r.refetch,
  };
};

/** /client/labels — small list, referenced by product chips. */
export const useClientLabels = () => {
  const r = useEndpoint<LabelsResponse>('labels', '/client/labels');
  return {
    labels: r.data?.labels ?? [],
    loading: r.loading,
    error: r.error,
    refetch: r.refetch,
  };
};

/** Manual cache nuke — useful for "pull to refresh" gestures. */
export const refetchAllClient = () => clearAll();

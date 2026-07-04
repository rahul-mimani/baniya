// Read helpers for the `replica_documents` table. The replica is filled by
// the cron sync (lib/sync.ts) and read by client-facing endpoints
// (routes/client.ts). All reads are scoped to a single shop_code and one or
// more collections.
//
// The generic table stores each doc's JSONB body in `data` and exposes a few
// generated columns (customer_id, customer_name, bill_id, visible_to_client)
// for fast filtering. Reads return the parsed data plus the doc id.

import type { Env } from '../types';

const sbHeaders = (env: Env, extra: Record<string, string> = {}): HeadersInit => ({
  apikey: env.SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
  Accept: 'application/json',
  ...extra,
});

const sbUrl = (env: Env, path: string) => `${env.SUPABASE_URL}/rest/v1/${path}`;

const sbCheck = async (r: Response, where: string): Promise<void> => {
  if (r.ok) return;
  const detail = await r.text().catch(() => '');
  throw new Error(`Supabase ${where} failed (${r.status}): ${detail}`);
};

export interface ReplicaDoc<T = Record<string, any>> {
  id: string;
  data: T;
  source_updated_at: string | null;
  last_synced_at: string;
}

interface RawRow {
  firestore_id: string;
  data: Record<string, any>;
  source_updated_at: string | null;
  last_synced_at: string;
}

const SELECT_FIELDS = 'firestore_id,data,source_updated_at,last_synced_at';

const toDoc = <T>(row: RawRow): ReplicaDoc<T> => ({
  id: row.firestore_id,
  data: row.data as T,
  source_updated_at: row.source_updated_at,
  last_synced_at: row.last_synced_at,
});


/** List every doc in (shop_code, collection). Optional extra PostgREST filter. */
export const listCollection = async <T = Record<string, any>>(
  env: Env,
  shopCode: string,
  collection: string,
  extraFilter?: string,
): Promise<ReplicaDoc<T>[]> => {
  const base =
    `replica_documents?shop_code=eq.${encodeURIComponent(shopCode)}` +
    `&collection=eq.${encodeURIComponent(collection)}` +
    `&select=${SELECT_FIELDS}`;
  const url = extraFilter ? `${sbUrl(env, base)}&${extraFilter}` : sbUrl(env, base);
  const r = await fetch(url, { headers: sbHeaders(env) });
  await sbCheck(r, `list ${collection}`);
  const rows = (await r.json()) as RawRow[];
  return rows.map(row => toDoc<T>(row));
};


/** Fetch one doc by id. Returns null if not found. */
export const getDocById = async <T = Record<string, any>>(
  env: Env,
  shopCode: string,
  collection: string,
  firestoreId: string,
): Promise<ReplicaDoc<T> | null> => {
  const url = sbUrl(env,
    `replica_documents?shop_code=eq.${encodeURIComponent(shopCode)}` +
    `&collection=eq.${encodeURIComponent(collection)}` +
    `&firestore_id=eq.${encodeURIComponent(firestoreId)}` +
    `&select=${SELECT_FIELDS}&limit=1`,
  );
  const r = await fetch(url, { headers: sbHeaders(env) });
  await sbCheck(r, `get ${collection}/${firestoreId}`);
  const rows = (await r.json()) as RawRow[];
  return rows[0] ? toDoc<T>(rows[0]) : null;
};


/**
 * List bills whose `customerName` matches any of the provided names.
 * Match is case-insensitive + whitespace-trimmed — admin's canonical customer
 * name might be `"John Doe"` while bills (often written by mobile) carry
 * `"john doe"` or `"John Doe "`. We compare against the normalized generated
 * column `customer_name_norm` (lower + trim). Empty `names` returns [].
 */
export const listBillsByCustomerNames = async (
  env: Env,
  shopCode: string,
  names: string[],
): Promise<ReplicaDoc[]> => {
  if (names.length === 0) return [];
  const normalized = names
    .map(n => n.trim().toLowerCase())
    .filter(n => n.length > 0);
  if (normalized.length === 0) return [];
  // PostgREST `in.()` accepts a comma-separated list. Quote individual values
  // so commas / special chars inside a name don't break the parser.
  const quoted = normalized.map(n => `"${n.replace(/"/g, '\\"')}"`).join(',');
  const filter = `customer_name_norm=in.(${encodeURIComponent(quoted)})`;
  return listCollection(env, shopCode, 'bills', filter);
};


// listPaymentsByBillIds REMOVED (Deploy 5 cleanup). Payments now live inside
// bills.data->'payments' — extract them from the bill rows directly instead
// (see flattenBillPayments in routes/client.ts).

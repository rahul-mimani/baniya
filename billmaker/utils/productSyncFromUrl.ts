// Fetches a list of product names from a user-provided URL and merges them
// into the local products.json via addProductsBatch (which dedupes by name).
//
// The URL is set via the settings JSON (productSync.url) — this util is the
// runtime that the "Sync now" button in Settings triggers.
//
// Accepted response shapes (in order of detection):
//   1. JSON array of strings:    ["Product A", "Product B"]
//   2. JSON array of objects:    [{"name": "Product A"}, ...]
//   3. Wrapped object:           {"products": [...]} where [...] follows 1 or 2
//
// A flexible parser means an admin can point at almost any product
// catalogue endpoint without writing a transformation step.

import { addProductsBatch } from '../storage/productStorage';
import { saveProductSyncConfig, getProductSyncConfig } from '../storage/productSyncStorage';

export interface ProductSyncResult {
  fetched: number;  // names in the response
  added: number;    // names not already present locally
  total: number;    // size of local products.json after the merge
  durationMs: number;
}

const parseProductNames = (text: string): string[] => {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Response was not valid JSON.');
  }
  const list: any[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.products)
      ? parsed.products
      : null;
  if (!list) {
    throw new Error('Expected JSON array of names or {"products": [...]}.');
  }
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      const t = entry.trim();
      if (t) out.push(t);
    } else if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
      const t = entry.name.trim();
      if (t) out.push(t);
    }
  }
  return out;
};

export const syncProductsFromUrl = async (url?: string): Promise<ProductSyncResult> => {
  const started = performance.now();
  const cfg = await getProductSyncConfig();
  const target = (url ?? cfg.url ?? '').trim();
  if (!target) throw new Error('No product sync URL configured.');

  let res: Response;
  try {
    res = await fetch(target, { cache: 'no-store' });
  } catch (e: any) {
    throw new Error(`Could not reach the URL: ${String(e?.message || e).slice(0, 120)}`);
  }
  if (!res.ok) throw new Error(`URL returned HTTP ${res.status}.`);

  const text = await res.text();
  const names = parseProductNames(text);
  if (names.length === 0) {
    // Still count as a successful "no-op" sync — record the timestamp so
    // the user sees the sync ran. Better than silently doing nothing.
    await saveProductSyncConfig({
      ...cfg,
      url: target,
      lastSyncedAt: new Date().toISOString(),
      lastResult: { added: 0, total: 0 },
    });
    return {
      fetched: 0,
      added: 0,
      total: 0,
      durationMs: Math.round(performance.now() - started),
    };
  }

  // addProductsBatch reads current, dedupes, and writes only-new. Returns
  // void in the existing API, so we measure "added" by diffing the count.
  const { getProducts } = await import('../storage/productStorage');
  const beforeCount = (await getProducts()).length;
  await addProductsBatch(names);
  const after = await getProducts();
  const added = after.length - beforeCount;

  await saveProductSyncConfig({
    ...cfg,
    url: target,
    lastSyncedAt: new Date().toISOString(),
    lastResult: { added, total: after.length },
  });

  // Tell any open ProductInput / CustomerInput to refresh its in-memory cache.
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('billmaker-products-updated', { detail: { added } }));
  }

  return {
    fetched: names.length,
    added,
    total: after.length,
    durationMs: Math.round(performance.now() - started),
  };
};

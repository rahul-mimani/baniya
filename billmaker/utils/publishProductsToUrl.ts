// Publish the device's product catalogue to the configured product-sync
// URL via POST. Designed for npoint.io-style anonymous JSON bins where
// the URL itself is both the read and write endpoint — no auth header,
// no PAT, no OAuth.
//
// npoint.io behaviour (verified): POST <bin-url> with the new content in
// the body and Content-Type: application/json overwrites the bin atomically.
//
// Read-only URLs (raw GitHub Pages, S3, etc.) will return a non-2xx from
// the POST; we surface the status text so the user can switch hosts.

import { getProducts } from '../storage/productStorage';
import {
  getProductSyncConfig,
  saveProductSyncConfig,
} from '../storage/productSyncStorage';

export interface PublishToUrlResult {
  count: number;
  durationMs: number;
}

export const publishProductsToUrl = async (): Promise<PublishToUrlResult> => {
  const started = performance.now();
  const cfg = await getProductSyncConfig();
  const url = (cfg.url || '').trim();
  if (!url) throw new Error('Set the Product list URL first.');

  const products = await getProducts();
  // Sort alphabetically — keeps the stored bin (and any GitHub-Pages
  // mirror of it) deterministic across publishes from different phones.
  const sorted = [...products].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
  const payload = JSON.stringify(sorted);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      cache: 'no-store',
    });
  } catch (e: any) {
    throw new Error(`Could not reach the URL: ${String(e?.message || e).slice(0, 120)}`);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error(
      res.status === 405
        ? `That URL is read-only (HTTP 405). Switch to an npoint.io bin to publish.`
        : `Publish failed (HTTP ${res.status}). ${detail}`.trim(),
    );
  }

  await saveProductSyncConfig({
    ...cfg,
    lastPublishedAt: new Date().toISOString(),
  });

  return {
    count: sorted.length,
    durationMs: Math.round(performance.now() - started),
  };
};

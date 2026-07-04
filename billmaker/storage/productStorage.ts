// src/storage/productStorage.ts
import { Filesystem, Encoding } from '@capacitor/filesystem';
import { APP_DIR, initFile } from './paths';
import { pushDocMerge } from './sync';
import { log } from '../utils/diagnostics';

const FILE_NAME = 'products.json';

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unnamed';

export const initProductStorage = async () => {
  await initFile(FILE_NAME, '[]');
};

/** Get all saved product names. Defensive against older shapes (e.g. {name: "..."}). */
export const getProducts = async (): Promise<string[]> => {
  try {
    const result = await Filesystem.readFile({
      path: FILE_NAME,
      directory: APP_DIR,
      encoding: Encoding.UTF8,
    });
    const dataStr =
      typeof result.data === 'string' ? result.data : await result.data.text();
    const parsed = JSON.parse(dataStr);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(entry => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && typeof entry.name === 'string') return entry.name;
        return null;
      })
      .filter((v): v is string => !!v && v.trim().length > 0);
  } catch (error) {
    console.error('Error reading products:', error);
    return [];
  }
};

/** Save entire list */
export const saveProducts = async (products: string[]) => {
  const jsonData = JSON.stringify(products, null, 2);
  await Filesystem.writeFile({
    path: FILE_NAME,
    data: jsonData,
    directory: APP_DIR,
    encoding: Encoding.UTF8,
  });
};

/**
 * Bulk-add product names. Same shape as customerStorage.addCustomersBatch —
 * one read, one write, only-new pushed. Used by the bills listener so a
 * 200-bill replay doesn't fan out into 200 disk reads.
 */
export const addProductsBatch = async (names: string[]): Promise<void> => {
  if (!Array.isArray(names) || names.length === 0) return;

  const seen = new Set<string>();
  const trimmedInput: string[] = [];
  for (const raw of names) {
    if (!raw) continue;
    const t = String(raw).trim();
    if (!t) continue;
    const lower = t.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    trimmedInput.push(t);
  }
  if (trimmedInput.length === 0) return;

  // No block-list gate: same reasoning as customers — names that appear in
  // real bills must end up in local products.json, and user-typed product
  // names should always be accepted.
  const allowed: string[] = trimmedInput;

  const local = await getProducts();
  const existingLower = new Set(local.map(p => String(p).toLowerCase()));

  const toAdd: string[] = [];
  for (const name of allowed) {
    if (!existingLower.has(name.toLowerCase())) {
      toAdd.push(name);
      existingLower.add(name.toLowerCase());
    }
  }
  if (toAdd.length === 0) return;

  // Local-only save. Phase B: mobile no longer writes products/<slug> to
  // Firestore. The worker derives both products/<slug> and portal_products/<key>
  // from bill.products[].name after each bills sync.
  await saveProducts([...local, ...toAdd]);
};

/** Add a single new product (avoids duplicates) — local cache only. */
export const addProduct = async (name?: string) => {
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  // No block-list gate — user-typed product names always accepted.
  const products = await getProducts();
  const exists = products.some(p => String(p).toLowerCase() === trimmed.toLowerCase());
  if (exists) return;
  products.push(trimmed);
  await saveProducts(products);
  log('info', 'products', `addProduct (local-only) "${trimmed}" — total ${products.length}`);
  // Phase B: no Firestore push. Worker derives products/<slug> + portal_products/<key>
  // from the bill on next sync.
};

/** Same reconcile-by-name pattern as customerStorage.applyRemoteCustomers,
 *  with persistence so it survives app restarts. */
let lastRemoteProductNames: Set<string> | null = null;
let loadStatePromise: Promise<void> | null = null;
const ensureStateLoaded = async (): Promise<void> => {
  if (lastRemoteProductNames !== null) return;
  if (!loadStatePromise) {
    loadStatePromise = (async () => {
      const { getSyncState } = await import('./syncState');
      const s = await getSyncState();
      lastRemoteProductNames = new Set(s.products || []);
    })();
  }
  await loadStatePromise;
};

export interface ApplyRemoteOptions {
  // 'snapshot' (default) — caller is passing the full remote list, so prune
  //   any local name that was in the PREVIOUS remote snapshot but is missing now.
  // 'event' — caller is passing a single Realtime payload. Only add the name
  //   if missing; never prune local based on absence from this single doc.
  mode?: 'snapshot' | 'event';
}

/**
 * Merge a remote products snapshot into local products.json:
 *   - Names in remote but not in local → added
 *   - (snapshot mode only) Names in local but no longer in remote (and previously
 *     in remote) → removed
 *   - Names in local and never seen remotely → preserved (pending push)
 */
export const applyRemoteProducts = async (
  docs: any[],
  opts: ApplyRemoteOptions = {},
): Promise<{ added: number; removed: number }> => {
  const mode = opts.mode ?? 'snapshot';
  await ensureStateLoaded();

  // Block list gate
  const { getBlockLists } = await import('./syncState');
  const block = await getBlockLists();
  const slugifyP = (s: string) =>
    s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  const remoteNames = new Set<string>();
  for (const d of docs) {
    const name = (d?.name || '').toString().trim();
    if (!name) continue;
    if (block.productNames.has(name.toLowerCase()) || block.productNames.has(slugifyP(name))) continue;
    remoteNames.add(name.toLowerCase());
  }

  const local = await getProducts();
  const localLowerSet = new Set(local.map(p => p.toLowerCase()));
  const prevRemote = lastRemoteProductNames!;

  let added = 0;
  let removed = 0;

  for (const d of docs) {
    const name = (d?.name || '').toString().trim();
    if (!name) continue;
    const lower = name.toLowerCase();
    if (block.productNames.has(lower) || block.productNames.has(slugifyP(name))) continue;
    if (!localLowerSet.has(lower)) {
      local.push(name);
      localLowerSet.add(lower);
      added++;
    }
  }

  if (mode === 'snapshot') {
    for (let i = local.length - 1; i >= 0; i--) {
      const lower = local[i].toLowerCase();
      if (prevRemote.has(lower) && !remoteNames.has(lower)) {
        local.splice(i, 1);
        removed++;
      }
    }
    lastRemoteProductNames = remoteNames;
    const { updateSyncState } = await import('./syncState');
    void updateSyncState({ products: Array.from(remoteNames) });
  } else {
    // event mode: merge incoming name(s) into prevRemote so the next snapshot
    // reconcile doesn't see them as "newly missing" and wrongly delete them.
    for (const n of remoteNames) prevRemote.add(n);
    const { updateSyncState } = await import('./syncState');
    void updateSyncState({ products: Array.from(prevRemote) });
  }

  if (added > 0 || removed > 0) {
    await saveProducts(local);
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('billmaker-products-updated', {
        detail: { added, removed },
      }));
    }
  }
  return { added, removed };
};

/** Optional: clear file manually */
export const clearProductsFile = async () => {
  try {
    await Filesystem.deleteFile({
      path: FILE_NAME,
      directory: APP_DIR,
    });
  } catch (e) {
    // ignore if not exists
  }
};

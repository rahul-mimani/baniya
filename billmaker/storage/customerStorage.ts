// src/storage/customerStorage.ts
import { Filesystem, Encoding } from '@capacitor/filesystem';
import { APP_DIR, initFile } from './paths';
import { pushDocMerge } from './sync';
import { log } from '../utils/diagnostics';

const FILE_NAME = 'customers.json';

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unnamed';

export const initCustomerStorage = async () => {
  await initFile(FILE_NAME, '[]');
};

export const getCustomers = async (): Promise<string[]> => {
  try {
    const result = await Filesystem.readFile({
      path: FILE_NAME,
      directory: APP_DIR,
      encoding: Encoding.UTF8,
    });
    const dataStr = typeof result.data === 'string' ? result.data : await result.data.text();
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
    console.error('Error reading customers:', error);
    return [];
  }
};

export const saveCustomers = async (customers: string[]) => {
  const jsonData = JSON.stringify(customers, null, 2);
  await Filesystem.writeFile({
    path: FILE_NAME,
    data: jsonData,
    directory: APP_DIR,
    encoding: Encoding.UTF8,
  });
};

/**
 * Bulk-add customer names. Used by the bills listener when replaying a remote
 * snapshot — dedupes across the input list and against the existing local
 * file in a single pass, then pushes ONLY the genuinely new names to
 * Firestore. Drastically cheaper than calling addCustomer in a loop (which
 * re-reads the file on every call).
 */
export const addCustomersBatch = async (names: string[]): Promise<void> => {
  if (!Array.isArray(names) || names.length === 0) return;

  // First in-memory dedupe of the input
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

  // No block-list gate on batch: names that arrive via the bills listener
  // (i.e., names that already appear in real bills) should always end up in
  // local customers.json — otherwise mobile autocomplete is empty for new
  // users. The resurrection-push protection lives at the addCustomer
  // single-name path which is fine since the bills listener now uses this
  // batch helper anyway; the single-name path is reserved for user-typed
  // entries on the bill creation screen.
  const allowed: string[] = trimmedInput;

  // One disk read
  const localCustomers = await getCustomers();
  const existingLower = new Set(localCustomers.map(c => String(c).toLowerCase()));

  // Anything in input that isn't already local
  const toAdd: string[] = [];
  for (const name of allowed) {
    if (!existingLower.has(name.toLowerCase())) {
      toAdd.push(name);
      existingLower.add(name.toLowerCase());
    }
  }
  if (toAdd.length === 0) return;

  // One disk write — local only. Phase B: mobile no longer writes
  // customers/<slug> to Firestore. The worker derives that collection from
  // bills.customerName after each bills sync (see auth-service/src/lib/derive.ts).
  await saveCustomers([...localCustomers, ...toAdd]);
};

export const addCustomer = async (name?: string) => {
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  // No block-list check here — if a mobile user explicitly types a customer
  // name on a new bill, we always accept it. Admin's visibility filter on the
  // portal side decides whether to surface it in the admin views. The block
  // list now only applies to applyRemoteCustomers (incoming-sync path),
  // preventing resurrection-push from a different device.
  const customers = await getCustomers();
  // avoid duplicates (case-insensitive). String() guards against any non-string entry slipping through.
  const exists = customers.some(c => String(c).toLowerCase() === trimmed.toLowerCase());
  if (exists) {
    // Already known locally — DO NOT re-push. Pushing on every bill replay
    // causes a write storm (one cloud write per bill per customer, even when
    // nothing changed), which blows through Spark plan quotas and triggers
    // continuous snapshot fires on the portal side.
    return;
  }
  customers.push(trimmed);
  await saveCustomers(customers);
  log('info', 'customers', `addCustomer (local-only) "${trimmed}" — total ${customers.length}`);
  // Phase B: no Firestore push. The worker auto-derives customers/<slug>
  // from bill.customerName after each bills sync. Other devices learn the
  // new name via Supabase Realtime within ~1-2s of the bill being written.
};

/**
 * Tracks the lowercased name set we saw in the previous remote snapshot.
 * Distinguishes a freshly-pushed local name (not in current remote because
 * the write hasn't round-tripped) from one deleted on another device (admin
 * archived → `customers/<slug>` removed). PERSISTED to disk via syncState so
 * it survives app restarts — otherwise the first snapshot after a fresh
 * launch can't recognize cross-device deletes.
 *
 * `null` means "we haven't loaded the persisted state yet". After load it's
 * always a Set (possibly empty on first ever launch).
 */
let lastRemoteCustomerNames: Set<string> | null = null;
let loadStatePromise: Promise<void> | null = null;
const ensureStateLoaded = async (): Promise<void> => {
  if (lastRemoteCustomerNames !== null) return;
  if (!loadStatePromise) {
    loadStatePromise = (async () => {
      const { getSyncState } = await import('./syncState');
      const s = await getSyncState();
      lastRemoteCustomerNames = new Set(s.customers || []);
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
 * Merge a remote customers snapshot into local customers.json:
 *   - Names in remote but not in local → added
 *   - (snapshot mode only) Names in local but no longer in remote (and were in
 *     the PREVIOUS remote snapshot) → removed (cross-device delete)
 *   - Names in local and never seen remotely → preserved (pending push)
 */
export const applyRemoteCustomers = async (
  docs: any[],
  opts: ApplyRemoteOptions = {},
): Promise<{ added: number; removed: number }> => {
  const mode = opts.mode ?? 'snapshot';
  await ensureStateLoaded();

  // BLOCK LIST GATE — pretend blocked names don't exist in remote either,
  // so they never get re-added to local. This handles the case where some
  // other device pushes the blocked name back to Firestore before its
  // tombstone has fully cleaned up.
  const { getBlockLists } = await import('./syncState');
  const block = await getBlockLists();
  const slugify = (s: string) =>
    s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  const remoteNames = new Set<string>();
  for (const d of docs) {
    const name = (d?.name || '').toString().trim();
    if (!name) continue;
    const lower = name.toLowerCase();
    if (block.customerNames.has(lower) || block.customerNames.has(slugify(name))) continue;
    remoteNames.add(lower);
  }

  const local = await getCustomers();
  const localLowerSet = new Set(local.map(c => c.toLowerCase()));
  const prevRemote = lastRemoteCustomerNames!; // ensureStateLoaded guarantees non-null

  let added = 0;
  let removed = 0;

  // 1. Add new remote names (skipping blocked)
  for (const d of docs) {
    const name = (d?.name || '').toString().trim();
    if (!name) continue;
    const lower = name.toLowerCase();
    if (block.customerNames.has(lower) || block.customerNames.has(slugify(name))) continue;
    if (!localLowerSet.has(lower)) {
      local.push(name);
      localLowerSet.add(lower);
      added++;
    }
  }

  if (mode === 'snapshot') {
    // Remove local names that were in the previous remote snapshot but are
    // gone now — that's an admin-side deletion.
    for (let i = local.length - 1; i >= 0; i--) {
      const lower = local[i].toLowerCase();
      if (prevRemote.has(lower) && !remoteNames.has(lower)) {
        local.splice(i, 1);
        removed++;
      }
    }
    lastRemoteCustomerNames = remoteNames;
    const { updateSyncState } = await import('./syncState');
    void updateSyncState({ customers: Array.from(remoteNames) });
  } else {
    // event mode: merge incoming names into prevRemote so the next snapshot
    // reconcile doesn't see them as "newly missing" and wrongly delete them.
    for (const n of remoteNames) prevRemote.add(n);
    const { updateSyncState } = await import('./syncState');
    void updateSyncState({ customers: Array.from(prevRemote) });
  }

  if (added > 0 || removed > 0) await saveCustomers(local);
  return { added, removed };
};

export const clearCustomersFile = async () => {
  try {
    await Filesystem.deleteFile({ path: FILE_NAME, directory: APP_DIR });
  } catch (e) {
    // ignore if doesn't exist
  }
};

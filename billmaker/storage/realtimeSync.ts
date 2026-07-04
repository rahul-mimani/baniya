// Supabase Realtime read channel for Baniya mobile (Phase B).
//
// Mobile READS via Supabase Realtime instead of Firestore subscriptions
// because (a) Firestore subscriptions re-deliver full snapshots on every
// reconnect (causing the 211-doc-per-reconnect cost we observed), and
// (b) Realtime is INCLUDED in Supabase Pro and doesn't count against
// Firestore quota. Mobile still uses the Firestore SDK for WRITES — that
// preserves offline cache, arrayUnion semantics, and the existing local-
// JSON-first architecture.
//
// Flow:
//   1. After Firebase Anonymous sign-in (existing app boot), call
//      startRealtimeSync(shopCode, handlers).
//   2. We exchange the Firebase ID token at /auth/realtime-token for a
//      15-minute Supabase JWT scoped to shop_code.
//   3. Initialize @supabase/supabase-js with the project anon key, then
//      override auth with the minted JWT via realtime.setAuth().
//   4. Subscribe to postgres_changes on `replica_documents` filtered by
//      shop_code. Each event routes to the appropriate local-save handler.
//   5. Auto-refresh the JWT ~2 min before expiry while connected.
//
// Token refresh + reconnect handling are best-effort — if anything fails
// we log and the next app foreground will retry from scratch.

import {
  createClient,
  type SupabaseClient,
  type RealtimeChannel,
  type RealtimePostgresChangesPayload,
} from '@supabase/supabase-js';
import { getAuth } from 'firebase/auth';
import { log } from '../utils/diagnostics';
import { getSyncState, updateSyncState } from './syncState';

// ---------------------------------------------------------------------------
// Config — auth-service URL. Set at build time with `VITE_AUTH_SERVICE_URL`
// (see .env.example). Empty when unset; realtime sync is disabled until
// configured.
// ---------------------------------------------------------------------------
const AUTH_SERVICE_URL: string =
  (import.meta as any).env?.VITE_AUTH_SERVICE_URL ||
  '';

// Refresh the realtime token this many seconds BEFORE it expires. Gives us a
// safety window so a transient failure doesn't drop us mid-session.
const REFRESH_LEAD_SECONDS = 120;

// Per-collection event handler signature. Receives the JSONB payload (the
// canonical doc shape we wrote to the replica) plus the event type and id.
// On DELETE the data is `old.data` (whatever the row was before deletion).
export type RealtimeEventType = 'INSERT' | 'UPDATE' | 'DELETE';

export interface RealtimeHandlers {
  onBill?:           (docId: string, data: any, type: RealtimeEventType) => Promise<void> | void;
  onProfile?:        (docId: string, data: any, type: RealtimeEventType) => Promise<void> | void;
  onBusinessMeta?:   (docId: string, data: any, type: RealtimeEventType) => Promise<void> | void;
  onCustomer?:       (docId: string, data: any, type: RealtimeEventType) => Promise<void> | void;
  onProduct?:        (docId: string, data: any, type: RealtimeEventType) => Promise<void> | void;
  onPortalDeletion?: (docId: string, data: any, type: RealtimeEventType) => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Module state. Held outside any class because the app initializes sync
// exactly once in App.tsx — we don't need multiple instances.
// ---------------------------------------------------------------------------
let supabase: SupabaseClient | null = null;
let channel: RealtimeChannel | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let currentShopCode: string | null = null;
let currentHandlers: RealtimeHandlers | null = null;

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Establish the Realtime connection. Idempotent — calling twice tears down
 * the previous channel first.
 */
export const startRealtimeSync = async (
  shopCode: string,
  handlers: RealtimeHandlers,
): Promise<void> => {
  if (!shopCode || typeof shopCode !== 'string') {
    log('warn', 'storage', 'startRealtimeSync: missing shop code');
    return;
  }

  // Tear down any existing channel before re-subscribing.
  await stopRealtimeSync();

  currentShopCode = shopCode;
  currentHandlers = handlers;

  try {
    const { token, expiresAt, supabaseUrl, supabaseAnonKey } = await fetchRealtimeToken(shopCode);

    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error('realtime-token response missing supabaseUrl or supabaseAnonKey');
    }

    supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      // Throttle to avoid blasting handlers during initial backfill.
      realtime: { params: { eventsPerSecond: 10 } },
    });

    // Override the default anon JWT with our scoped token.
    await supabase.realtime.setAuth(token);

    // Phase B/6: catch up on anything that changed while we were offline.
    // Runs BEFORE subscribing so the live stream picks up from a known
    // "current" cursor. If catchup fails we still subscribe — next foreground
    // will try again.
    try {
      await catchupSinceCursors(supabaseUrl, supabaseAnonKey, token, shopCode, handlers);
    } catch (err: any) {
      log('warn', 'storage', 'Realtime catchup failed (will re-attempt on next foreground)', err?.message);
    }

    channel = supabase
      .channel(`shop:${shopCode}`)
      .on(
        // The TS overload for postgres_changes is mistyped in older
        // @supabase/supabase-js — cast through to satisfy the compiler.
        'postgres_changes' as any,
        {
          event: '*',
          schema: 'public',
          table: 'replica_documents',
          filter: `shop_code=eq.${shopCode}`,
        },
        (payload: RealtimePostgresChangesPayload<any>) => {
          void dispatchEvent(payload);
        },
      )
      .subscribe(status => {
        if (status === 'SUBSCRIBED') {
          log('info', 'storage', `Realtime subscribed to shop:${shopCode}`);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          log('warn', 'storage', `Realtime channel ${status} — will retry on next foreground`);
        }
      });

    scheduleTokenRefresh(expiresAt);
  } catch (err: any) {
    const msg = err?.message || String(err);
    // Common dev/staging path: auth-service not reachable. Don't crash —
    // mobile still works for local data + Firestore writes via SDK. The
    // only thing that doesn't work is real-time cross-device read sync.
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      log('warn', 'storage',
        'Realtime disabled — auth-service unreachable. ' +
        (AUTH_SERVICE_URL
          ? `Check VITE_AUTH_SERVICE_URL (currently: ${AUTH_SERVICE_URL}). `
          : 'VITE_AUTH_SERVICE_URL is not configured. ') +
        'Mobile will run offline-only until reachable.');
    } else {
      log('error', 'storage', 'startRealtimeSync failed', msg);
    }
  }
};

/**
 * Disconnect cleanly. Called on logout or before re-subscribing.
 */
export const stopRealtimeSync = async (): Promise<void> => {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (channel) {
    try { await channel.unsubscribe(); } catch { /* ignore */ }
    channel = null;
  }
  if (supabase) {
    try { await supabase.removeAllChannels(); } catch { /* ignore */ }
    try { await supabase.realtime.disconnect(); } catch { /* ignore */ }
    supabase = null;
  }
};

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

interface RealtimeTokenResponse {
  token: string;
  expiresAt: number;       // unix seconds
  supabaseUrl: string;
  supabaseAnonKey: string;
}

const fetchRealtimeToken = async (shopCode: string): Promise<RealtimeTokenResponse> => {
  const auth = getAuth();
  const user = auth.currentUser;
  if (!user) throw new Error('Firebase user not signed in');
  const idToken = await user.getIdToken();

  const r = await fetch(`${AUTH_SERVICE_URL}/mobile/realtime-token`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ shop_code: shopCode }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`realtime-token ${r.status}: ${detail.slice(0, 200)}`);
  }
  return (await r.json()) as RealtimeTokenResponse;
};

const scheduleTokenRefresh = (expiresAt: number): void => {
  const nowSec = Math.floor(Date.now() / 1000);
  const refreshInSec = Math.max(30, expiresAt - nowSec - REFRESH_LEAD_SECONDS);
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    if (!currentShopCode || !supabase) return;
    try {
      const { token, expiresAt: nextExp } = await fetchRealtimeToken(currentShopCode);
      await supabase.realtime.setAuth(token);
      scheduleTokenRefresh(nextExp);
      log('info', 'storage', 'Realtime token refreshed');
    } catch (err: any) {
      log('warn', 'storage', 'Realtime token refresh failed — will retry in 60s', err?.message);
      // Quick retry; if it keeps failing we'll fall back at next app foreground.
      refreshTimer = setTimeout(() => scheduleTokenRefresh(Math.floor(Date.now() / 1000) + REFRESH_LEAD_SECONDS + 60), 60_000);
    }
  }, refreshInSec * 1000);
};

const dispatchEvent = async (
  payload: RealtimePostgresChangesPayload<any>,
): Promise<void> => {
  if (!currentHandlers) return;
  const eventType = payload.eventType as RealtimeEventType;
  // Use new row for INSERT/UPDATE, old row for DELETE.
  const row = (eventType === 'DELETE' ? payload.old : payload.new) as
    | { collection?: string; firestore_id?: string; data?: any; last_synced_at?: string }
    | null;
  if (!row || !row.collection || !row.firestore_id) return;

  const data = row.data ?? null;
  const id = row.firestore_id;

  log('info', 'realtime', `${eventType} ${row.collection}/${id}`);

  try {
    await routeEvent(row.collection, id, data, eventType);
    // Advance the cursor for this collection so reconnect catchup knows
    // where to resume. Only on success — if the handler threw we want to
    // re-process on next catchup.
    if (row.last_synced_at) {
      await advanceCursor(row.collection, row.last_synced_at);
    }
  } catch (err: any) {
    log('warn', 'realtime', `Handler for ${row.collection}/${id} threw: ${err?.message}`, err);
  }
};

const routeEvent = async (
  collection: string,
  id: string,
  data: any,
  eventType: RealtimeEventType,
): Promise<void> => {
  if (!currentHandlers) return;
  switch (collection) {
    case 'bills':
      await currentHandlers.onBill?.(id, data, eventType);
      break;
    case 'profiles':
      await currentHandlers.onProfile?.(id, data, eventType);
      break;
    case '_meta':
      await currentHandlers.onBusinessMeta?.(id, data, eventType);
      break;
    case 'customers':
      await currentHandlers.onCustomer?.(id, data, eventType);
      break;
    case 'products':
      await currentHandlers.onProduct?.(id, data, eventType);
      break;
    case 'portal_deletions':
      await currentHandlers.onPortalDeletion?.(id, data, eventType);
      break;
    default:
      // Other collections (portal_*) — not consumed by mobile yet.
      break;
  }
};

const advanceCursor = async (collection: string, lastSyncedAt: string): Promise<void> => {
  // Race-tolerant: read current, only write if new value is strictly later.
  // Multiple events fire close together — we don't need a lock since the
  // worst case is a redundant identical write to the JSON file.
  try {
    const s = await getSyncState();
    const cursors = { ...(s.realtimeCursors || {}) };
    if (!cursors[collection] || lastSyncedAt > cursors[collection]) {
      cursors[collection] = lastSyncedAt;
      await updateSyncState({ realtimeCursors: cursors });
    }
  } catch (err: any) {
    log('warn', 'storage', `advanceCursor(${collection}) failed: ${err?.message}`);
  }
};

// ---------------------------------------------------------------------------
// Catchup — fetch via PostgREST any rows that changed while we were offline.
// Runs once at startRealtimeSync(), before subscribing to live events.
//
// We REST-fetch (not Realtime) because Realtime only delivers events going
// forward from subscription time. Anything that changed while disconnected
// would otherwise be silently missed.
//
// FIRST-EVER CONNECTION: instead of skipping (the original Phase B design,
// which assumed mobile always had a pre-existing local backlog), we now
// fetch the FULL history for the shop. This handles fresh APK installs on
// shops with existing data — without it, the device would never see any
// pre-existing bills/customers/products until they're individually edited.
//
// SUBSEQUENT CONNECTIONS: same as before — only fetch deltas since the
// stored cursor. Pagination loops until the page is shorter than the limit.
// ---------------------------------------------------------------------------
const CATCHUP_COLLECTIONS = ['bills', 'profiles', '_meta', 'customers', 'products', 'portal_deletions'];
const CATCHUP_BATCH_LIMIT = 500;
const CATCHUP_EPOCH = '1970-01-01T00:00:00Z';

const catchupSinceCursors = async (
  supabaseUrl: string,
  supabaseAnonKey: string,
  token: string,
  shopCode: string,
  _handlers: RealtimeHandlers,
): Promise<void> => {
  const state = await getSyncState();
  const cursors = state.realtimeCursors || {};

  for (const collection of CATCHUP_COLLECTIONS) {
    const storedCursor = cursors[collection];
    const isFirstConnection = !storedCursor;
    let cursor = storedCursor || CATCHUP_EPOCH;

    if (isFirstConnection) {
      log('info', 'storage',
        `Catchup ${collection}: first connection — fetching full history from replica`);
    }

    let totalApplied = 0;
    // Page until we either drain the table or hit a short page (last page).
    // Hard safety cap at 100 pages × 500 = 50k docs per collection.
    for (let page = 0; page < 100; page++) {
      const url =
        `${supabaseUrl}/rest/v1/replica_documents` +
        `?shop_code=eq.${encodeURIComponent(shopCode)}` +
        `&collection=eq.${encodeURIComponent(collection)}` +
        `&last_synced_at=gt.${encodeURIComponent(cursor)}` +
        `&order=last_synced_at.asc` +
        `&limit=${CATCHUP_BATCH_LIMIT}` +
        `&select=firestore_id,data,last_synced_at`;

      const r = await fetch(url, {
        headers: {
          // PostgREST identifies the project via the anon key (publishable)
          // and the user identity via the Bearer JWT. Using the JWT as the
          // apikey fails with 401 — that took an embarrassing while to
          // figure out. Both headers are required.
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${token}`,
        },
      });
      if (!r.ok) {
        log('warn', 'storage', `Catchup ${collection} → ${r.status}`);
        break;
      }
      const rows = (await r.json().catch(() => [])) as Array<{
        firestore_id: string;
        data: any;
        last_synced_at: string;
      }>;

      if (rows.length === 0) break;

      let maxSeen = cursor;
      for (const row of rows) {
        try {
          // Treat as UPDATE — the local-save handlers are merge-friendly so
          // INSERT vs UPDATE distinction doesn't matter at the routing layer.
          await routeEvent(collection, row.firestore_id, row.data, 'UPDATE');
          if (row.last_synced_at > maxSeen) maxSeen = row.last_synced_at;
        } catch (err: any) {
          log('warn', 'storage', `Catchup ${collection} handler error: ${err?.message}`);
        }
      }
      cursor = maxSeen;
      totalApplied += rows.length;

      // Short page = no more rows. Stop paginating.
      if (rows.length < CATCHUP_BATCH_LIMIT) break;
    }

    if (totalApplied > 0) {
      log('info', 'storage',
        `Catchup ${collection}: applied ${totalApplied} doc(s)` +
        (isFirstConnection ? ' (first connection)' : ` since ${storedCursor}`));
    }
    cursors[collection] = cursor;
  }

  await updateSyncState({ realtimeCursors: cursors });
};

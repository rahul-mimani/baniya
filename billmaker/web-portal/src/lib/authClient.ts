// Portal-side auth client. Single source of truth for the current session +
// the API contract with the auth-service Worker.
//
// Storage choice: localStorage (so non-tech-savvy clients stay logged in for
// the full server-side JWT TTL — 30 days — without needing to re-OTP every
// time they close their browser). Mitigations:
//   - Token has an absolute expiry baked in (state.expiresAt); we drop it
//     locally as soon as that passes
//   - Server-side session table allows instant revocation via admin
//   - 401 from any endpoint clears local state
//   - Logout button explicitly clears localStorage

const AUTH_URL =
  (import.meta as any).env?.VITE_AUTH_SERVICE_URL ||
  'http://localhost:8787';

export interface AuthUser {
  id: string;
  identifier: string;
  name: string;
  role: 'client' | 'admin';
  shop_code: string;
  customer_id: string | null;
  class: string | null;
}

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  expiresAt: string | null;
}

const STORAGE_KEY = 'billmaker-portal-auth-v1';

// One-time migration: if anything is in the OLD sessionStorage slot from a
// previous version, move it to localStorage so users don't get logged out
// the first time they update.
try {
  const legacy = sessionStorage.getItem(STORAGE_KEY);
  if (legacy && !localStorage.getItem(STORAGE_KEY)) {
    localStorage.setItem(STORAGE_KEY, legacy);
  }
  sessionStorage.removeItem(STORAGE_KEY);
} catch { /* private browsing etc. */ }

const loadFromStorage = (): AuthState => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { token: null, user: null, expiresAt: null };
    const parsed = JSON.parse(raw);
    if (parsed?.expiresAt && new Date(parsed.expiresAt).getTime() < Date.now()) {
      localStorage.removeItem(STORAGE_KEY);
      return { token: null, user: null, expiresAt: null };
    }
    return parsed;
  } catch {
    return { token: null, user: null, expiresAt: null };
  }
};

let state: AuthState = loadFromStorage();
const listeners = new Set<(s: AuthState) => void>();

const persist = () => {
  try {
    if (state.token) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {}
};

const notify = () => {
  for (const fn of listeners) {
    try { fn({ ...state }); } catch {}
  }
};

export const getAuthState = (): AuthState => ({ ...state });

export const onAuthChange = (fn: (s: AuthState) => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

export const isAuthenticated = (): boolean =>
  !!state.token && !!state.user && !!state.expiresAt &&
  new Date(state.expiresAt).getTime() > Date.now();

export const currentUser = (): AuthUser | null => state.user;
export const isAdmin = (): boolean => state.user?.role === 'admin';

export interface LookupResult {
  found: boolean;
  name?: string;
  hasEmail: boolean;
  emailMasked?: string;
  adminContact: {
    email?: string;
    phone?: string;
    shopName?: string;
  };
}

export interface OtpRequestResult {
  prefix: string;
  ttlMinutes: number;
  emailMasked?: string;
  message: string;
}

/**
 * Look up an account by phone OR email. Used by the login UI to personalize
 * the next step ("Hello {name}, code sent to {emailMasked}") and to surface
 * the admin's contact info when an account has no usable email.
 */
export const lookupAccount = async (input: { phone?: string; email?: string }): Promise<LookupResult> => {
  const r = await fetch(`${AUTH_URL}/auth/lookup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(body.error || 'lookup_failed') as Error & { retryAfter?: number };
    if (body.retry_after) err.retryAfter = body.retry_after;
    throw err;
  }
  return body as LookupResult;
};

/** Request an OTP. Pass either phone (client) or email (admin). */
export const requestOtp = async (input: { phone?: string; email?: string }): Promise<OtpRequestResult> => {
  const r = await fetch(`${AUTH_URL}/auth/request-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(body.error || 'request_failed') as Error & { retryAfter?: number };
    if (body.retry_after) err.retryAfter = body.retry_after;
    throw err;
  }
  return {
    prefix: body.prefix,
    ttlMinutes: body.ttl_minutes,
    emailMasked: body.emailMasked,
    message: body.message,
  };
};

/** Verify an OTP. Pass phone OR email — must match what request-otp received. */
export const verifyOtp = async (input: { phone?: string; email?: string; otp: string }): Promise<AuthUser> => {
  const r = await fetch(`${AUTH_URL}/auth/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || 'verify_failed');
  state = { token: body.token, user: body.user, expiresAt: body.expires_at };
  persist();
  notify();
  return body.user;
};

export const logout = async (): Promise<void> => {
  const token = state.token;
  state = { token: null, user: null, expiresAt: null };
  persist();
  notify();
  // Clear the product cache so the next login fetches fresh from Firestore.
  // Without this, IndexedDB would persist stale products across logins.
  try {
    const { cacheClear } = await import('./productCache');
    await cacheClear();
  } catch {
    // best-effort — don't block logout
  }
  // Clear cached bill counts (total/acked) so the next login refetches.
  try {
    const { clearBillCounts } = await import('./billCounts');
    clearBillCounts();
  } catch {
    // best-effort
  }
  // Wipe the in-memory store (products/bills/payments/customers/etc.) so
  // the next session subscribes fresh. Otherwise mergePortalProductsSnapshot
  // would layer the new top-50 ON TOP of the previous session's full list,
  // showing more than 50 products after re-login.
  try {
    const { resetStore } = await import('../data/dummyData');
    resetStore();
  } catch {
    // best-effort
  }
  if (token) {
    // Fire-and-forget revoke
    try {
      await fetch(`${AUTH_URL}/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // ignore — local state already cleared
    }
  }
};

/**
 * fetch wrapper that automatically attaches the bearer token + handles
 * 401 by clearing the session. Use this for ALL calls to the auth service
 * (e.g. /admin/users CRUD).
 */
export const authedFetch = async (
  path: string,
  init: RequestInit = {},
): Promise<Response> => {
  if (!state.token) throw new Error('not_authenticated');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${state.token}`);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  const r = await fetch(`${AUTH_URL}${path}`, { ...init, headers });
  if (r.status === 401) {
    // Token rejected — clear local state
    state = { token: null, user: null, expiresAt: null };
    persist();
    notify();
  }
  return r;
};

/**
 * Validate the current token against the server. Returns false if invalid.
 *
 * Deduped + throttled. Multiple simultaneous callers (AuthGate has two
 * components on every authed route — outer + role-gate — and React
 * StrictMode doubles each mount in dev) share a single in-flight request
 * and a 5-second result cache. Without this, every page refresh fired
 * /auth/me 4 times.
 */
let validateInflight: Promise<boolean> | null = null;
let lastValidateAt = 0;
const VALIDATE_THROTTLE_MS = 5_000;

export const validateSession = async (): Promise<boolean> => {
  if (validateInflight) return validateInflight;
  if (!state.token) return false;
  if (Date.now() - lastValidateAt < VALIDATE_THROTTLE_MS) {
    // Recent successful check — trust the cached session.
    return true;
  }

  validateInflight = (async () => {
    try {
      const r = await authedFetch('/auth/me');
      if (!r.ok) return false;
      const body = await r.json();
      if (body.user) {
        // Only fire notify() if the user object actually changed. Identical
        // user object → no listener wakeups → no cache thrash downstream.
        const same = state.user && JSON.stringify(state.user) === JSON.stringify(body.user);
        state = { ...state, user: body.user };
        persist();
        if (!same) notify();
      }
      lastValidateAt = Date.now();
      return true;
    } catch {
      return false;
    } finally {
      validateInflight = null;
    }
  })();
  return validateInflight;
};

// Thin Supabase REST client. We use PostgREST directly via fetch so the Worker
// bundle stays tiny. service_role key is sent on every request — never reaches
// the browser.

import type { Env } from '../types';

const headers = (env: Env, extra: Record<string, string> = {}): HeadersInit => ({
  apikey: env.SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
  ...extra,
});

const url = (env: Env, path: string) => `${env.SUPABASE_URL}/rest/v1/${path}`;

const handle = async <T>(r: Response): Promise<T> => {
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Supabase ${r.status}: ${txt}`);
  }
  if (r.status === 204) return undefined as unknown as T;
  return (await r.json()) as T;
};

// ---------- Generic helpers ----------

export const selectOne = async <T>(
  env: Env,
  table: string,
  query: string,
): Promise<T | null> => {
  const r = await fetch(`${url(env, table)}?${query}&limit=1`, { headers: headers(env) });
  const rows = await handle<T[]>(r);
  return rows[0] ?? null;
};

export const select = async <T>(
  env: Env,
  table: string,
  query: string,
): Promise<T[]> =>
  handle<T[]>(await fetch(`${url(env, table)}?${query}`, { headers: headers(env) }));

export const insert = async <T>(env: Env, table: string, row: object): Promise<T> => {
  const r = await fetch(url(env, table), {
    method: 'POST',
    headers: headers(env, { Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  });
  const rows = await handle<T[]>(r);
  return rows[0];
};

export const upsert = async <T>(
  env: Env,
  table: string,
  row: object,
  onConflict?: string,
): Promise<T> => {
  const path = onConflict ? `${table}?on_conflict=${onConflict}` : table;
  const r = await fetch(url(env, path), {
    method: 'POST',
    headers: headers(env, {
      Prefer: 'return=representation,resolution=merge-duplicates',
    }),
    body: JSON.stringify(row),
  });
  const rows = await handle<T[]>(r);
  return rows[0];
};

export const update = async <T>(
  env: Env,
  table: string,
  filter: string,
  patch: object,
): Promise<T[]> => {
  const r = await fetch(`${url(env, table)}?${filter}`, {
    method: 'PATCH',
    headers: headers(env, { Prefer: 'return=representation' }),
    body: JSON.stringify(patch),
  });
  return handle<T[]>(r);
};

export const remove = async (env: Env, table: string, filter: string): Promise<void> => {
  const r = await fetch(`${url(env, table)}?${filter}`, {
    method: 'DELETE',
    headers: headers(env),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Supabase ${r.status}: ${txt}`);
  }
};

// ---------- Typed convenience ----------

export interface DbUser {
  id: string;
  identifier: string;
  identifier_type: 'email' | 'phone';
  name: string;
  role: 'client' | 'admin';
  shop_code: string;
  customer_id: string | null;
  class: string | null;
  active: boolean;
  created_at: string;
  last_login_at: string | null;
}

export interface DbOtpRequest {
  id: string;
  user_id: string | null;
  identifier: string;
  ip_address: string | null;
  otp_hash: string;
  prefix: string;
  expires_at: string;
  attempts: number;
  used: boolean;
  created_at: string;
}

export interface DbSession {
  id: string;
  user_id: string;
  token_jti: string;
  expires_at: string;
  created_at: string;
  last_used_at: string;
  user_agent: string | null;
  ip_address: string | null;
  revoked: boolean;
}

export const findUserByIdentifier = (env: Env, identifier: string) =>
  selectOne<DbUser>(env, 'users', `identifier=eq.${encodeURIComponent(identifier)}&active=eq.true`);

export const findUserById = (env: Env, id: string) =>
  selectOne<DbUser>(env, 'users', `id=eq.${id}`);

export const findSessionByJti = (env: Env, jti: string) =>
  selectOne<DbSession>(env, 'sessions', `token_jti=eq.${jti}&revoked=eq.false`);

export const insertOtpRequest = (env: Env, row: Partial<DbOtpRequest>) =>
  insert<DbOtpRequest>(env, 'otp_requests', row);

export const findPendingOtp = (env: Env, identifier: string) =>
  selectOne<DbOtpRequest>(
    env,
    'otp_requests',
    `identifier=eq.${encodeURIComponent(identifier)}&used=eq.false&expires_at=gt.${new Date().toISOString()}&order=created_at.desc`,
  );

export const incrementOtpAttempts = (env: Env, id: string, attempts: number) =>
  update<DbOtpRequest>(env, 'otp_requests', `id=eq.${id}`, { attempts });

export const markOtpUsed = (env: Env, id: string) =>
  update<DbOtpRequest>(env, 'otp_requests', `id=eq.${id}`, { used: true });

export const insertSession = (env: Env, row: Partial<DbSession>) =>
  insert<DbSession>(env, 'sessions', row);

export const revokeSession = (env: Env, jti: string) =>
  update<DbSession>(env, 'sessions', `token_jti=eq.${jti}`, { revoked: true });

export const touchSession = (env: Env, jti: string) =>
  update<DbSession>(env, 'sessions', `token_jti=eq.${jti}`, {
    last_used_at: new Date().toISOString(),
  });

export const updateUserLastLogin = (env: Env, id: string) =>
  update<DbUser>(env, 'users', `id=eq.${id}`, {
    last_login_at: new Date().toISOString(),
  });

export const upsertShop = (env: Env, code: string, name: string) =>
  upsert(env, 'shops', { code, name }, 'code');

export const countOtpRequestsSince = async (
  env: Env,
  col: 'identifier' | 'ip_address',
  value: string,
  sinceMs: number,
): Promise<number> => {
  const since = new Date(sinceMs).toISOString();
  const r = await fetch(
    `${url(env, 'otp_requests')}?${col}=eq.${encodeURIComponent(value)}&created_at=gt.${since}&select=id`,
    { headers: headers(env, { Prefer: 'count=exact' }) },
  );
  if (!r.ok) throw new Error(`Supabase count failed (${r.status})`);
  const range = r.headers.get('content-range') || '';
  const m = range.match(/\/(\d+|\*)$/);
  return m && m[1] !== '*' ? parseInt(m[1], 10) : 0;
};

/**
 * Sum of `attempts` across all otp_requests rows from this IP in the
 * given window. Used by the verify-otp rate limit — counts ACTUAL
 * verify attempts (not just OTP request creations).
 *
 * Each row in otp_requests has an `attempts` counter incremented on
 * each /auth/verify-otp call against that OTP. Summing across all the
 * IP's recent OTPs gives total verify attempts.
 */
export const sumOtpVerifyAttemptsSince = async (
  env: Env,
  ip: string,
  sinceMs: number,
): Promise<number> => {
  const since = new Date(sinceMs).toISOString();
  const r = await fetch(
    `${url(env, 'otp_requests')}?ip_address=eq.${encodeURIComponent(ip)}&created_at=gt.${since}&select=attempts`,
    { headers: headers(env) },
  );
  if (!r.ok) throw new Error(`Supabase sum failed (${r.status})`);
  const rows = await r.json() as Array<{ attempts: number | null }>;
  return rows.reduce((sum, row) => sum + (row.attempts || 0), 0);
};

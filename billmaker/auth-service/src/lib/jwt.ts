// JWT issue + verify. HS256 with the secret from env.

import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import type { Env, SessionClaims } from '../types';

const ALG = 'HS256';
const ISSUER = 'billmaker-auth';
const AUDIENCE = 'billmaker-portal';

const keyFor = (secret: string): Uint8Array => new TextEncoder().encode(secret);

export const signSession = async (
  env: Env,
  payload: Omit<SessionClaims, 'iat' | 'exp'>,
  ttlMinutes: number,
): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttlMinutes * 60;
  return await new SignJWT({ ...payload, iat: now, exp })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .sign(keyFor(env.JWT_SECRET));
};

export const verifySession = async (env: Env, token: string): Promise<SessionClaims> => {
  const { payload } = await jwtVerify(token, keyFor(env.JWT_SECRET), {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: [ALG],
  });
  return payload as unknown as SessionClaims;
};


// ---------------------------------------------------------------------------
// Supabase-compatible JWT for Realtime / PostgREST access from mobile.
//
// Supabase Realtime authenticates clients via a JWT signed with the project's
// JWT_SECRET (Settings → API → JWT Secret in the Supabase dashboard). The
// JWT carries `role` (mapped to a Postgres role) + custom claims accessible
// from RLS via `auth.jwt() ->> 'shop_code'`.
//
// We mint these ONLY on demand (when mobile calls /auth/realtime-token) and
// keep them short-lived (15 min) so a leaked token can't be replayed long.
// Mobile silently refreshes before expiry using its existing session JWT.
// ---------------------------------------------------------------------------
interface SupabaseRealtimeClaims {
  sub: string;          // user.id (same as session sub)
  role: 'authenticated';
  shop_code: string;    // custom claim — RLS reads via auth.jwt() ->> 'shop_code'
}

export const signSupabaseRealtime = async (
  env: Env,
  claims: SupabaseRealtimeClaims,
  ttlMinutes: number = 15,
): Promise<{ token: string; expiresAt: number }> => {
  if (!env.SUPABASE_JWT_SECRET) {
    throw new Error('SUPABASE_JWT_SECRET not configured');
  }
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttlMinutes * 60;
  const token = await new SignJWT({ ...claims, iat: now, exp })
    .setProtectedHeader({ alg: ALG })
    .sign(keyFor(env.SUPABASE_JWT_SECRET));
  return { token, expiresAt: exp };
};


// ---------------------------------------------------------------------------
// Firebase ID token verification.
//
// BillMaker mobile authenticates anonymously to Firebase (signInAnonymously).
// That gives it an ID token signed by Google with RS256, claims:
//   - iss: https://securetoken.google.com/<projectId>
//   - aud: <projectId>
//   - sub: Firebase UID
//   - firebase.sign_in_provider: 'anonymous'
//
// We verify this token before issuing a Supabase Realtime token. Proves the
// caller has the right Firebase config — without making them set up a new
// secret. Public keys are fetched from Google's JWKS endpoint and cached by
// jose's createRemoteJWKSet (refreshes every ~6 hours by default).
// ---------------------------------------------------------------------------
const FIREBASE_JWKS_URL = new URL(
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
);

// Module-level cache so we don't re-create the JWKS fetcher on every request.
// Cloudflare Workers reuse isolates → this lives across requests.
let firebaseJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export interface FirebaseIdTokenClaims {
  sub: string;            // Firebase UID
  aud: string;            // Firebase project ID
  iss: string;            // https://securetoken.google.com/<projectId>
  iat: number;
  exp: number;
  firebase?: {
    sign_in_provider?: string;  // 'anonymous' for our mobile app
    identities?: Record<string, unknown>;
  };
}

export const verifyFirebaseIdToken = async (
  env: Env,
  token: string,
): Promise<FirebaseIdTokenClaims> => {
  if (!env.FIREBASE_PROJECT_ID) {
    throw new Error('FIREBASE_PROJECT_ID not configured');
  }
  if (!firebaseJwks) {
    firebaseJwks = createRemoteJWKSet(FIREBASE_JWKS_URL);
  }
  const { payload } = await jwtVerify(token, firebaseJwks, {
    algorithms: ['RS256'],
    issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
    audience: env.FIREBASE_PROJECT_ID,
  });
  // jose already validates iss, aud, exp. We additionally require `sub`.
  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new Error('Firebase ID token missing sub claim');
  }
  return payload as unknown as FirebaseIdTokenClaims;
};

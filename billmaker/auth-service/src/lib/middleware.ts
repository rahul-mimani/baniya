// Cross-cutting middleware: CORS, log-redaction, JWT auth gate, role gate.

import type { Context, MiddlewareHandler } from 'hono';
import { verifySession } from './jwt';
import { findSessionByJti, findUserById, touchSession } from './db';
import type { Env, Variables, AuthedUser } from '../types';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

/** Resolve the client's IP behind Cloudflare. */
export const clientIp = (c: Ctx): string | null =>
  c.req.header('CF-Connecting-IP') ||
  c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
  null;

/** Strict CORS — only origins listed in ALLOWED_ORIGINS pass. */
export const cors: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const origin = c.req.header('Origin');
  const allowed = (c.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const isAllowed = origin && allowed.includes(origin);

  if (c.req.method === 'OPTIONS') {
    if (!isAllowed) return c.text('forbidden', 403);
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin!,
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers':
          'Authorization, Content-Type, X-Bootstrap-Secret',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      },
    });
  }
  await next();
  if (isAllowed) {
    c.res.headers.set('Access-Control-Allow-Origin', origin!);
    c.res.headers.set('Vary', 'Origin');
  }
};

/**
 * Replaces console.log so it can't accidentally print Authorization headers,
 * OTPs, JWTs, or other secrets. Runs once at Worker startup via setup().
 */
export const installLogRedaction = (): void => {
  const SECRET_PATTERNS: RegExp[] = [
    /eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+\.[A-Za-z0-9_.+/=-]+/g,           // JWT-ish
    /\bsk_[A-Za-z0-9_-]+/g,                                                 // generic secret keys
    /\bre_[A-Za-z0-9_-]+/g,                                                 // Resend
    /\b[A-Z2-9]{3}-[A-Z2-9]{4}\b/g,                                         // our OTP format
    /"otp"\s*:\s*"[^"]+"/g,                                                 // JSON otp field
    /Bearer\s+[A-Za-z0-9._-]+/gi,                                           // bearer tokens
  ];
  const redact = (v: unknown): unknown => {
    if (typeof v === 'string') {
      let out = v;
      for (const re of SECRET_PATTERNS) out = out.replace(re, '«redacted»');
      return out;
    }
    if (Array.isArray(v)) return v.map(redact);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as object)) {
        const sensitive = /token|secret|key|otp|password|authorization/i.test(k);
        o[k] = sensitive ? '«redacted»' : redact(val);
      }
      return o;
    }
    return v;
  };
  const wrap = (fn: (...args: unknown[]) => void) =>
    (...args: unknown[]) => fn(...args.map(redact));
  console.log = wrap(console.log.bind(console));
  console.warn = wrap(console.warn.bind(console));
  console.error = wrap(console.error.bind(console));
  console.info = wrap(console.info.bind(console));
};

/** Requires a valid JWT + non-revoked session. Populates c.var.user / .claims. */
export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (
  c,
  next,
) => {
  const auth = c.req.header('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return c.json({ error: 'missing_token' }, 401);

  let claims;
  try {
    claims = await verifySession(c.env, m[1]);
  } catch {
    return c.json({ error: 'invalid_token' }, 401);
  }

  const session = await findSessionByJti(c.env, claims.jti);
  if (!session) return c.json({ error: 'session_revoked' }, 401);
  if (new Date(session.expires_at).getTime() < Date.now()) {
    return c.json({ error: 'session_expired' }, 401);
  }

  const user = await findUserById(c.env, claims.sub);
  if (!user || !user.active) return c.json({ error: 'user_inactive' }, 401);

  // Touch session in background (don't block the request)
  c.executionCtx.waitUntil(touchSession(c.env, claims.jti).then(() => {}, () => {}));

  c.set('claims', claims);
  c.set('user', user as AuthedUser);
  return await next();
};

/** Requires authed user with role='admin'. Run AFTER requireAuth. */
export const requireAdmin: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (
  c,
  next,
) => {
  const user = c.get('user');
  if (!user || user.role !== 'admin') return c.json({ error: 'forbidden' }, 403);
  return await next();
};

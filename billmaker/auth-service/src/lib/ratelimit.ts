// Rate-limit derivation from otp_requests (no separate table needed).
// Two budgets enforced on `/auth/request-otp`:
//   1. per identifier per hour (defends one user's mailbox)
//   2. per IP per hour          (defends against bulk attackers / SMS bombing)

import { countOtpRequestsSince, sumOtpVerifyAttemptsSince } from './db';
import type { Env } from '../types';

const num = (s: string | undefined, d: number) => {
  const n = parseInt(s ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export interface RateLimitDecision {
  ok: boolean;
  retryAfterSeconds: number;
}

export const checkOtpRateLimit = async (
  env: Env,
  identifier: string,
  ip: string | null,
): Promise<RateLimitDecision> => {
  const perIdMax = num(env.RATE_LIMIT_PER_IDENTIFIER_PER_HOUR, 20);
  const perIpMax = num(env.RATE_LIMIT_PER_IP_PER_HOUR, 30);
  const windowMs = 60 * 60 * 1000;
  const sinceMs = Date.now() - windowMs;

  // Run in parallel
  const [idCount, ipCount] = await Promise.all([
    countOtpRequestsSince(env, 'identifier', identifier, sinceMs),
    ip ? countOtpRequestsSince(env, 'ip_address', ip, sinceMs) : Promise.resolve(0),
  ]);

  if (idCount >= perIdMax) {
    return { ok: false, retryAfterSeconds: 60 * 30 };
  }
  if (ip && ipCount >= perIpMax) {
    return { ok: false, retryAfterSeconds: 60 * 30 };
  }
  return { ok: true, retryAfterSeconds: 0 };
};

/**
 * Per-IP rate limit for /auth/verify-otp.
 *
 * Defends against brute-force OTP guessing across distributed OTPs.
 * Counter: SUM of `attempts` column across all otp_requests rows from
 * this IP in the last hour — i.e. total verify-otp calls (whether they
 * succeeded or failed). This is distinct from the OTP-request counter
 * (which counts how many OTPs were issued, not how many guesses made).
 *
 * Default cap: 5/hour. Tight enough to block brute-force, generous
 * enough that a legitimate user fat-fingering 1-2 OTPs still works.
 */
export const checkVerifyOtpRateLimit = async (
  env: Env,
  ip: string | null,
): Promise<RateLimitDecision> => {
  if (!ip) return { ok: true, retryAfterSeconds: 0 };
  const perIpMax = num(env.RATE_LIMIT_VERIFY_PER_IP_PER_HOUR, 5);
  const windowMs = 60 * 60 * 1000;
  const sinceMs = Date.now() - windowMs;
  const attempts = await sumOtpVerifyAttemptsSince(env, ip, sinceMs);
  if (attempts >= perIpMax) {
    return { ok: false, retryAfterSeconds: 60 * 30 };
  }
  return { ok: true, retryAfterSeconds: 0 };
};

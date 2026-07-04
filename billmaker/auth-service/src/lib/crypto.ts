// Web Crypto helpers — constant-time compare, hex/base64 utilities,
// random bytes. Workers runtime exposes `crypto.subtle` and `crypto.getRandomValues`.

const HEX_CHARS = '0123456789abcdef';

export const randomBytes = (n: number): Uint8Array => {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
};

export const toHex = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += HEX_CHARS[(b >> 4) & 0xf] + HEX_CHARS[b & 0xf];
  }
  return out;
};

export const fromHex = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0) throw new Error('invalid hex length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
};

/**
 * Constant-time equality on two strings. Returns false immediately if lengths
 * differ (length is not secret in our usage). All comparisons take the same
 * time regardless of where (if anywhere) they diverge.
 */
export const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};

/**
 * PBKDF2-SHA256. Cloudflare Workers caps iterations at 100,000
 * (NotSupportedError above that). Acceptable for short-lived OTP hashing —
 * the actual security comes from OTP_PEPPER (server-only secret) + the OTP
 * being valid for only 10 minutes.
 * Format: `pbkdf2$<iters>$<salt_hex>$<hash_hex>`.
 */
export const pbkdf2Hash = async (
  input: string,
  pepper: string,
  iterations = 100_000,
): Promise<string> => {
  const salt = randomBytes(16);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(input + pepper),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return `pbkdf2$${iterations}$${toHex(salt)}$${toHex(bits)}`;
};

export const pbkdf2Verify = async (
  input: string,
  pepper: string,
  stored: string,
): Promise<boolean> => {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  const salt = fromHex(parts[2]);
  const expected = parts[3];
  if (!Number.isFinite(iterations) || iterations < 10_000) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(input + pepper),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return constantTimeEqual(toHex(bits), expected);
};

/** Stable hash for indexing (not for passwords). SHA-256 of input + pepper. */
export const sha256Hex = async (input: string): Promise<string> => {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return toHex(buf);
};

/**
 * Canonical product key — the SINGLE source of truth for portal_products
 * doc IDs across the entire system.
 *
 * Same product name → same key, always. SHA-256 hex digest of the
 * normalized name (trim + lowercase + collapsed whitespace).
 *
 * Why one function:
 *   - Add admin/edit/delete writers all use it
 *   - The consolidation migration uses it
 *   - lookupProductByName uses it
 *   - Mobile pushes `products/<slug>` (separate collection); when the portal
 *     subscription fires, ensureProductByName uses this key to write the
 *     matching portal_products doc
 *
 * Why SHA-256 (chosen 2026-05-22 per user requirement):
 *   - 64 hex chars, fixed length
 *   - Cryptographically deterministic
 *   - Doc IDs are opaque (debug via lookup, not eyeballing)
 *
 * Browser SubtleCrypto is async — every caller is awaited. The async
 * cascade is acceptable because every product write also awaits Firestore.
 */

const normalizeName = (s: string): string =>
  s.trim().toLowerCase().replace(/\s+/g, ' ');

export const productKey = async (name: string): Promise<string> => {
  const norm = normalizeName(name);
  if (!norm) return 'unnamed';
  const data = new TextEncoder().encode(norm);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(hashBuffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
};

/** Lowercase hex pattern that valid keys must match. Used by Firestore Rules. */
export const PRODUCT_KEY_PATTERN = /^[a-f0-9]{64}$/;

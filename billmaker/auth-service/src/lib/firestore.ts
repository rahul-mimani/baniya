// Firestore REST client for the Cloudflare Worker.
//
// We don't use the Firebase Admin SDK — it's Node-specific and doesn't run in
// Workers. Instead we hit Google's REST API directly:
//
//   1. Build a JWT signed with the service account private key (RS256).
//   2. Exchange that JWT at https://oauth2.googleapis.com/token for an OAuth2
//      access token (valid 1 hour, scope = datastore).
//   3. Call https://firestore.googleapis.com/v1/projects/<proj>/databases/(default)/documents/<path>
//      with `Authorization: Bearer <access_token>`.
//
// Tokens are cached in module scope across requests within the same Worker
// instance — saves the JWT/OAuth round-trip on every Firestore call.

import type { Env } from '../types';

// ---------------------------------------------------------------------------
// Base64URL helpers (Workers have atob/btoa but not base64url natively).
// ---------------------------------------------------------------------------
const base64urlFromBytes = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
};

const base64urlFromString = (s: string): string => base64urlFromBytes(new TextEncoder().encode(s));


// ---------------------------------------------------------------------------
// PEM private key → CryptoKey (RSA-PKCS8 → RSASSA-PKCS1-v1_5 with SHA-256).
// The private_key field in the service account JSON is PEM-encoded PKCS#8.
// In .env it's a single line with literal `\n` escapes — re-expand them first.
// ---------------------------------------------------------------------------
const pemToArrayBuffer = (pem: string): ArrayBuffer => {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

let cachedSigningKey: CryptoKey | null = null;
let cachedSigningKeyFingerprint: string | null = null;

const getSigningKey = async (privateKeyPem: string): Promise<CryptoKey> => {
  // If the same PEM was used last time, reuse the imported CryptoKey.
  const fp = privateKeyPem.length + ':' + privateKeyPem.slice(0, 64);
  if (cachedSigningKey && cachedSigningKeyFingerprint === fp) return cachedSigningKey;

  const expanded = privateKeyPem.replace(/\\n/g, '\n');
  const buf = pemToArrayBuffer(expanded);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    buf,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  cachedSigningKey = key;
  cachedSigningKeyFingerprint = fp;
  return key;
};


// ---------------------------------------------------------------------------
// OAuth2 access token. Google's token endpoint returns a 1-hour token in
// exchange for a signed JWT assertion. We cache the token until ~5 minutes
// before it expires.
// ---------------------------------------------------------------------------
interface TokenCacheEntry {
  token: string;
  expiresAt: number; // unix seconds
}
let cachedToken: TokenCacheEntry | null = null;

// We request both datastore (Firestore reads) AND monitoring.read so the same
// OAuth token works for the time-series API used by /admin/usage charts.
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/datastore',
  'https://www.googleapis.com/auth/monitoring.read',
].join(' ');

const buildGoogleJwtAssertion = async (env: Env): Promise<string> => {
  if (!env.FIREBASE_CLIENT_EMAIL) throw new Error('FIREBASE_CLIENT_EMAIL missing');
  if (!env.FIREBASE_PRIVATE_KEY) throw new Error('FIREBASE_PRIVATE_KEY missing');

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: GOOGLE_SCOPES,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const signingInput = `${base64urlFromString(JSON.stringify(header))}.${base64urlFromString(JSON.stringify(claims))}`;
  const key = await getSigningKey(env.FIREBASE_PRIVATE_KEY);
  const sigBuf = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64urlFromBytes(new Uint8Array(sigBuf))}`;
};

export const getAccessToken = async (env: Env): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - 300 > now) {
    return cachedToken.token;
  }

  const assertion = await buildGoogleJwtAssertion(env);
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Google token exchange failed (${r.status}): ${detail}`);
  }
  const data = await r.json() as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: now + data.expires_in,
  };
  return data.access_token;
};


// ---------------------------------------------------------------------------
// Firestore value unwrapping.
//
// REST API responses wrap every field in a type discriminator object like
// `{stringValue: "foo"}` or `{arrayValue: {values: [...]}}`. Convert that into
// the plain JS object you'd get from the JS SDK.
// ---------------------------------------------------------------------------
type FirestoreValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { nullValue: null }
  | { timestampValue: string }
  | { bytesValue: string }
  | { referenceValue: string }
  | { geoPointValue: { latitude: number; longitude: number } }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } };

export const unwrapValue = (v: FirestoreValue | undefined | null): any => {
  if (v === undefined || v === null) return null;
  const obj = v as any;
  if ('stringValue' in obj) return obj.stringValue;
  if ('integerValue' in obj) return Number(obj.integerValue);
  if ('doubleValue' in obj) return obj.doubleValue;
  if ('booleanValue' in obj) return obj.booleanValue;
  if ('nullValue' in obj) return null;
  if ('timestampValue' in obj) return obj.timestampValue;       // ISO string
  if ('bytesValue' in obj) return obj.bytesValue;               // base64
  if ('referenceValue' in obj) return obj.referenceValue;
  if ('geoPointValue' in obj) return obj.geoPointValue;
  if ('arrayValue' in obj) {
    const values = obj.arrayValue?.values || [];
    return values.map(unwrapValue);
  }
  if ('mapValue' in obj) return unwrapFields(obj.mapValue?.fields || {});
  return null;
};

export const unwrapFields = (fields: Record<string, FirestoreValue>): Record<string, any> => {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = unwrapValue(v);
  return out;
};


// ---------------------------------------------------------------------------
// Document fetch helpers.
// ---------------------------------------------------------------------------
export interface FirestoreDoc {
  /** The document id (last segment of the resource name). */
  id: string;
  /** Plain JS object with all fields unwrapped. */
  data: Record<string, any>;
  /** ISO timestamp string. */
  createTime: string;
  /** ISO timestamp string. */
  updateTime: string;
}

interface ListResponse {
  documents?: Array<{
    name: string;
    fields?: Record<string, FirestoreValue>;
    createTime: string;
    updateTime: string;
  }>;
  nextPageToken?: string;
}

const baseUrl = (env: Env): string => {
  if (!env.FIREBASE_PROJECT_ID) throw new Error('FIREBASE_PROJECT_ID missing');
  return `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
};

const idFromName = (name: string): string => name.slice(name.lastIndexOf('/') + 1);


/**
 * List all documents in a collection. Handles pagination internally — returns
 * all docs in one array. For our scale (a few thousand docs per collection at
 * most) this is fine in a single cron run.
 *
 * @param collectionPath  Path WITHOUT the leading `projects/.../documents/`,
 *                        e.g. `shops/your-shop-code/bills`.
 */
export const listAllDocuments = async (
  env: Env,
  collectionPath: string,
): Promise<FirestoreDoc[]> => {
  const token = await getAccessToken(env);
  const out: FirestoreDoc[] = [];
  let pageToken: string | undefined;

  // Safety cap — we don't expect anywhere near 10k docs/collection. If we hit
  // this, something is wrong; throw rather than loop forever.
  for (let page = 0; page < 100; page++) {
    const url = new URL(`${baseUrl(env)}/${collectionPath}`);
    url.searchParams.set('pageSize', '300');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const r = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      // 404 on a collection path means "no docs yet" — that's fine.
      if (r.status === 404) return out;
      throw new Error(`Firestore list ${collectionPath} failed (${r.status}): ${detail}`);
    }
    const body = await r.json() as ListResponse;
    for (const doc of body.documents || []) {
      out.push({
        id: idFromName(doc.name),
        data: unwrapFields(doc.fields || {}),
        createTime: doc.createTime,
        updateTime: doc.updateTime,
      });
    }
    pageToken = body.nextPageToken;
    if (!pageToken) return out;
  }
  throw new Error(`Firestore list ${collectionPath}: exceeded 100 pages — aborting`);
};


/**
 * Incremental query: returns docs in the named collection whose cursor field
 * is strictly greater than `since`. Uses Firestore's :runQuery REST endpoint
 * with a structured query.
 *
 * The cursor field is configurable per collection (see COLLECTION_CURSOR in
 * lib/sync.ts):
 *   - default `lastModified` of type Timestamp — written by portal
 *     serverTimestamp() and by the mobile lastModified wrapper.
 *   - bills use `updatedAt` of type string (ISO 8601) — mobile writes that
 *     instead, and ISO strings sort lex == chrono.
 *
 * Cursor-based pagination: we don't use nextPageToken (runQuery doesn't return
 * one). Instead, after each page we filter `field > <last seen value>` for the
 * next page. Server-side ordering on `field ASC` keeps the traversal stable.
 *
 * IMPORTANT: orderBy on a field excludes any doc that lacks that field. Docs
 * without the cursor field are picked up by the daily reconcile pass
 * (listAllDocuments) instead.
 *
 * @param parentPath  Document path that is the parent of the target collection,
 *                    e.g. `shops/your-shop-code`. May be the empty string.
 * @param collectionId  The collection name under the parent, e.g. `bills`.
 * @param since  ISO lower bound (exclusive).
 * @param field  Field name to use as cursor. Defaults to `lastModified`.
 * @param valueType  How to encode `since` in the Firestore query: as a
 *                   `timestampValue` (default) or `stringValue`.
 */
export const queryDocsModifiedSince = async (
  env: Env,
  parentPath: string,
  collectionId: string,
  since: string,
  field: string = 'lastModified',
  valueType: 'timestamp' | 'string' = 'timestamp',
): Promise<FirestoreDoc[]> => {
  const token = await getAccessToken(env);
  const out: FirestoreDoc[] = [];
  const pageSize = 300;
  let cursor: string = since;

  const url = parentPath
    ? `${baseUrl(env)}/${parentPath}:runQuery`
    : `${baseUrl(env)}:runQuery`;

  const encodeCursor = (v: string): FirestoreValue =>
    valueType === 'string'
      ? { stringValue: v }
      : { timestampValue: v };

  for (let page = 0; page < 100; page++) {
    const body = {
      structuredQuery: {
        from: [{ collectionId }],
        where: {
          fieldFilter: {
            field: { fieldPath: field },
            op: 'GREATER_THAN',
            value: encodeCursor(cursor),
          },
        },
        orderBy: [
          { field: { fieldPath: field }, direction: 'ASCENDING' },
        ],
        limit: pageSize,
      },
    };

    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      if (r.status === 404) return out;
      throw new Error(`Firestore runQuery ${collectionId} failed (${r.status}): ${detail}`);
    }

    const results = await r.json() as Array<{
      document?: {
        name: string;
        fields?: Record<string, FirestoreValue>;
        createTime: string;
        updateTime: string;
      };
      readTime: string;
    }>;

    const pageDocs: FirestoreDoc[] = [];
    for (const row of results) {
      if (!row.document) continue;
      pageDocs.push({
        id: idFromName(row.document.name),
        data: unwrapFields(row.document.fields || {}),
        createTime: row.document.createTime,
        updateTime: row.document.updateTime,
      });
    }

    out.push(...pageDocs);

    if (pageDocs.length < pageSize) return out;

    const lastVal = pageDocs[pageDocs.length - 1].data[field];
    if (typeof lastVal !== 'string') return out;
    cursor = lastVal;
  }
  throw new Error(`Firestore runQuery ${collectionId}: exceeded 100 pages`);
};


/**
 * Query a collection for docs where `field == value`. Used by the targeted
 * upsert paths where we need to fetch related docs by foreign key (e.g. all
 * payments for a specific bill). Returns ALL matching docs in one go.
 *
 * Cost: 1 query + N reads where N = matching doc count. For payments per bill
 * that's typically 0-5 reads.
 *
 * @param parentPath e.g. `shops/your-shop-code`
 * @param collectionId e.g. `payments`
 * @param field doc field name to match against, e.g. `billId`
 * @param value field value to match (string only — extend if you need other types)
 */
export const queryDocsByField = async (
  env: Env,
  parentPath: string,
  collectionId: string,
  field: string,
  value: string,
): Promise<FirestoreDoc[]> => {
  const token = await getAccessToken(env);
  const out: FirestoreDoc[] = [];
  const pageSize = 300;

  const url = parentPath
    ? `${baseUrl(env)}/${parentPath}:runQuery`
    : `${baseUrl(env)}:runQuery`;

  // Single query — for our scale (0-50 payments per bill) one page is plenty.
  const body = {
    structuredQuery: {
      from: [{ collectionId }],
      where: {
        fieldFilter: {
          field: { fieldPath: field },
          op: 'EQUAL',
          value: { stringValue: value },
        },
      },
      limit: pageSize,
    },
  };

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    if (r.status === 404) return out;
    throw new Error(`Firestore runQuery ${collectionId} by ${field} failed (${r.status}): ${detail}`);
  }

  const results = await r.json() as Array<{
    document?: {
      name: string;
      fields?: Record<string, FirestoreValue>;
      createTime: string;
      updateTime: string;
    };
    readTime: string;
  }>;

  for (const row of results) {
    if (!row.document) continue;
    out.push({
      id: idFromName(row.document.name),
      data: unwrapFields(row.document.fields || {}),
      createTime: row.document.createTime,
      updateTime: row.document.updateTime,
    });
  }
  return out;
};


/**
 * Fetch a single document. Returns null if not found.
 * @param docPath Path like `shops/your-shop-code/_meta/business`.
 */
export const getDocument = async (env: Env, docPath: string): Promise<FirestoreDoc | null> => {
  const token = await getAccessToken(env);
  const r = await fetch(`${baseUrl(env)}/${docPath}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.status === 404) return null;
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Firestore get ${docPath} failed (${r.status}): ${detail}`);
  }
  const doc = await r.json() as {
    name: string;
    fields?: Record<string, FirestoreValue>;
    createTime: string;
    updateTime: string;
  };
  return {
    id: idFromName(doc.name),
    data: unwrapFields(doc.fields || {}),
    createTime: doc.createTime,
    updateTime: doc.updateTime,
  };
};


// ---------------------------------------------------------------------------
// Write side — wrap JS values into Firestore value envelopes and PATCH a doc.
// ---------------------------------------------------------------------------

/**
 * Wrap a plain JS value in the Firestore REST `{<type>Value: ...}` shape.
 * Integer-vs-double heuristic: whole numbers go as integerValue (which
 * Firestore types as int64), fractional as doubleValue. If you need to force
 * double, pass a non-integer (e.g. multiply by 1.0001) — usually not needed.
 */
const wrapValue = (v: any): FirestoreValue => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return { integerValue: String(v) };
    return { doubleValue: v };
  }
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(wrapValue) } };
  }
  if (typeof v === 'object') {
    return { mapValue: { fields: wrapFields(v) } };
  }
  // Fallback — anything else becomes a string.
  return { stringValue: String(v) };
};

const wrapFields = (obj: Record<string, any>): Record<string, FirestoreValue> => {
  const out: Record<string, FirestoreValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = wrapValue(v);
  }
  return out;
};


/**
 * Upsert a document at `docPath`. Replaces the doc entirely with `data`
 * (no merge — pass the full shape you want). Creates the doc if missing.
 * Uses Firestore REST PATCH without an updateMask (= full replace).
 *
 * @param docPath e.g. `shops/your-shop-code/_meta/admin_aggregates`
 * @param data    plain JS object (no Firestore-typed values)
 */
export const setDocument = async (
  env: Env,
  docPath: string,
  data: Record<string, any>,
): Promise<void> => {
  const token = await getAccessToken(env);
  const url = `${baseUrl(env)}/${docPath}`;
  const body = { fields: wrapFields(data) };

  const r = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Firestore PATCH ${docPath} failed (${r.status}): ${detail}`);
  }
};


/**
 * Create a Firestore doc ONLY IF it doesn't already exist.
 *
 * Uses Firestore REST `:commit` with the `currentDocument.exists: false`
 * precondition. If the doc exists, the write fails server-side with a
 * `FAILED_PRECONDITION` and we return `false`. If the write succeeds, we
 * return `true` (newly created).
 *
 * Authoritative — checks Firestore directly, NOT the Supabase replica. The
 * replica can lag behind worker writes by up to 15 min (next portal cron
 * tick), so replica-based existence checks falsely report "missing" for
 * docs we created in a previous run, leading to:
 *   (a) repeated writes that overwrite admin-set fields (e.g.,
 *       portal_products.prices that the admin manually filled in), and
 *   (b) over-counting in admin_aggregates when paired with an increment
 *       that should only fire on first creation.
 *
 * Used by deriveFromBills to safely auto-create customers/products without
 * stepping on subsequent admin edits.
 */
export const createDocumentIfMissing = async (
  env: Env,
  docPath: string,
  data: Record<string, any>,
): Promise<boolean> => {
  const fields = Object.keys(data);
  if (fields.length === 0) return false;
  const token = await getAccessToken(env);
  const docName = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${docPath}`;
  const url = `${baseUrl(env)}:commit`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      writes: [{
        update: { name: docName, fields: wrapFields(data) },
        updateMask: { fieldPaths: fields },
        currentDocument: { exists: false },
      }],
    }),
  });
  if (r.ok) return true;
  const detail = await r.text().catch(() => '');
  // Firestore returns:
  //   - 409 ALREADY_EXISTS for the exists:false precondition failure
  //   - 400 FAILED_PRECONDITION in some legacy/edge configurations
  // Either means the doc already exists — that's a normal "not created"
  // outcome, not an error. Any other non-2xx is a real failure.
  if (
    (r.status === 409) ||
    (r.status === 400 && (
      detail.includes('FAILED_PRECONDITION') ||
      detail.includes('already exists') ||
      detail.includes('Document already exists')
    ))
  ) {
    return false;
  }
  throw new Error(`Firestore commit ${docPath} failed (${r.status}): ${detail.slice(0, 200)}`);
};


/**
 * Batch create-if-missing — same semantics as createDocumentIfMissing
 * but for MANY docs in a SINGLE Firestore subrequest via `:batchWrite`.
 *
 * Why this exists: createDocumentIfMissing costs 1 subrequest per call.
 * deriveFromBills loops over N unique names → N subrequests. With 25+
 * unique names per batch (a shop with many distinct products) this blows
 * past the free-tier 50-subrequest cap.
 *
 * batchWrite supports up to 500 writes per call. Each write carries its
 * own `currentDocument.exists: false` precondition. The endpoint is
 * NON-atomic: per-write status is reported, mismatches don't fail other
 * writes.
 *
 * Returns an array parallel to `entries` indicating which were newly
 * created (true), which already existed (false), and which threw (Error).
 * The caller uses the `created` count for aggregate increments.
 *
 * Cost: 1 subrequest per call (up to 500 docs). Caller should chunk if
 * needed — derive's typical batch is well under 500.
 */
export const batchCreateIfMissing = async (
  env: Env,
  entries: Array<{ docPath: string; data: Record<string, any> }>,
): Promise<Array<boolean | Error>> => {
  if (entries.length === 0) return [];

  const token = await getAccessToken(env);
  const url = `${baseUrl(env)}:batchWrite`;

  const writes = entries.map(e => ({
    update: {
      name: `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${e.docPath}`,
      fields: wrapFields(e.data),
    },
    updateMask: { fieldPaths: Object.keys(e.data) },
    currentDocument: { exists: false },
  }));

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ writes }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Firestore batchWrite failed (${r.status}): ${detail.slice(0, 200)}`);
  }

  // batchWrite response shape:
  //   { writeResults: [...], status: [{code: 0|6|..., message: ?}] }
  // code 0 = OK (created), code 6 = ALREADY_EXISTS (precondition fail), other = error
  const body = await r.json() as {
    writeResults?: Array<unknown>;
    status?: Array<{ code?: number; message?: string }>;
  };

  const statuses = body.status || [];
  return entries.map((_, i) => {
    const s = statuses[i];
    if (!s || s.code === undefined || s.code === 0) return true;   // created
    if (s.code === 6) return false;                                 // already exists (FAILED_PRECONDITION)
    return new Error(`batchWrite[${i}] code=${s.code} ${s.message || ''}`);
  });
};


/**
 * Atomic field increments via Firestore REST `:commit` with `updateTransforms`.
 *
 * Mirrors Firestore client SDK `increment()` — works even if the doc doesn't
 * exist (the doc is created with each field initialized to the delta). Used by
 * the worker to maintain admin_aggregates + portal_customers.outstanding
 * post-Phase B, matching the portal's existing patchAdminAggregates pattern.
 *
 * @param docPath e.g. `shops/your-shop-code/_meta/admin_aggregates`
 * @param numericDeltas record of fieldPath → delta. Skipped if delta is 0.
 * @param fieldsToSet optional plain-value fields to set in the same write
 *                    (e.g. `lastRecomputedAt`). Uses an updateMask so only
 *                    these fields are touched (everything else preserved).
 */
export const incrementDocumentFields = async (
  env: Env,
  docPath: string,
  numericDeltas: Record<string, number>,
  fieldsToSet?: Record<string, any>,
): Promise<void> => {
  // Filter out zero/NaN deltas so we don't emit no-op transforms.
  const transforms = Object.entries(numericDeltas)
    .filter(([, v]) => typeof v === 'number' && isFinite(v) && v !== 0)
    .map(([fieldPath, v]) => ({
      fieldPath,
      // doubleValue handles both ints and decimals correctly; Firestore
      // upcasts an integer field to double on increment, but for our
      // mixed-numeric aggregate fields that's fine.
      increment: { doubleValue: v },
    }));
  if (transforms.length === 0 && !fieldsToSet) return;

  // CRITICAL: never fall back to setDocument here. setDocument is a full
  // doc replace — calling it with just `{lastRecomputedAt, shopCode}` would
  // wipe every other field (customerCount, productCount, dealCount, etc.).
  // The :commit endpoint below correctly does a partial update via
  // updateMask regardless of whether transforms is empty.

  const token = await getAccessToken(env);
  const docName = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${docPath}`;
  const url = `${baseUrl(env)}:commit`;

  const write: any = {};
  if (transforms.length > 0) write.updateTransforms = transforms;
  if (fieldsToSet && Object.keys(fieldsToSet).length > 0) {
    write.update = {
      name: docName,
      fields: wrapFields(fieldsToSet),
    };
    write.updateMask = { fieldPaths: Object.keys(fieldsToSet) };
  } else {
    // updateTransforms alone needs the document name carried somewhere —
    // Firestore REST requires either `update.name` or `transform.document`.
    // We use a minimal update with empty fields + empty mask so the doc
    // path is identified.
    write.update = { name: docName, fields: {} };
    write.updateMask = { fieldPaths: [] };
  }

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ writes: [write] }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Firestore commit increment ${docPath} failed (${r.status}): ${detail.slice(0, 200)}`);
  }
};


/** For tests / manual debugging — drops cached state. */
export const __resetFirestoreCache = (): void => {
  cachedToken = null;
  cachedSigningKey = null;
  cachedSigningKeyFingerprint = null;
};

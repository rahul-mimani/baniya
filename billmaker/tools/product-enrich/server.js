// Local web tool: enrich portal_products with descriptions + images via web search.
//
// Run with `npm start` — opens on http://localhost:3000.
// Uses Tavily Search API (single key, free 1000/mo) which returns text
// snippets AND image URLs in one call. Operator picks/edits before saving.

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Env + Firebase init
// ---------------------------------------------------------------------------
const SHOP_CODE = process.env.SHOP_CODE || 'your-shop-code';
const PORT = parseInt(process.env.PORT || '3000', 10);
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

// Optional domain bias for web search. Comma-separated list via
// SEARCH_INCLUDE_DOMAINS (e.g. "example.com,another.com"). When unset the
// list is empty, meaning a general (unbiased) web search.
const SEARCH_INCLUDE_DOMAINS = (process.env.SEARCH_INCLUDE_DOMAINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!TAVILY_API_KEY) {
  console.error('✗ Missing TAVILY_API_KEY in .env');
  console.error('  Sign up at https://tavily.com (free, 1000 searches/month).');
  process.exit(1);
}

const loadServiceAccount = () => {
  // Preferred: drop a `prod.json` (or `serviceAccount.json`) next to server.js.
  // The file is gitignored so it never leaks into version control.
  const localCandidates = [
    path.join(__dirname, 'prod.json'),
    path.join(__dirname, 'serviceAccount.json'),
  ];
  for (const p of localCandidates) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, 'utf8');
        console.log(`✓ Loaded Firebase service account from ${path.basename(p)}`);
        return JSON.parse(raw);
      } catch (err) {
        console.error(`✗ Could not parse ${p}:`, err.message);
        process.exit(1);
      }
    }
  }
  // Fallback: env-based config for CI / shared dev setups.
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch (err) {
      console.error('✗ FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON:', err.message);
      process.exit(1);
    }
  }
  if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    try {
      const raw = readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      console.error(`✗ Could not read ${process.env.FIREBASE_SERVICE_ACCOUNT_PATH}:`, err.message);
      process.exit(1);
    }
  }
  console.error('✗ No Firebase credentials found.');
  console.error('  Drop a `prod.json` (or `serviceAccount.json`) next to server.js, or');
  console.error('  set FIREBASE_SERVICE_ACCOUNT_PATH / FIREBASE_SERVICE_ACCOUNT_JSON in .env.');
  process.exit(1);
};

const serviceAccount = loadServiceAccount();
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

console.log(`✓ Firebase initialized for project ${serviceAccount.project_id}`);
console.log(`✓ Targeting shop: ${SHOP_CODE}`);

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Tiny logger so the operator can see what's happening.
app.use((req, _res, next) => {
  if (req.path.startsWith('/api/')) {
    console.log(`→ ${req.method} ${req.path}`);
  }
  next();
});

// ---------------------------------------------------------------------------
// GET /api/products — list portal_products (paginated)
// ---------------------------------------------------------------------------
app.get('/api/products', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '15', 10), 50);
  const startAfter = req.query.startAfter || null;

  try {
    let q = db
      .collection('shops')
      .doc(SHOP_CODE)
      .collection('portal_products')
      .orderBy('name', 'asc')
      .limit(limit);

    if (startAfter) {
      q = q.startAfter(startAfter);
    }

    const snap = await q.get();
    const products = snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    const lastName = products.length ? products[products.length - 1].name : null;
    res.json({
      products,
      hasMore: products.length === limit,
      nextCursor: lastName,
    });
  } catch (err) {
    console.error('list products failed:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/search — Tavily web search (text snippets + images in one call).
// Body: { query: "Stainless Steel Water Bottle 750ml" }
// Returns: { snippets: [...], images: [...] }
//
// Tavily is an AI-friendly search API: a single POST returns curated
// web results PLUS image URLs. No Custom Search Engine setup, no
// separate text/image queries, just one API call per product.
// Cost: 1 search = 1 credit. Free tier = 1000 credits/month.
// ---------------------------------------------------------------------------
app.post('/api/search', async (req, res) => {
  const query = (req.body?.query || '').trim();
  if (!query) return res.status(400).json({ error: 'query required' });

  try {
    const resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        include_images: true,
        include_answer: false,
        max_results: 8,
        // Optional/configurable domain bias via SEARCH_INCLUDE_DOMAINS.
        // Empty by default = general web search (no bias).
        include_domains: SEARCH_INCLUDE_DOMAINS,
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      console.warn('tavily error:', data);
      return res.status(resp.status).json({ error: data?.detail || data?.error || `tavily ${resp.status}` });
    }

    // Tavily response shape:
    //   { results: [{title, url, content, score}], images: [string urls] }
    const snippets = (data.results || []).map(item => ({
      title: item.title,
      snippet: item.content,        // Tavily's `content` is the snippet text
      link: item.url,
      displayLink: hostnameOf(item.url),
    }));

    // Tavily returns image URLs as plain strings; we don't get width/mime.
    const images = (data.images || []).map(url => ({
      url,
      thumbnail: url,                // no separate thumbnail — use the URL directly
      width: undefined,
      height: undefined,
      mime: undefined,
    }));

    res.json({ snippets, images });
  } catch (err) {
    console.error('search failed:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

const hostnameOf = (url) => {
  try { return new URL(url).hostname; } catch { return url; }
};

// ---------------------------------------------------------------------------
// POST /api/save — save approved description + images back to Firestore.
// Body: { productId: "abc123", description: "...", images: ["url1", "url2"] }
// ---------------------------------------------------------------------------
app.post('/api/save', async (req, res) => {
  const { productId, description, images } = req.body || {};
  if (!productId) return res.status(400).json({ error: 'productId required' });

  try {
    const docRef = db
      .collection('shops')
      .doc(SHOP_CODE)
      .collection('portal_products')
      .doc(productId);

    const patch = {
      lastModified: FieldValue.serverTimestamp(),
      updatedAt: new Date().toISOString(),
    };
    if (typeof description === 'string') patch.description = description;
    if (Array.isArray(images)) patch.images = images.filter(u => typeof u === 'string' && u.length);

    await docRef.set(patch, { merge: true });
    console.log(`  ✓ saved ${productId} (${(patch.images || []).length} images, desc=${(patch.description || '').length} chars)`);
    res.json({ ok: true });
  } catch (err) {
    console.error('save failed:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\n→ Open http://localhost:${PORT} in your browser\n`);
});

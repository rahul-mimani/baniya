# Product Enrichment Tool

Local web tool to enrich `portal_products` in Firestore with descriptions + images. Uses **Tavily Search API** (AI-friendly search) — one API key, returns text snippets and image URLs in a single call. You curate before saving.

## Setup (≤ 2 minutes)

### 1. Install dependencies

```bash
cd tools/product-enrich
npm install
```

### 2. Drop in the two files

**(a) Firebase service account** — same JSON your `auth-service` already uses.

Just drop the file as `prod.json` next to `server.js`:
```bash
cp ~/Downloads/your-firebase-service-account.json tools/product-enrich/prod.json
```

The tool auto-detects it. (Alternative names `serviceAccount.json` also works.)
The file is in `.gitignore` so it'll never get committed.

**(b) Tavily API key**
- Sign up at <https://tavily.com> (Google login, no card needed)
- Copy your API key from the dashboard
- Free tier: 1000 searches/month

### 3. `.env` (just one real key needed)

```bash
cp .env.example .env
# Edit .env — only TAVILY_API_KEY is required.
# SHOP_CODE falls back to `your-shop-code` if you don't set it.
```

### 4. Run

```bash
npm start
```

Opens on <http://localhost:3000>.

## Usage

1. Browser shows 15 portal_products at a time, ordered by name.
2. Status pills show what each product currently has: `desc` / `no desc`, `N img` / `no img`.
3. Click a product to expand. You see:
   - Description textarea (pre-filled with existing)
   - Selected images strip
   - Manual URL paste input (for images you find elsewhere)
4. Click **🔍 Search web for "&lt;name&gt;"** — Tavily returns:
   - **Text snippets**: click any one to append it to the description
   - **Image grid**: click thumbnails to toggle in/out of the selected list
5. Edit description as needed.
6. Click **💾 Approve & Save to Firestore** — merge-writes `description` + `images[]` to that product. Other fields untouched.

## Quota math

- **1 search = 1 Tavily credit**
- Free tier = **1000 credits/month**
- So you can enrich up to 1000 distinct products per month for free (one search each)
- Each "Search web" press is one credit, regardless of how many results come back

## What this writes to Firestore

`shops/<SHOP_CODE>/portal_products/<docId>` gets merge-updated with:
```js
{
  description: "...",      // string from textarea
  images: ["url1", ...],   // array of selected URLs
  updatedAt: "<ISO>",      // bumped on every save
  lastModified: <Timestamp> // bumped on every save (worker sync cursor)
}
```

Other fields (`prices`, `enabledClasses`, `visibleToClient`, etc.) are NEVER touched.

## Switching shops

Edit `SHOP_CODE` in `.env`, restart. Defaults to `your-shop-code` if unset.

## Search behavior

By default the tool runs a general (unbiased) web search. If you want to bias
results toward specific sources for your product catalog, set the optional
`SEARCH_INCLUDE_DOMAINS` env var to a comma-separated list of domains:

```bash
# Optional example — bias search toward these domains only
SEARCH_INCLUDE_DOMAINS=example.com,another-store.com
```

When `SEARCH_INCLUDE_DOMAINS` is empty (the default), no domain bias is applied
and results come from the broader web.

## Troubleshooting

| Error | Meaning |
|---|---|
| "Missing TAVILY_API_KEY" | Set it in `.env` |
| "No Firebase credentials found" | Make sure `prod.json` is in `tools/product-enrich/` next to `server.js` |
| "Could not parse prod.json" | The file isn't valid JSON — make sure you downloaded a real service-account key |
| Image tiles look transparent | Remote site blocking hotlink. Image still saves by URL — works wherever that source allows |
| "tavily 401" | Bad API key — get a fresh one |
| "tavily 429" | Hit your monthly quota — wait until reset or upgrade |
| Page shows empty | Check `SHOP_CODE` matches an actual shop and `portal_products` has data |

## Privacy / security

- Runs ONLY on your local machine
- Firebase service account stays in `.env` (never sent to the browser)
- Tavily API key only used server-side
- The only network calls leaving your machine are: Firestore reads/writes + Tavily search queries

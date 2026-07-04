# Admin Portal — Diagnostic Snippets

Paste these into the browser DevTools Console (Cmd+Opt+J) on the **admin portal**
to inspect state, detect bugs, and verify fixes. All snippets are read-only
unless marked otherwise.

> **First-time paste warning?** Chrome's self-XSS guard blocks pasting into the
> console on a domain you've never pasted into. Type `allow pasting` and hit
> Enter to bypass (per-session unlock).

---

## 1. Sanity check — store state at a glance

```js
console.log({
  customers: __billmakerStore.customers.length,
  products: __billmakerStore.products.length,
  bills: __billmakerStore.bills.length,
  payments: __billmakerStore.payments.length,
  labels: __billmakerStore.labels.length,
  classDefs: __billmakerStore.classDefs.length,
  deals: __billmakerStore.deals.length,
});
```

What you'd want to see: counts that roughly match Firebase Console totals. A
mismatch usually means the persistent cache hasn't fully synced or a
subscription is windowed (portal_products is intentionally capped at top-50).

---

## 2. Find phantom (duplicate) products

Detects products with the same normalized name. Shows which one would be
"kept" vs "deleted" by the cleanup tool in Settings → Maintenance.

```js
(() => {
  const norm = s => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const score = p => {
    const priceCount = Object.values(p.prices || {}).filter(v => Number(v) > 0).length;
    return (p.description?.length ? 10 : 0)
      + priceCount * 5
      + (p.images?.length || 0) * 3
      + (p.labelIds?.length || 0) * 2;
  };
  const groups = new Map();
  for (const p of __billmakerStore.products) {
    const k = norm(p.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const toDelete = [];
  for (const [, group] of groups) {
    if (group.length < 2) continue;
    group.sort((a, b) => score(b) - score(a));
    for (const phantom of group.slice(1)) {
      toDelete.push({
        doc_id: phantom.id,
        name: phantom.name,
        score: score(phantom),
        keeper_id: group[0].id,
      });
    }
  }
  console.log(`Phantoms to delete: ${toDelete.length}`);
  console.table(toDelete);
  window.__phantomIds = toDelete.map(p => p.doc_id);
  console.log('IDs saved to window.__phantomIds — copy with: copy(__phantomIds)');
})();
```

---

## 3. Products created TODAY (catches regression of the phantom-loop bug)

```js
(() => {
  const norm = s => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const todayMs = startOfDay.getTime();
  const idTime = id => { const m = String(id).match(/^p-(\d+)-/); return m ? Number(m[1]) : 0; };
  const todaysProducts = __billmakerStore.products.filter(p => idTime(p.id) >= todayMs);
  const allByNorm = new Map();
  for (const p of __billmakerStore.products) {
    const k = norm(p.name);
    if (!allByNorm.has(k)) allByNorm.set(k, []);
    allByNorm.get(k).push(p);
  }
  const rows = todaysProducts.map(p => {
    const peers = (allByNorm.get(norm(p.name)) || []).filter(o => o.id !== p.id);
    return {
      name: p.name,
      id: p.id,
      has_pre_existing_peer: peers.length > 0,
      peer_name: peers[0]?.name || '(none — new product)',
    };
  });
  console.log(`Products created today: ${todaysProducts.length}`);
  console.table(rows);
})();
```

If `has_pre_existing_peer: true` with `peer_name === name` (exact match), the
phantom-loop bug is happening. Run the cleanup in Settings → Maintenance to
fix.

---

## 4. Verify normalization works on case/whitespace variants

Picks the first product in your catalog and tests that common variants of its
name all match via `normalizeProductName`. Useful after deploying the fix to
confirm the change took effect.

```js
const s = __billmakerStore;
const norm = __billmakerNormalizeProductName;
const target = s.products[0]?.name;
const variants = [
  target.toUpperCase(),
  target.toLowerCase(),
  '  ' + target + '  ',
  target.replace(/ /g, '  '),
];
console.log('Target:', JSON.stringify(target));
for (const v of variants) {
  const matched = s.products.some(p => norm(p.name) === norm(v));
  console.log(matched ? '✅' : '❌', JSON.stringify(v), '→', norm(v));
}
```

All four should print `✅`. If any prints `❌`, normalization is broken or
the variant is genuinely outside what we collapse for.

---

## 5. Inspect a customer's bills + linkage state

```js
const targetEmail = 'someone@example.com';
const c = __billmakerStore.customers.find(
  x => x.email?.toLowerCase() === targetEmail.toLowerCase(),
);
if (!c) { console.log('Customer not found'); }
else {
  const bills = __billmakerStore.bills.filter(b => b.customerId === c.id);
  const linkedRaws = __billmakerStore.rawCustomers.filter(r => r.linkedCustomerId === c.id);
  console.log('Customer:', c);
  console.log(`Bills: ${bills.length}`);
  console.log('Linked raw names:', linkedRaws.map(r => ({
    name: r.rawName, manuallyUnlinked: r.manuallyUnlinked,
  })));
  const total = bills.reduce((s, b) => s + (Number(b.total) || 0), 0);
  const paid = bills.reduce((s, b) => s + (Number(b.paid) || 0), 0);
  console.log({ total, paid, outstanding: total - paid });
}
```

---

## 6. Trigger a worker sync manually (admin only)

Useful after running cleanup, to push deletions to Supabase immediately instead
of waiting for the next cron.

```js
const jwt = Object.values(localStorage).find(v =>
  typeof v === 'string' && v.startsWith('ey') && v.split('.').length === 3,
);
fetch('/admin/sync/trigger/portal_products?mode=reconcile', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + jwt },
}).then(r => r.json()).then(console.log);
```

To reconcile `products` collection too:

```js
const jwt = Object.values(localStorage).find(v =>
  typeof v === 'string' && v.startsWith('ey') && v.split('.').length === 3,
);
fetch('/admin/sync/trigger/products?mode=reconcile', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + jwt },
}).then(r => r.json()).then(console.log);
```

---

## 7. Bulk delete products by ID (power-user — destructive)

For when you need to surgically remove specific products without using the
cleanup UI. Same helper the cleanup tool uses; with the slug-deletion fix it
also removes matching `products/<slug>` docs.

```js
// Replace with the IDs you want gone
const targetIds = [
  'p-1779344661638-4r5e7',
  'p-1779344661638-ersw8',
];
await __billmakerBulkDeleteProducts(targetIds, (d, t) => console.log(`${d}/${t}`));
```

---

## 8. Force a fresh data fetch (bypass persistent cache for one query)

Useful to see what's actually in Firestore right now, ignoring local cache.

```js
const { getDocs, collection, getFirestore, query, orderBy, limit } = await import('firebase/firestore');
const apps = (await import('firebase/app')).getApps();
const db = getFirestore(apps.find(a => a.name === 'billmaker-portal-firestore'));
const shop = JSON.parse(localStorage.getItem('billmaker-portal-config-v1') || '{}').shopCode;
const snap = await getDocs(query(
  collection(db, `shops/${shop}/products`),
  orderBy('updatedAt', 'desc'),
  limit(60),
));
const names = snap.docs.map(d => d.data().name);
const norm = s => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const portalNorms = new Set(__billmakerStore.products.map(p => norm(p.name)));
const orphans = names.filter(n => !portalNorms.has(norm(n)));
console.log(`Top-60 most-recently-updated slug docs in Firestore:`);
console.table(snap.docs.slice(0, 30).map(d => ({
  slug: d.id, name: d.data().name, updatedAt: d.data().updatedAt,
})));
console.log(`Of those, ${orphans.length} have names that do NOT match any current portal product.`);
console.table(orphans.map(n => ({ name: n })));
```

If `orphans.length > 0`, those slug docs are loop drivers — they'd spawn
phantoms on cold load. Run cleanup (with the slug-deletion fix deployed) to
nuke them.

---

## 9. Detect Firestore cache issues (when the bug should be fixed but isn't)

```js
// What does each subscription think the last-applied state was?
console.log('Last remote IDs (subscription delete-detection state):');
// This relies on a debug exposure that may not exist; fallback shows store
try {
  console.log(window.__billmakerLastRemoteIds);
} catch {}
console.log('Current store sizes:', {
  products: __billmakerStore.products.length,
  customers: __billmakerStore.customers.length,
  bills: __billmakerStore.bills.length,
});
console.log('IndexedDB Firestore present:',
  await indexedDB.databases().then(dbs =>
    dbs.find(d => d.name?.includes('firestore'))?.name || 'NONE',
  ));
```

If IndexedDB Firestore is missing or empty, the persistent cache failed to
initialize — every reload is a cold fetch (~2000 Firestore reads). Check the
console for the warning `initializeFirestore with persistent cache failed`.

---

## 10. Find duplicate / stale `customers/<slug>` docs in Firestore

Similar to the products slug story but for customers. Run only if you see
strange customer reconciliation behavior.

```js
const { getDocs, collection, getFirestore } = await import('firebase/firestore');
const apps = (await import('firebase/app')).getApps();
const db = getFirestore(apps.find(a => a.name === 'billmaker-portal-firestore'));
const shop = JSON.parse(localStorage.getItem('billmaker-portal-config-v1') || '{}').shopCode;
const snap = await getDocs(collection(db, `shops/${shop}/customers`));
const norm = s => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const portalCustomerNames = new Set(__billmakerStore.customers.map(c => norm(c.name)));
const orphans = [];
for (const d of snap.docs) {
  const name = d.data().name;
  if (!portalCustomerNames.has(norm(name))) {
    // Check if it's a raw customer name from bills (legitimate) or an orphan
    const matchesBill = __billmakerStore.bills.some(b => norm(b.customerName) === norm(name));
    orphans.push({ slug: d.id, name, in_bills: matchesBill });
  }
}
console.log(`customers/<slug> docs not in current portal customer list:`);
console.table(orphans);
```

---

## When to reach out

If any snippet returns unexpected results (errors thrown, counts that don't
make sense, ghosts that won't die), grab the output and ping the team. Most
debugging is faster with this data in hand than starting from "something looks
weird in the dashboard".

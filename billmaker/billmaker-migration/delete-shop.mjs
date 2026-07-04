 import { initializeApp, cert } from 'firebase-admin/app';
  import { getFirestore } from 'firebase-admin/firestore';
  import { readFileSync } from 'fs';

  // Provide your own Firebase service-account JSON (gitignored) via SA, and the
  // shop code to WIPE via SHOP. This permanently deletes all data under that shop.
  const SA = process.env.SA || './sa.json';
  const SHOP = process.env.SHOP;
  if (!SHOP) { console.error('Set SHOP env var (the shop code to delete)'); process.exit(1); }

  const COLLECTIONS = [
    'bills', 'payments', 'profiles', 'customers', 'products', '_meta',
    'portal_customers', 'portal_products', 'portal_labels',
    'portal_classes', 'portal_deals', 'portal_bills_meta',
  ];

  initializeApp({ credential: cert(JSON.parse(readFileSync(SA, 'utf8'))) });
  const db = getFirestore();

  for (const col of COLLECTIONS) {
    const snap = await db.collection(`shops/${SHOP}/${col}`).get();
    if (snap.size === 0) { console.log(`  ${col}: 0`); continue; }
    let i = 0;
    while (i < snap.docs.length) {
      const batch = db.batch();
      for (const doc of snap.docs.slice(i, i + 400)) batch.delete(doc.ref);
      await batch.commit();
      i += 400;
    }
    console.log(`  ${col}: deleted ${snap.size}`);
  }
  console.log('done');
  process.exit(0);
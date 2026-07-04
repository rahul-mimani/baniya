  import { initializeApp, cert } from 'firebase-admin/app';
  import { getFirestore } from 'firebase-admin/firestore';
  import { readFileSync } from 'fs';

  // Provide your own Firebase service-account JSON files (gitignored) and the
  // source/dest shop codes via env vars. See README.md in this folder.
  const SRC_SA = process.env.SRC_SA || './source-sa.json';
  const DST_SA = process.env.DST_SA || './dest-sa.json';
  const SOURCE_SHOP = process.env.SOURCE_SHOP;
  const DEST_SHOP = process.env.DEST_SHOP;
  if (!SOURCE_SHOP || !DEST_SHOP) {
    console.error('Set SOURCE_SHOP and DEST_SHOP env vars (the shop codes to copy between).');
    process.exit(1);
  }

  const COLLECTIONS = [
    'bills', 'payments', 'profiles',
    'customers', 'products', '_meta',
    'portal_customers', 'portal_products', 'portal_labels',
    'portal_classes', 'portal_deals', 'portal_bills_meta',
  ];

  console.log(`Source: ${SRC_SA} → shops/${SOURCE_SHOP}/`);
  console.log(`Dest:   ${DST_SA} → shops/${DEST_SHOP}/`);
  console.log('-'.repeat(60));

  const srcApp = initializeApp(
    { credential: cert(JSON.parse(readFileSync(SRC_SA, 'utf8'))) },
    'src',
  );
  const dstApp = initializeApp(
    { credential: cert(JSON.parse(readFileSync(DST_SA, 'utf8'))) },
    'dst',
  );

  const srcDb = getFirestore(srcApp);
  const dstDb = getFirestore(dstApp);

  let total = 0;
  const start = Date.now();

  for (const col of COLLECTIONS) {
    const snap = await srcDb.collection(`shops/${SOURCE_SHOP}/${col}`).get();
    if (snap.size === 0) {
      console.log(`  ${col.padEnd(22)} 0 docs`);
      continue;
    }
    const BATCH = 400;
    let i = 0;
    while (i < snap.docs.length) {
      const batch = dstDb.batch();
      for (const doc of snap.docs.slice(i, i + BATCH)) {
        batch.set(
          dstDb.doc(`shops/${DEST_SHOP}/${col}/${doc.id}`),
          doc.data(),
        );
      }
      await batch.commit();
      i += BATCH;
    }
    console.log(`  ${col.padEnd(22)} ${snap.size} docs ✓`);
    total += snap.size;
  }

  console.log('-'.repeat(60));
  console.log(`Total: ${total} docs in ${Math.round((Date.now() - start) / 1000)}s`);
  process.exit(0);
# billmaker-migration

Optional Firebase admin utilities for moving or wiping a shop's Firestore data.
These use the **Firebase Admin SDK**, so they require a service-account JSON with
full read/write/delete access. **Handle those keys carefully — never commit them**
(this folder's `.gitignore` blocks `*-sa.json` / `sa.json`).

> ⚠️ These are power tools. `delete-shop.mjs` **permanently deletes** data. Test
> against a throwaway project first.

## Setup

```bash
cd billmaker-migration
npm install
```

Get a service-account key from **Firebase Console → Project settings → Service
accounts → Generate new private key** for each project involved, and save the
JSON files in this folder (they'll be gitignored).

## Clone one shop's data from one Firebase project to another

```bash
SRC_SA=./source-sa.json \
DST_SA=./dest-sa.json \
SOURCE_SHOP=your-source-shop-code \
DEST_SHOP=your-dest-shop-code \
node clone-firebase-cross-project.mjs
```
Copies all collections under `shops/<SOURCE_SHOP>/` in the source project to
`shops/<DEST_SHOP>/` in the destination project.

## Delete all data for a shop (destructive)

```bash
SA=./sa.json SHOP=your-shop-code node delete-shop.mjs
```
Deletes every document under `shops/<SHOP>/` in the project the key belongs to.

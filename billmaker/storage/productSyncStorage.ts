// Stores the product-sync URL + the last successful sync timestamp.
// Phase 4 made settings JSON-only, so the URL is sourced from the imported
// settings JSON (productSync.url) — this file caches the same value
// locally so the Settings tab can show it without re-importing.

import { Filesystem, Encoding } from '@capacitor/filesystem';
import { APP_DIR, initFile } from './paths';

const FILE_NAME = 'product_sync_config.json';

export interface ProductSyncConfig {
  url: string;
  lastSyncedAt?: string; // ISO of last DOWN sync (URL → local)
  lastPublishedAt?: string; // ISO of last UP publish (local → URL)
  lastResult?: {
    added: number;
    total: number;
  };
}

const EMPTY: ProductSyncConfig = { url: '' };

export const initProductSyncStorage = async () => {
  await initFile(FILE_NAME, JSON.stringify(EMPTY));
};

export const getProductSyncConfig = async (): Promise<ProductSyncConfig> => {
  try {
    const result = await Filesystem.readFile({
      path: FILE_NAME,
      directory: APP_DIR,
      encoding: Encoding.UTF8,
    });
    const dataStr = typeof result.data === 'string' ? result.data : await result.data.text();
    return { ...EMPTY, ...JSON.parse(dataStr) };
  } catch {
    return EMPTY;
  }
};

export const saveProductSyncConfig = async (cfg: ProductSyncConfig): Promise<void> => {
  await Filesystem.writeFile({
    path: FILE_NAME,
    data: JSON.stringify(cfg, null, 2),
    directory: APP_DIR,
    encoding: Encoding.UTF8,
  });
};

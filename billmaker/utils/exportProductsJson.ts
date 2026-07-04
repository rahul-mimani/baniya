// Export the device's product catalogue as a JSON array of strings ready
// to drop into the GitHub-hosted products.json file. The local list is
// already the Firestore-synced view (the realtime listener keeps it in
// sync), so reading from disk is equivalent to a fresh Firestore pull —
// without needing a second auth-token round-trip.

import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { FileOpener } from '@capacitor-community/file-opener';
import { EXPORT_DIR } from '../storage/paths';
import { getProducts } from '../storage/productStorage';

export interface ExportProductsResult {
  count: number;
  fileName: string;
  uri: string;
  /** 'downloads' = public Downloads folder; 'app-external' = fallback. */
  location: 'downloads' | 'app-external';
}

export const exportProductsAsJson = async (): Promise<ExportProductsResult> => {
  const products = await getProducts();
  // Alphabetical so the GitHub diff stays stable across exports.
  const sorted = [...products].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
  const payload = JSON.stringify(sorted, null, 2);
  const fileName = 'products.json';

  // Try public Downloads first so the user can find the file in the Files
  // app under Downloads. Scoped storage on Android 11+ may refuse the
  // write — fall back to the app-private external dir which always works.
  try {
    const path = `Download/${fileName}`;
    await Filesystem.writeFile({
      path,
      data: payload,
      directory: Directory.ExternalStorage,
      encoding: Encoding.UTF8,
    });
    const { uri } = await Filesystem.getUri({
      path,
      directory: Directory.ExternalStorage,
    });
    return { count: sorted.length, fileName, uri, location: 'downloads' };
  } catch {
    await Filesystem.writeFile({
      path: fileName,
      data: payload,
      directory: EXPORT_DIR,
      encoding: Encoding.UTF8,
    });
    const { uri } = await Filesystem.getUri({ path: fileName, directory: EXPORT_DIR });
    return { count: sorted.length, fileName, uri, location: 'app-external' };
  }
};

export const openExportedProducts = async (uri: string) => {
  await FileOpener.open({ filePath: uri, contentType: 'application/json' });
};

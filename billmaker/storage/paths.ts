import { Directory, Filesystem, Encoding } from '@capacitor/filesystem';

/** Where working app data lives. App-private internal storage — no Android permission required. */
export const APP_DIR: Directory = Directory.Data;

/** Where exported backup files / PDFs go. App-private external storage — visible via USB at /Android/data/<pkg>/files/. */
export const EXPORT_DIR: Directory = Directory.External;

/** Older builds wrote everything here. We read from this only to migrate. */
export const LEGACY_DIR: Directory = Directory.Documents;

/**
 * Ensures `fileName` exists in APP_DIR. If missing, attempts a one-time copy from LEGACY_DIR
 * so users coming from older builds keep their data. If neither exists, writes `defaultContent`.
 */
export const initFile = async (fileName: string, defaultContent: string): Promise<void> => {
  try {
    await Filesystem.readFile({ path: fileName, directory: APP_DIR, encoding: Encoding.UTF8 });
    return;
  } catch {
    /* not in APP_DIR yet */
  }

  try {
    const legacy = await Filesystem.readFile({
      path: fileName,
      directory: LEGACY_DIR,
      encoding: Encoding.UTF8,
    });
    const data = typeof legacy.data === 'string' ? legacy.data : await legacy.data.text();
    await Filesystem.writeFile({
      path: fileName,
      directory: APP_DIR,
      encoding: Encoding.UTF8,
      data,
    });
    console.log(`[storage] Migrated ${fileName}: legacy Documents -> Data`);
    return;
  } catch {
    /* no legacy copy — fall through to defaults */
  }

  await Filesystem.writeFile({
    path: fileName,
    directory: APP_DIR,
    encoding: Encoding.UTF8,
    data: defaultContent,
  });
};

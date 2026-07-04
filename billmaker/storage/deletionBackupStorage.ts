import { Filesystem, Encoding } from '@capacitor/filesystem';
import { APP_DIR, initFile } from './paths';

const FILE_NAME = 'sync_deleted_backup.json';
const MAX_ENTRIES = 500; // keep a rolling log; drop oldest beyond this

export type DeletedKind = 'bills' | 'payments' | 'profiles';

export interface DeletedBackupEntry {
  kind: DeletedKind;
  itemId: string;
  deletedAt: string; // ISO
  reason: 'remote_disappeared' | 'manual';
  /** The full item data at the time of deletion (so it can be restored). */
  snapshot: any;
}

export const initDeletionBackupStorage = async () => {
  await initFile(FILE_NAME, '[]');
};

export const getDeletionBackups = async (): Promise<DeletedBackupEntry[]> => {
  try {
    const result = await Filesystem.readFile({
      path: FILE_NAME,
      directory: APP_DIR,
      encoding: Encoding.UTF8,
    });
    const dataStr = typeof result.data === 'string' ? result.data : await result.data.text();
    const parsed = JSON.parse(dataStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const appendDeletionBackups = async (entries: DeletedBackupEntry[]): Promise<void> => {
  if (entries.length === 0) return;
  const list = await getDeletionBackups();
  const next = [...list, ...entries];
  // Trim oldest if over cap
  const trimmed = next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
  await Filesystem.writeFile({
    path: FILE_NAME,
    data: JSON.stringify(trimmed, null, 2),
    directory: APP_DIR,
    encoding: Encoding.UTF8,
  });
};

export const removeDeletionBackup = async (itemId: string): Promise<void> => {
  const list = await getDeletionBackups();
  const filtered = list.filter(e => e.itemId !== itemId);
  await Filesystem.writeFile({
    path: FILE_NAME,
    data: JSON.stringify(filtered, null, 2),
    directory: APP_DIR,
    encoding: Encoding.UTF8,
  });
};

export const clearDeletionBackups = async (): Promise<void> => {
  await Filesystem.writeFile({
    path: FILE_NAME,
    data: '[]',
    directory: APP_DIR,
    encoding: Encoding.UTF8,
  });
};

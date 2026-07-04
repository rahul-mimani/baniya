import { Filesystem, Encoding } from '@capacitor/filesystem';
import { APP_DIR, initFile } from './paths';

const FILE_NAME = 'firebase_config.json';

export interface FirebaseConfig {
  apiKey: string;
  projectId: string;
  appId: string;
  authDomain?: string;
  messagingSenderId?: string;
  storageBucket?: string;
}

const EMPTY: FirebaseConfig = { apiKey: '', projectId: '', appId: '' };

export const initFirebaseConfigStorage = async () => {
  await initFile(FILE_NAME, JSON.stringify(EMPTY));
};

export const getFirebaseConfig = async (): Promise<FirebaseConfig> => {
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

export const saveFirebaseConfig = async (config: FirebaseConfig): Promise<void> => {
  // Auto-fill commonly-derived fields if missing
  const projectId = config.projectId.trim();
  const enriched: FirebaseConfig = {
    apiKey: config.apiKey.trim(),
    projectId,
    appId: config.appId.trim(),
    authDomain: config.authDomain?.trim() || `${projectId}.firebaseapp.com`,
    messagingSenderId: config.messagingSenderId?.trim() || '',
    storageBucket: config.storageBucket?.trim() || `${projectId}.appspot.com`,
  };
  await Filesystem.writeFile({
    path: FILE_NAME,
    data: JSON.stringify(enriched, null, 2),
    directory: APP_DIR,
    encoding: Encoding.UTF8,
  });
};

export const isFirebaseConfigValid = (c: FirebaseConfig): boolean =>
  !!c.apiKey?.trim() && !!c.projectId?.trim() && !!c.appId?.trim();

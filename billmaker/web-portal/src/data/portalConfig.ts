/**
 * Admin-only persistent config:
 *  - Firebase credentials + Shop Code for connecting to the Baniya Firestore (data sync).
 *  - Cloudinary cloud name + upload preset for product image hosting.
 *
 * Stored in localStorage for the prototype; will move to a server-side admin-scoped
 * collection once auth is wired.
 */
const STORAGE_KEY = 'billmaker-portal-config-v1';

export interface PortalConfig {
  apiKey: string;
  projectId: string;
  appId: string;
  authDomain?: string;
  messagingSenderId?: string;
  shopCode: string;
  /** Cloudinary cloud name — found at Dashboard → top of the page. */
  cloudinaryCloudName?: string;
  /** Cloudinary unsigned upload preset name — Settings → Upload → Add upload preset → Mode: Unsigned. */
  cloudinaryUploadPreset?: string;
}

const EMPTY: PortalConfig = {
  apiKey: '',
  projectId: '',
  appId: '',
  authDomain: '',
  messagingSenderId: '',
  shopCode: '',
  cloudinaryCloudName: '',
  cloudinaryUploadPreset: '',
};

const listeners = new Set<(cfg: PortalConfig) => void>();
export const onConfigChange = (fn: (cfg: PortalConfig) => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

export const getPortalConfig = (): PortalConfig => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw);
    // Strip any legacy fields (e.g. storageBucket from the earlier Firebase Storage attempt).
    return { ...EMPTY, ...parsed };
  } catch {
    return { ...EMPTY };
  }
};

export const savePortalConfig = (cfg: PortalConfig): void => {
  const pid = cfg.projectId.trim();
  const cleaned: PortalConfig = {
    apiKey: cfg.apiKey.trim(),
    projectId: pid,
    appId: cfg.appId.trim(),
    authDomain: cfg.authDomain?.trim() || `${pid}.firebaseapp.com`,
    messagingSenderId: cfg.messagingSenderId?.trim() || '',
    shopCode: cfg.shopCode.trim(),
    cloudinaryCloudName: cfg.cloudinaryCloudName?.trim() || '',
    cloudinaryUploadPreset: cfg.cloudinaryUploadPreset?.trim() || '',
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
  listeners.forEach(fn => { try { fn(cleaned); } catch {} });
};

export const clearPortalConfig = (): void => {
  localStorage.removeItem(STORAGE_KEY);
  listeners.forEach(fn => { try { fn({ ...EMPTY }); } catch {} });
};

/** Firestore connection — for data sync with Baniya mobile. */
export const isConfigValid = (cfg: PortalConfig): boolean =>
  !!cfg.apiKey.trim() && !!cfg.projectId.trim() && !!cfg.appId.trim() && !!cfg.shopCode.trim();

/** Image upload (Cloudinary) — independent from Firestore connection. */
export const isImagesConfigured = (cfg: PortalConfig): boolean =>
  !!cfg.cloudinaryCloudName?.trim() && !!cfg.cloudinaryUploadPreset?.trim();

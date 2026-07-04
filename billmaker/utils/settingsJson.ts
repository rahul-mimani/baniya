// Settings JSON — single-file source of truth for business info + Firebase
// config (+ optional product sync URL + Cloudinary). Admins ship a JSON to
// every staff phone instead of typing each field per device.
//
// The importer is intentionally LENIENT so the same file format can evolve:
//   • `version` is optional (defaults to 1).
//   • `shopCode` may sit at the TOP LEVEL or inside `business.shopCode`.
//   • Every block MERGES into the existing storage — fields not present in
//     the JSON are preserved as-is. Importing a JSON that only sets the
//     Firebase keys will NOT wipe the existing business name/phone/address.
//   • Unknown top-level keys are ignored, never rejected.

import { Filesystem, Encoding } from '@capacitor/filesystem';
import { FileOpener } from '@capacitor-community/file-opener';
import { EXPORT_DIR } from '../storage/paths';
import { BusinessInfo } from '../types';
import { getBusinessInfo, saveBusinessInfo } from '../storage/businessStorage';
import {
  getFirebaseConfig,
  saveFirebaseConfig,
  FirebaseConfig,
} from '../storage/firebaseConfigStorage';
import {
  getProductSyncConfig,
  saveProductSyncConfig,
} from '../storage/productSyncStorage';

export interface SettingsBundle {
  version?: 1;
  exportedAt?: string;
  business?: Partial<BusinessInfo>;
  firebase?: Partial<FirebaseConfig>;
  /** Top-level convenience — equivalent to business.shopCode. */
  shopCode?: string;
  productSync?: {
    url: string;
  };
  /** Any other top-level keys (e.g. `cloudinary`) are silently ignored. */
}

const fmtDateForFilename = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
};

export const exportSettings = async (): Promise<{ fileName: string; uri: string }> => {
  const [biz, fb, ps] = await Promise.all([
    getBusinessInfo(),
    getFirebaseConfig(),
    getProductSyncConfig(),
  ]);
  const bundle: SettingsBundle = {
    version: 1,
    exportedAt: new Date().toISOString(),
    business: biz,
    firebase: fb,
    ...(ps.url ? { productSync: { url: ps.url } } : {}),
  };
  const fileName = `billmaker-settings-${fmtDateForFilename()}.json`;
  await Filesystem.writeFile({
    path: fileName,
    data: JSON.stringify(bundle, null, 2),
    directory: EXPORT_DIR,
    encoding: Encoding.UTF8,
  });
  const { uri } = await Filesystem.getUri({ path: fileName, directory: EXPORT_DIR });
  return { fileName, uri };
};

export const openSettingsFile = async (uri: string) => {
  await FileOpener.open({ filePath: uri, contentType: 'application/json' });
};

export interface ImportSettingsResult {
  businessApplied: boolean;
  firebaseApplied: boolean;
  productSyncApplied: boolean;
  shopCode?: string;
}

// Copy a string field from `src` to `patch` only when present and non-empty.
// Empty-string in the source is treated as "no value" so importing an admin
// stub like `{firebase: {apiKey: ""}}` doesn't wipe a real key on a device
// that already has one.
const assignStr = <T extends object, K extends keyof T>(
  patch: Partial<T>,
  src: any,
  key: K,
  srcKey: string = key as string,
) => {
  const v = src?.[srcKey];
  if (typeof v === 'string' && v.trim().length > 0) {
    (patch as any)[key] = v;
  }
};

export const importSettings = async (text: string): Promise<ImportSettingsResult> => {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('File is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Settings file is empty or not an object.');
  }
  // Version is optional. If present, only "1" is supported — anything else
  // is a deliberate future-incompatible bump and should fail loudly.
  if (parsed.version != null && parsed.version !== 1) {
    throw new Error(`Unsupported settings file version: ${parsed.version}. Expected 1.`);
  }

  let businessApplied = false;
  let firebaseApplied = false;
  let productSyncApplied = false;

  // ----- Business (MERGE) -----------------------------------------------
  // Sources: `parsed.business` (nested) + `parsed.shopCode` (top-level).
  // Empty/missing values do NOT overwrite — admin can ship a JSON with
  // ONLY shopCode and the device's business name stays intact.
  const bizPatch: Partial<BusinessInfo> = {};
  if (parsed.business && typeof parsed.business === 'object') {
    assignStr<BusinessInfo, 'name'>(bizPatch, parsed.business, 'name');
    assignStr<BusinessInfo, 'phone'>(bizPatch, parsed.business, 'phone');
    assignStr<BusinessInfo, 'address'>(bizPatch, parsed.business, 'address');
    assignStr<BusinessInfo, 'gst'>(bizPatch, parsed.business, 'gst');
    assignStr<BusinessInfo, 'shopCode'>(bizPatch, parsed.business, 'shopCode');
  }
  if (typeof parsed.shopCode === 'string' && parsed.shopCode.trim()) {
    bizPatch.shopCode = parsed.shopCode;
  }
  if (Object.keys(bizPatch).length > 0) {
    const existing = await getBusinessInfo();
    await saveBusinessInfo({ ...existing, ...bizPatch });
    businessApplied = true;
  }

  // ----- Firebase (MERGE) -----------------------------------------------
  if (parsed.firebase && typeof parsed.firebase === 'object') {
    const fbPatch: Partial<FirebaseConfig> = {};
    assignStr<FirebaseConfig, 'apiKey'>(fbPatch, parsed.firebase, 'apiKey');
    assignStr<FirebaseConfig, 'projectId'>(fbPatch, parsed.firebase, 'projectId');
    assignStr<FirebaseConfig, 'appId'>(fbPatch, parsed.firebase, 'appId');
    assignStr<FirebaseConfig, 'authDomain'>(fbPatch, parsed.firebase, 'authDomain');
    assignStr<FirebaseConfig, 'messagingSenderId'>(fbPatch, parsed.firebase, 'messagingSenderId');
    assignStr<FirebaseConfig, 'storageBucket'>(fbPatch, parsed.firebase, 'storageBucket');
    if (Object.keys(fbPatch).length > 0) {
      const existing = await getFirebaseConfig();
      await saveFirebaseConfig({ ...existing, ...fbPatch });
      firebaseApplied = true;
    }
  }

  // ----- productSync (MERGE — preserves lastSyncedAt/lastResult) --------
  if (parsed.productSync && typeof parsed.productSync === 'object') {
    const url = String(parsed.productSync.url ?? '').trim();
    if (url) {
      const existing = await getProductSyncConfig();
      await saveProductSyncConfig({ ...existing, url });
      productSyncApplied = true;
    }
  }

  // NOTE: `cloudinary` and other unknown top-level keys are silently
  // ignored. They don't affect the import result.

  if (!businessApplied && !firebaseApplied && !productSyncApplied) {
    throw new Error(
      'Nothing to import — file had no business / firebase / shopCode / productSync block.',
    );
  }

  return {
    businessApplied,
    firebaseApplied,
    productSyncApplied,
    shopCode: bizPatch.shopCode,
  };
};

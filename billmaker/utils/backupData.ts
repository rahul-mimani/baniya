import { Filesystem, Encoding } from '@capacitor/filesystem';
import { FileOpener } from '@capacitor-community/file-opener';
import { EXPORT_DIR } from '../storage/paths';
import { Bill, Profile, BusinessInfo } from '../types';
import { getBills, saveBills } from '../storage/storage';
import { getCustomers, saveCustomers } from '../storage/customerStorage';
import { getProducts, saveProducts } from '../storage/productStorage';
import {
  getProfiles,
  saveProfiles,
  getActiveProfileId,
  setActiveProfileId,
} from '../storage/profileStorage';
import { getBusinessInfo, saveBusinessInfo } from '../storage/businessStorage';

interface BackupBundle {
  version: 1;
  exportedAt: string;
  bills: Bill[];
  customers: string[];
  products: string[];
  profiles: Profile[];
  activeProfileId: string;
  business: BusinessInfo;
}

const fmtDateForFilename = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
};

export const exportAllData = async (): Promise<{ fileName: string; uri: string }> => {
  const bundle: BackupBundle = {
    version: 1,
    exportedAt: new Date().toISOString(),
    bills: await getBills(),
    customers: await getCustomers(),
    products: await getProducts(),
    profiles: await getProfiles(),
    activeProfileId: await getActiveProfileId(),
    business: await getBusinessInfo(),
  };
  const fileName = `billmaker-backup-${fmtDateForFilename()}.json`;
  await Filesystem.writeFile({
    path: fileName,
    data: JSON.stringify(bundle, null, 2),
    directory: EXPORT_DIR,
    encoding: Encoding.UTF8,
  });
  const { uri } = await Filesystem.getUri({ path: fileName, directory: EXPORT_DIR });
  return { fileName, uri };
};

export const openBackupFile = async (uri: string) => {
  await FileOpener.open({ filePath: uri, contentType: 'application/json' });
};

export interface ImportResult {
  newBills: number;
  newCustomers: number;
  newProducts: number;
  newProfiles: number;
}

export const importAllData = async (
  text: string,
  mode: 'merge' | 'replace',
): Promise<ImportResult> => {
  let parsed: BackupBundle;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('File is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !Array.isArray(parsed.bills)) {
    throw new Error('Not a recognized Baniya backup file.');
  }

  const reviveBill = (b: any): Bill => ({
    ...b,
    createdAt: new Date(b.createdAt),
    updatedAt: new Date(b.updatedAt),
  });
  const reviveProfile = (p: any): Profile => ({
    ...p,
    createdAt: new Date(p.createdAt),
  });

  if (mode === 'replace') {
    await saveBills(parsed.bills.map(reviveBill));
    await saveCustomers(parsed.customers || []);
    await saveProducts(parsed.products || []);
    await saveProfiles((parsed.profiles || []).map(reviveProfile));
    await setActiveProfileId(parsed.activeProfileId || '');
    if (parsed.business) await saveBusinessInfo(parsed.business);
    return {
      newBills: parsed.bills.length,
      newCustomers: (parsed.customers || []).length,
      newProducts: (parsed.products || []).length,
      newProfiles: (parsed.profiles || []).length,
    };
  }

  const existingBills = await getBills();
  const existingBillIds = new Set(existingBills.map(b => b.id));
  const incomingBills = parsed.bills.filter(b => !existingBillIds.has(b.id)).map(reviveBill);
  await saveBills([...existingBills, ...incomingBills]);

  const existingCustomers = await getCustomers();
  const custLower = new Set(existingCustomers.map(c => c.toLowerCase()));
  const incomingCustomers = (parsed.customers || []).filter(c => !custLower.has(c.toLowerCase()));
  await saveCustomers([...existingCustomers, ...incomingCustomers]);

  const existingProducts = await getProducts();
  const prodLower = new Set(existingProducts.map(p => p.toLowerCase()));
  const incomingProducts = (parsed.products || []).filter(p => !prodLower.has(p.toLowerCase()));
  await saveProducts([...existingProducts, ...incomingProducts]);

  const existingProfiles = await getProfiles();
  const profIds = new Set(existingProfiles.map(p => p.id));
  const incomingProfiles = (parsed.profiles || [])
    .filter(p => !profIds.has(p.id))
    .map(reviveProfile);
  await saveProfiles([...existingProfiles, ...incomingProfiles]);

  return {
    newBills: incomingBills.length,
    newCustomers: incomingCustomers.length,
    newProducts: incomingProducts.length,
    newProfiles: incomingProfiles.length,
  };
};

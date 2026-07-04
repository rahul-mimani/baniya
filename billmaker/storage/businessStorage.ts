import { Filesystem, Encoding } from '@capacitor/filesystem';
import { BusinessInfo } from '../types';
import { APP_DIR, initFile } from './paths';
import { pushDocMerge } from './sync';

const FILE_NAME = 'business.json';
const DEFAULT: BusinessInfo = { name: '', phone: '', address: '', gst: '', shopCode: '' };

export const initBusinessStorage = async () => {
  await initFile(FILE_NAME, JSON.stringify(DEFAULT));
};

export const getBusinessInfo = async (): Promise<BusinessInfo> => {
  try {
    const result = await Filesystem.readFile({ path: FILE_NAME, directory: APP_DIR, encoding: Encoding.UTF8 });
    const dataStr = typeof result.data === 'string' ? result.data : await result.data.text();
    return { ...DEFAULT, ...JSON.parse(dataStr) };
  } catch {
    return DEFAULT;
  }
};

export const saveBusinessInfo = async (info: BusinessInfo): Promise<void> => {
  await Filesystem.writeFile({
    path: FILE_NAME,
    data: JSON.stringify(info, null, 2),
    directory: APP_DIR,
    encoding: Encoding.UTF8,
  });
  // Sync the shop-wide profile fields. shopCode itself stays local.
  await pushDocMerge('_meta', 'business', {
    name: info.name,
    phone: info.phone,
    address: info.address,
    gst: info.gst,
  });
};

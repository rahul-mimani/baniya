import { Filesystem, Encoding } from '@capacitor/filesystem';
import { Profile } from '../types';
import { APP_DIR, initFile } from './paths';
import { pushDocMerge, deleteDoc } from './sync';

const PROFILES_FILE = 'profiles.json';
const ACTIVE_FILE = 'active_profile.json';

const serializeProfile = (p: Profile): any => ({
  id: p.id,
  name: p.name,
  createdAt: p.createdAt.toISOString(),
});

export const initProfileStorage = async () => {
  await initFile(PROFILES_FILE, '[]');
  await initFile(ACTIVE_FILE, '""');
};

export const getProfiles = async (): Promise<Profile[]> => {
  try {
    const result = await Filesystem.readFile({ path: PROFILES_FILE, directory: APP_DIR, encoding: Encoding.UTF8 });
    const dataStr = typeof result.data === 'string' ? result.data : await result.data.text();
    const profiles = JSON.parse(dataStr);
    return profiles.map((p: any) => ({ ...p, createdAt: new Date(p.createdAt) }));
  } catch {
    return [];
  }
};

export const saveProfiles = async (profiles: Profile[]) => {
  await Filesystem.writeFile({
    path: PROFILES_FILE,
    data: JSON.stringify(profiles, null, 2),
    directory: APP_DIR,
    encoding: Encoding.UTF8,
  });
};

export const addProfile = async (name: string): Promise<Profile> => {
  const trimmed = name.trim();
  const profile: Profile = { id: Date.now().toString(), name: trimmed, createdAt: new Date() };
  const profiles = await getProfiles();
  profiles.push(profile);
  await saveProfiles(profiles);
  await pushDocMerge('profiles', profile.id, serializeProfile(profile));
  return profile;
};

export const deleteProfile = async (id: string): Promise<void> => {
  const profiles = await getProfiles();
  await saveProfiles(profiles.filter(p => p.id !== id));
  const active = await getActiveProfileId();
  if (active === id) await setActiveProfileId('');
  await deleteDoc('profiles', id);
};

export const getActiveProfileId = async (): Promise<string> => {
  try {
    const result = await Filesystem.readFile({ path: ACTIVE_FILE, directory: APP_DIR, encoding: Encoding.UTF8 });
    const dataStr = typeof result.data === 'string' ? result.data : await result.data.text();
    return JSON.parse(dataStr) || '';
  } catch {
    return '';
  }
};

export const setActiveProfileId = async (id: string): Promise<void> => {
  await Filesystem.writeFile({
    path: ACTIVE_FILE,
    data: JSON.stringify(id),
    directory: APP_DIR,
    encoding: Encoding.UTF8,
  });
};

// Read profile.yaml + resume from a folder the user picks once (File System Access API).
// The directory handle is persisted, so later runs re-read live edits without re-picking.
import { parse } from 'yaml';
import { parseProfile, type Profile } from '../config/schema';
import { serializeFile, type SerializedFile } from './serialized-file';

const HANDLE_KEY = 'profileDirHandle';

// Minimal shape of the FS Access handles we use (avoids extra type deps).
interface DirHandle {
  getFileHandle(name: string): Promise<FileHandle>;
  getDirectoryHandle(name: string): Promise<DirHandle>;
  queryPermission(o: { mode: 'read' }): Promise<PermissionState>;
  requestPermission(o: { mode: 'read' }): Promise<PermissionState>;
}
interface FileHandle {
  getFile(): Promise<File>;
}

/** Popup calls this once to grant access to the profile/ folder. */
export async function pickProfileDir(): Promise<void> {
  // @ts-expect-error showDirectoryPicker exists in extension pages.
  const handle: DirHandle = await window.showDirectoryPicker({ mode: 'read' });
  await saveHandle(handle);
}

export async function loadProfileAndResume(): Promise<{ profile: Profile; resume: SerializedFile }> {
  const dir = await getHandle();
  if (!dir) throw new Error('No profile folder chosen yet — click "Choose profile folder".');
  if ((await dir.queryPermission({ mode: 'read' })) !== 'granted') {
    if ((await dir.requestPermission({ mode: 'read' })) !== 'granted') throw new Error('Read permission denied.');
  }

  const yamlText = await (await (await dir.getFileHandle('profile.yaml')).getFile()).text();
  const profile = parseProfile(parse(yamlText));

  const [sub, file] = profile.resume.split('/');
  const resumeDir = file ? await dir.getDirectoryHandle(sub!) : dir;
  const resumeFile = await (await resumeDir.getFileHandle(file ?? sub!)).getFile();

  return { profile, resume: await serializeFile(resumeFile) };
}

// IndexedDB persistence for the (non-JSON-serializable) directory handle.
async function saveHandle(handle: DirHandle): Promise<void> {
  const db = await idb();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction('h', 'readwrite');
    tx.objectStore('h').put(handle, HANDLE_KEY);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function getHandle(): Promise<DirHandle | null> {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('h', 'readonly');
    const req = tx.objectStore('h').get(HANDLE_KEY);
    req.onsuccess = () => res((req.result as DirHandle) ?? null);
    req.onerror = () => rej(req.error);
  });
}
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open('jobbot', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('h');
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

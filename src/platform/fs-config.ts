// Read profile.yaml + resume from a folder the user picks once (File System Access API).
// The directory handle is persisted, so later runs re-read live edits without re-picking.
import { parse } from 'yaml';
import { parseProfile, type Profile } from '../config/schema';
import { serializeFile, type SerializedFile } from './serialized-file';
import type { Application } from '../engine/types';

const HANDLE_KEY = 'profileDirHandle';
const RECORDS_DIR = 'applications';
const LOG_FILE = 'log.jsonl';

// Minimal shape of the FS Access handles we use (avoids extra type deps).
type FsMode = 'read' | 'readwrite';
interface DirHandle {
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>;
  queryPermission(o: { mode: FsMode }): Promise<PermissionState>;
  requestPermission(o: { mode: FsMode }): Promise<PermissionState>;
}
interface Writable {
  write(data: string | Blob | BufferSource): Promise<void>;
  close(): Promise<void>;
}
interface FileHandle {
  getFile(): Promise<File>;
  createWritable(opts?: { keepExistingData?: boolean }): Promise<Writable>;
}

/** True if a profile folder was already picked (handle persisted in IndexedDB). */
export async function hasProfileDir(): Promise<boolean> {
  return (await getHandle()) !== null;
}

/** Popup calls this once to grant access to the profile/ folder.
 *  We ask for readwrite so the background can later persist application records under
 *  applications/ — the picker prompt is a single grant covering both read + write. */
export async function pickProfileDir(): Promise<void> {
  // @ts-expect-error showDirectoryPicker exists in extension pages.
  const handle: DirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  await saveHandle(handle);
}

export async function loadProfileAndResume(): Promise<{ profile: Profile; resume: SerializedFile }> {
  const dir = await getHandle();
  if (!dir) throw new Error('No profile folder chosen yet — click "Choose profile folder".');
  // Request readwrite here (Apply is a user gesture) so the background can write records later.
  if ((await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    if ((await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('Read permission denied.');
  }

  const yamlText = await (await (await dir.getFileHandle('profile.yaml')).getFile()).text();
  const profile = parseProfile(parse(yamlText));

  const [sub, file] = profile.resume.split('/');
  const resumeDir = file ? await dir.getDirectoryHandle(sub!) : dir;
  const resumeFile = await (await resumeDir.getFileHandle(file ?? sub!)).getFile();

  return { profile, resume: await serializeFile(resumeFile) };
}

/**
 * Persist a complete record of one application to disk, under `<profile>/applications/`:
 *  - append one JSON line to `log.jsonl` (machine-readable, complete history)
 *  - write a human-readable `<date>_<jobId>_<slug>.md` (fields + link + status)
 *  - write `<date>_<jobId>_<slug>.png` if we captured a screenshot
 * Best-effort: called from the background, so it can't prompt for permission. If write access
 * isn't granted (or anything fails) it logs and returns — never breaks the run.
 */
export async function writeRecord(app: Application): Promise<void> {
  try {
    const dir = await getHandle();
    if (!dir) return;
    if ((await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      console.warn('[jobbot] no write permission for profile folder — skipping disk record');
      return;
    }
    const records = await dir.getDirectoryHandle(RECORDS_DIR, { create: true });
    const at = new Date().toISOString();
    const base = `${app.date}_${app.jobId}_${slug(app.title)}`;

    const line = JSON.stringify({
      appliedAt: at, company: app.company, jobId: app.jobId, title: app.title,
      url: app.url, status: app.status, note: app.note ?? null, fields: app.fields ?? [],
    });
    await appendLine(records, LOG_FILE, line);
    await writeFile(records, `${base}.md`, markdown(app, at, app.screenshot ? `${base}.png` : null));
    if (app.screenshot) await writeFile(records, `${base}.png`, dataUrlToBlob(app.screenshot));
  } catch (e) {
    console.warn('[jobbot] could not write application record to disk', (e as Error).message);
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'job';
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

function markdown(app: Application, at: string, png: string | null): string {
  const rows = (app.fields ?? []).map((f) => `| ${cell(f.label)} | ${cell(f.value)} |`).join('\n');
  return [
    `# ${app.title}`,
    '',
    `- **Status:** ${app.status}`,
    `- **Job ID:** ${app.jobId}`,
    `- **Link:** ${app.url}`,
    `- **Applied at:** ${at}`,
    `- **Note:** ${app.note ?? '—'}`,
    '',
    '## Fields filled',
    '',
    '| Field | Value |',
    '| --- | --- |',
    rows || '| _(none)_ | |',
    ...(png ? ['', '## Screenshot', '', `![screenshot](${png})`] : []),
    '',
  ].join('\n');
}

async function appendLine(dir: DirHandle, name: string, line: string): Promise<void> {
  let existing = '';
  try {
    existing = await (await (await dir.getFileHandle(name)).getFile()).text();
  } catch {
    /* file doesn't exist yet */
  }
  await writeFile(dir, name, existing + line + '\n');
}

async function writeFile(dir: DirHandle, name: string, data: string | Blob): Promise<void> {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(data);
  await w.close();
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, b64] = dataUrl.split(',');
  const mime = /:(.*?);/.exec(meta ?? '')?.[1] ?? 'image/png';
  const bin = atob(b64 ?? '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
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

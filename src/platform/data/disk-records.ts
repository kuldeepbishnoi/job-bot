import type { Application, AppliedField } from '../../engine/types';

// The full record lives on disk, not in chrome.storage. `store.record()` deliberately strips the
// screenshot, the job description and most of the log line before persisting (a run would blow the
// 10 MB quota otherwise), so the console reads the append-only files under
// <profile>/applications/ to show everything: every question, the résumé used, the captures.
//
// Read-only. The run writes those files (platform/fs-config.ts); this module never does.
// Callable only from an extension page — the directory handle needs a grant the SW cannot hold.

const HANDLE_DB = 'jobbot'; // fs-config's database — the handle it stored when the user picked the folder
const HANDLE_STORE = 'h';
const HANDLE_KEY = 'profileDirHandle';
const RECORDS_DIR = 'applications';
const CAPTURES_DIR = 'captures';

type FsMode = 'read' | 'readwrite';
interface FileHandleLike {
  getFile(): Promise<File>;
}
interface DirHandleLike {
  name?: string;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandleLike>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandleLike>;
  queryPermission(o: { mode: FsMode }): Promise<PermissionState>;
  requestPermission(o: { mode: FsMode }): Promise<PermissionState>;
  values?(): AsyncIterableIterator<{ kind: string; name: string } & FileHandleLike>;
}

/** One uncertain answer, as `review.jsonl` records it: the "we are not sure" list. */
export interface ReviewLine {
  readonly at: string;
  readonly company: string;
  readonly jobId: string;
  readonly title: string;
  readonly url: string;
  readonly status: string;
  readonly label: string;
  readonly kind?: string;
  readonly intent?: string;
  readonly options?: readonly string[];
  readonly value?: string;
  readonly source?: string;
  readonly error?: string;
}

/** A full application line from `applications.jsonl` — richer than the chrome.storage copy. */
export interface DiskApplication extends Application {
  readonly files?: readonly string[]; // captures/<date>_<jobId>_<status>.{jpg,html}
  readonly fields?: readonly AppliedField[];
}

function idbGetHandle(): Promise<DirHandleLike | null> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(HANDLE_DB, 1);
    } catch {
      resolve(null);
      return;
    }
    // Never create the store here: fs-config owns this database's schema. If the upgrade fires,
    // the folder was never picked, so there is nothing to read.
    req.onupgradeneeded = () => {
      try {
        if (!req.result.objectStoreNames.contains(HANDLE_STORE)) req.result.createObjectStore(HANDLE_STORE);
      } catch {
        /* fs-config will create it when the user picks a folder */
      }
    };
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        resolve(null);
        return;
      }
      try {
        const get = db.transaction(HANDLE_STORE, 'readonly').objectStore(HANDLE_STORE).get(HANDLE_KEY);
        get.onsuccess = () => resolve((get.result as DirHandleLike | undefined) ?? null);
        get.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    };
  });
}

/** Is a profile folder linked AND still readable? Both matter: a grant can lapse between sessions. */
export async function diskAvailable(): Promise<{ linked: boolean; readable: boolean; folder?: string }> {
  const dir = await idbGetHandle();
  if (!dir) return { linked: false, readable: false };
  const state = await dir.queryPermission({ mode: 'read' }).catch(() => 'denied' as PermissionState);
  return { linked: true, readable: state === 'granted', ...(dir.name ? { folder: dir.name } : {}) };
}

/** Ask for read access. Must run inside a click handler — Chrome requires the user gesture. */
export async function requestDiskAccess(): Promise<boolean> {
  const dir = await idbGetHandle();
  if (!dir) return false;
  return (await dir.requestPermission({ mode: 'readwrite' }).catch(() => 'denied' as PermissionState)) === 'granted';
}

async function recordsDir(): Promise<DirHandleLike | null> {
  const dir = await idbGetHandle();
  if (!dir) return null;
  if ((await dir.queryPermission({ mode: 'read' }).catch(() => 'denied' as PermissionState)) !== 'granted') return null;
  return dir.getDirectoryHandle(RECORDS_DIR).catch(() => null);
}

async function readText(dir: DirHandleLike, name: string): Promise<string> {
  try {
    return await (await (await dir.getFileHandle(name)).getFile()).text();
  } catch {
    return ''; // the file only exists once something has been written
  }
}

/** Parse a JSONL body, skipping malformed lines rather than losing the whole file to one bad write. */
export function parseJsonl<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      /* a torn last line from a crash — skip it */
    }
  }
  return out;
}

/** Every application ever written to disk, oldest first. Empty when no folder is linked. */
export async function readDiskApplications(): Promise<DiskApplication[]> {
  const dir = await recordsDir();
  if (!dir) return [];
  return parseJsonl<DiskApplication>(await readText(dir, 'applications.jsonl'));
}

/** The "not sure" list: one line per guessed / coerced / unanswered / unmatched question. */
export async function readReviewLines(): Promise<ReviewLine[]> {
  const dir = await recordsDir();
  if (!dir) return [];
  return parseJsonl<ReviewLine>(await readText(dir, 'review.jsonl'));
}

/** Group uncertain answers by question, so one fix can clear every job it blocked. */
export interface ReviewGroup {
  readonly label: string;
  readonly intent?: string;
  readonly kind?: string;
  readonly options: readonly string[];
  readonly sources: readonly string[];
  readonly jobs: readonly ReviewLine[];
  /** The profile key to set, when the matcher recognised the question. */
  readonly profileKey?: string;
}

export function groupReview(lines: readonly ReviewLine[]): ReviewGroup[] {
  const by = new Map<string, ReviewLine[]>();
  for (const l of lines) {
    const key = l.label.trim().toLowerCase();
    const list = by.get(key);
    if (list) list.push(l);
    else by.set(key, [l]);
  }
  const groups: ReviewGroup[] = [];
  for (const jobs of by.values()) {
    const first = jobs[0]!;
    const options = [...new Set(jobs.flatMap((j) => j.options ?? []))];
    const sources = [...new Set(jobs.map((j) => j.source).filter((s): s is string => !!s))];
    groups.push({
      label: first.label,
      ...(first.intent ? { intent: first.intent, profileKey: first.intent.replace(/^answers\./, '') } : {}),
      ...(first.kind ? { kind: first.kind } : {}),
      options,
      sources,
      jobs,
    });
  }
  // Most-blocking question first: that is the one worth answering now.
  return groups.sort((a, b) => b.jobs.length - a.jobs.length);
}

/** A capture file written next to the record (`files[]` on the application line). */
export async function readCaptureFile(path: string): Promise<{ blob: Blob; name: string } | null> {
  const dir = await recordsDir();
  if (!dir) return null;
  const parts = path.split('/').filter(Boolean);
  const name = parts.at(-1);
  if (!name) return null;
  const inCaptures = parts.length > 1 && parts.at(-2) === CAPTURES_DIR;
  try {
    const host = inCaptures ? await dir.getDirectoryHandle(CAPTURES_DIR) : dir;
    const file = await (await host.getFileHandle(name)).getFile();
    return { blob: file, name };
  } catch {
    return null;
  }
}

/** The complete daily log the run wrote (`log-<date>.txt`), newest lines last. */
export async function readDiskLog(date: string): Promise<string[]> {
  const dir = await recordsDir();
  if (!dir) return [];
  const text = await readText(dir, `log-${date}.txt`);
  return text.split('\n').filter((l) => l.trim());
}

/** Which daily logs exist, newest first — the Logs page offers them as a source. */
export async function listDiskLogDates(): Promise<string[]> {
  const dir = await recordsDir();
  if (!dir?.values) return [];
  const dates: string[] = [];
  try {
    for await (const entry of dir.values()) {
      const m = /^log-(\d{4}-\d{2}-\d{2})\.txt$/.exec(entry.name);
      if (m?.[1]) dates.push(m[1]);
    }
  } catch {
    return [];
  }
  return dates.sort().reverse();
}

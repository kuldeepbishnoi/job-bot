// IndexedDB for the dashboard's bulky data (events, captures, résumés). A SEPARATE database from
// the `jobbot` db fs-config.ts uses for the folder handle — never touch that one from here.
// Safe in a service worker: no window, no document.

export const DB_NAME = 'jobbot-data';
export const DB_VERSION = 1;

export const STORE = {
  events: 'events',
  captures: 'captures',
  captureBlobs: 'capture_blobs', // bytes live apart from the metas so LRU pruning never loads 300 MB
  resumes: 'resumes',
} as const;

export type ChangedStore = 'events' | 'captures' | 'resumes' | 'runs' | 'profile';

let dbp: Promise<IDBDatabase> | null = null;

/** Open (and on first use create) the database. The connection is cached per context. */
export function openDb(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise<IDBDatabase>((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => upgrade(req.result);
    req.onsuccess = () => {
      const db = req.result;
      // Another context upgrading the schema asks us to close; drop the cache so the next call reopens.
      db.onversionchange = () => {
        db.close();
        dbp = null;
      };
      res(db);
    };
    req.onerror = () => {
      dbp = null;
      rej(req.error);
    };
    req.onblocked = () => rej(new Error('jobbot-data: open blocked by another connection'));
  });
  return dbp;
}

function upgrade(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(STORE.events)) {
    const events = db.createObjectStore(STORE.events, { keyPath: 'seq', autoIncrement: true });
    events.createIndex('ts', 'ts');
    events.createIndex('runId', 'runId');
    events.createIndex('jobId', 'jobId');
    events.createIndex('siteId', 'siteId');
  }
  if (!db.objectStoreNames.contains(STORE.captures)) {
    const captures = db.createObjectStore(STORE.captures, { keyPath: 'captureId' });
    captures.createIndex('jobId', 'jobId');
    captures.createIndex('runId', 'runId');
    captures.createIndex('ts', 'ts');
  }
  if (!db.objectStoreNames.contains(STORE.captureBlobs)) db.createObjectStore(STORE.captureBlobs, { keyPath: 'captureId' });
  if (!db.objectStoreNames.contains(STORE.resumes)) db.createObjectStore(STORE.resumes, { keyPath: 'id' });
}

/** Promisify one request. */
export function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function done(t: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error ?? new Error('transaction aborted'));
  });
}

/** One transaction on one store. `fn` may return a request or a promise chained off requests —
 *  IDB keeps the transaction alive across request callbacks, so `await req(...)` inside is fine;
 *  awaiting anything else (a fetch, a timer) auto-commits it. */
export async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | Promise<T>): Promise<T> {
  const db = await openDb();
  const t = db.transaction(store, mode);
  const finished = done(t);
  const out = fn(t.objectStore(store));
  const value = await ('onsuccess' in out ? req(out) : out);
  await finished;
  return value;
}

/** Same, spanning several stores (captures meta + bytes). */
export async function multiTx<T>(stores: readonly string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await openDb();
  const t = db.transaction([...stores], mode);
  const finished = done(t);
  const value = await fn(t);
  await finished;
  return value;
}

/** Walk a cursor; return false from `each` to stop early. */
export function walk(source: IDBObjectStore | IDBIndex, range: IDBKeyRange | null, direction: IDBCursorDirection, each: (c: IDBCursorWithValue) => boolean | void): Promise<void> {
  return new Promise((res, rej) => {
    const r = source.openCursor(range, direction);
    r.onerror = () => rej(r.error);
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return res();
      if (each(c) === false) return res();
      c.continue();
    };
  });
}

// Change notifications: local listeners (same context) + BroadcastChannel (SW ↔ dashboard ↔
// popup). chrome.storage has onChanged; IDB has nothing, so this is how the UI learns to re-read.
type Listener = (store: ChangedStore) => void;
const listeners = new Set<Listener>();
let channel: BroadcastChannel | null | undefined; // undefined = not tried yet

function bc(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(DB_NAME);
  if (channel) channel.onmessage = (e: MessageEvent<{ store?: ChangedStore }>) => {
    const s = e.data?.store;
    if (s) for (const l of listeners) l(s);
  };
  return channel;
}

export const changes = {
  subscribe(fn: Listener): () => void {
    bc();
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
  emit(store: ChangedStore): void {
    for (const l of listeners) l(store);
    try {
      bc()?.postMessage({ store });
    } catch {
      /* channel closed — local listeners were already told */
    }
  },
};

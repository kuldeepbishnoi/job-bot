// A tiny in-memory chrome.storage.local, installed on globalThis. Enough for the data layer:
// get (string | string[] | undefined) / set / remove, and onChanged listeners fired on set/remove.

type Listener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void;

export interface ChromeFake {
  storage: { local: { get(k?: string | string[]): Promise<Record<string, unknown>>; set(o: Record<string, unknown>): Promise<void>; remove(k: string | string[]): Promise<void>; clear(): Promise<void> }; onChanged: { addListener(fn: Listener): void; removeListener(fn: Listener): void } };
  /** Test-only: peek at the raw map. */
  _data: Map<string, unknown>;
}

export function installChromeFake(): ChromeFake {
  const data = new Map<string, unknown>();
  const listeners = new Set<Listener>();
  const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)); // storage is JSON, not references
  const fire = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => {
    for (const l of listeners) l(changes, 'local');
  };
  const fake: ChromeFake = {
    _data: data,
    storage: {
      local: {
        async get(k) {
          const keys = k === undefined ? [...data.keys()] : Array.isArray(k) ? k : [k];
          const out: Record<string, unknown> = {};
          for (const key of keys) if (data.has(key)) out[key] = clone(data.get(key));
          return out;
        },
        async set(o) {
          const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
          for (const [key, v] of Object.entries(o)) {
            changes[key] = { oldValue: data.get(key), newValue: clone(v) };
            data.set(key, clone(v));
          }
          fire(changes);
        },
        async remove(k) {
          const changes: Record<string, { oldValue?: unknown }> = {};
          for (const key of Array.isArray(k) ? k : [k]) {
            changes[key] = { oldValue: data.get(key) };
            data.delete(key);
          }
          fire(changes);
        },
        async clear() {
          data.clear();
        },
      },
      onChanged: {
        addListener: (fn) => void listeners.add(fn),
        removeListener: (fn) => void listeners.delete(fn),
      },
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = fake;
  return fake;
}

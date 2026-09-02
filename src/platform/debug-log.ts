// Persistent, capped debug log in chrome.storage.local — readable after the fact from the SW
// console (`chrome.storage.local.get('debug_log')`) or straight from the extension's LevelDB on
// disk, so a failed run explains itself without DevTools open at the right moment.
const KEY = 'debug_log';
const CAP = 400;

let queue: Promise<void> = Promise.resolve();

export function dlog(scope: string, ...args: unknown[]): void {
  console.log(`[jobbot:${scope}]`, ...args);
  const line = `${new Date().toISOString()} ${scope} ${args
    .map((a) => (typeof a === 'string' ? a : safeJson(a)))
    .join(' ')}`.slice(0, 1500);
  queue = queue
    .then(async () => {
      const got = await chrome.storage.local.get(KEY);
      const lines = ((got[KEY] as string[] | undefined) ?? []).concat(line).slice(-CAP);
      await chrome.storage.local.set({ [KEY]: lines });
    })
    .catch(() => {});
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

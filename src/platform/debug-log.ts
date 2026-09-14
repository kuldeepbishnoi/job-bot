// Persistent debug log in chrome.storage.local — readable after the fact from the Logs page, the
// SW console (`chrome.storage.local.get('debug_log')`) or the on-disk copy the background appends
// to `profile/applications/log-<date>.txt`, so a failed run explains itself without DevTools open
// at the right moment.
//
// Writes are batched (one read-modify-write per BATCH_MS, not per line): a LinkedIn job logs
// ~15 lines in a few seconds and the array is thousands of lines long.
const KEY = 'debug_log';
const PENDING_KEY = 'debug_log_pending'; // lines not yet appended to the on-disk log file
// chrome.storage.local is 10 MB with no `unlimitedStorage` permission, and the records share it,
// so both lists are bounded by line COUNT and line LENGTH: 1000 × 1.2 KB ≈ 1.2 MB each, worst case.
// The complete, unbounded history is the on-disk log-<date>.txt the background appends.
export const CAP = 1000;
const LINE_CHARS = 1200;
const BATCH_MS = 400;

let buffer: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let queue: Promise<void> = Promise.resolve();

export function dlog(scope: string, ...args: unknown[]): void {
  console.log(`[jobbot:${scope}]`, ...args);
  buffer.push(formatLine(scope, args));
  if (!timer) timer = setTimeout(flush, BATCH_MS);
}

/** One log line, same shape everywhere: `<iso> <scope> <args…>`. */
export function formatLine(scope: string, args: readonly unknown[]): string {
  return `${new Date().toISOString()} ${scope} ${args
    .map((a) => (typeof a === 'string' ? a : safeJson(a)))
    .join(' ')}`.slice(0, LINE_CHARS);
}

function flush(): void {
  timer = null;
  const lines = buffer;
  buffer = [];
  if (!lines.length) return;
  queue = queue
    .then(async () => {
      const got = await chrome.storage.local.get([KEY, PENDING_KEY]);
      const all = ((got[KEY] as string[] | undefined) ?? []).concat(lines).slice(-CAP);
      const pending = ((got[PENDING_KEY] as string[] | undefined) ?? []).concat(lines).slice(-CAP);
      await chrome.storage.local.set({ [KEY]: all, [PENDING_KEY]: pending });
    })
    .catch(() => {});
}

/** Everything logged since the last call (for the on-disk log file). Clears the pending list. */
export async function takePendingLines(): Promise<string[]> {
  await queue;
  const got = await chrome.storage.local.get(PENDING_KEY);
  const pending = (got[PENDING_KEY] as string[] | undefined) ?? [];
  if (pending.length) await chrome.storage.local.set({ [PENDING_KEY]: [] });
  return pending;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

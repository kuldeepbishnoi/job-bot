// Persistent debug log in chrome.storage.local — readable after the fact from the Logs page, the
// SW console (`chrome.storage.local.get('debug_log')`) or the on-disk copy the background appends
// to `profile/applications/log-<date>.txt`, so a failed run explains itself without DevTools open
// at the right moment.
//
// Writes are batched (one read-modify-write per BATCH_MS, not per line): a LinkedIn job logs
// ~15 lines in a few seconds and the array is thousands of lines long.
//
// Every line ALSO reaches the structured event store — but through a sink installed by Main
// (`app/observe.ts#mirrorLogsToEvents`, wired in background.ts), never by importing the store
// here: a content script's `dlog` would otherwise open an IndexedDB on the *page's* origin.
// The sink gets the whole batch, so the mirror costs one IDB transaction per flush, not per line.
import type { LogLevel } from '../engine/records';

const KEY = 'debug_log';
const PENDING_KEY = 'debug_log_pending'; // lines not yet appended to the on-disk log file
// chrome.storage.local is 10 MB with no `unlimitedStorage` permission, and the records share it,
// so both lists are bounded by line COUNT and line LENGTH: 1000 × 1.2 KB ≈ 1.2 MB each, worst case.
// The complete, unbounded history is the on-disk log-<date>.txt the background appends.
export const CAP = 1000;
const LINE_CHARS = 1200;
const BATCH_MS = 400;

/** Run/job context a structured line carries; unset fields fall back to the active run. */
export interface LogCtx {
  runId?: string;
  jobId?: string;
  siteId?: string;
}

/** One buffered line: the flat text everyone already reads, plus whatever structure we know. */
export interface LogEntry {
  readonly ts: number;
  readonly scope: string;
  readonly text: string;
  readonly line: string;
  readonly level?: LogLevel;
  readonly data?: Record<string, unknown>;
  readonly ctx?: LogCtx;
}

export type EventSink = (entries: readonly LogEntry[]) => void;

let buffer: LogEntry[] = [];
let mirror: LogEntry[] = []; // same batch, minus lines whose event was already written
let timer: ReturnType<typeof setTimeout> | null = null;
let queue: Promise<void> = Promise.resolve();
let sink: EventSink | null = null;

/** Main installs the mirror; contexts that must not touch the event store simply never do. */
export function setEventSink(s: EventSink | null): void {
  sink = s;
}

export function dlog(scope: string, ...args: unknown[]): void {
  console.log(`[jobbot:${scope}]`, ...args);
  push({ ts: Date.now(), scope, text: textOf(args), line: formatLine(scope, args) }, true);
}

/** A dlog line that knows its own level, data and run/job context (the structured path). */
export function elog(level: LogLevel, scope: string, msg: string, data?: Record<string, unknown>, ctx?: LogCtx): void {
  const args = data ? [msg, data] : [msg];
  console.log(`[jobbot:${scope}]`, ...args);
  // `text` is the message alone — `data` travels as structure, and only the flat line inlines it.
  push({ ts: Date.now(), scope, text: msg, line: formatLine(scope, args), level, ...(data ? { data } : {}), ...(ctx ? { ctx } : {}) }, true);
}

/** The flat log only — for lines whose structured event was already written (observe.event),
 *  so the on-disk log stays complete without duplicating the event. */
export function flatLog(scope: string, ...args: unknown[]): void {
  push({ ts: Date.now(), scope, text: textOf(args), line: formatLine(scope, args) }, false);
}

/** One log line, same shape everywhere: `<iso> <scope> <args…>`. */
export function formatLine(scope: string, args: readonly unknown[]): string {
  return `${new Date().toISOString()} ${scope} ${args
    .map((a) => (typeof a === 'string' ? a : safeJson(a)))
    .join(' ')}`.slice(0, LINE_CHARS);
}

// Only the service worker appends to the pending list. A content script writing it too would race
// takePendingLines (read → clear) and silently drop lines from the on-disk log; the content
// script's own lines reach disk with the application record instead (`Application.log`).
const OWNS_PENDING = typeof window === 'undefined';

function textOf(args: readonly unknown[]): string {
  return args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ').slice(0, 2000);
}

function push(entry: LogEntry, toEvents: boolean): void {
  buffer.push(entry);
  if (toEvents) mirror.push(entry);
  if (!timer) timer = setTimeout(flush, BATCH_MS);
}

function flush(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const entries = buffer;
  const toMirror = mirror;
  buffer = [];
  mirror = [];
  if (!entries.length) return;
  const lines = entries.map((e) => e.line);
  queue = queue
    .then(async () => {
      const keys = OWNS_PENDING ? [KEY, PENDING_KEY] : [KEY];
      const got = await chrome.storage.local.get(keys);
      const all = ((got[KEY] as string[] | undefined) ?? []).concat(lines).slice(-CAP);
      const write: Record<string, string[]> = { [KEY]: all };
      if (OWNS_PENDING) write[PENDING_KEY] = ((got[PENDING_KEY] as string[] | undefined) ?? []).concat(lines).slice(-CAP);
      await chrome.storage.local.set(write);
    })
    .catch(() => {});
  if (sink && toMirror.length) {
    try {
      sink(toMirror);
    } catch {
      /* the mirror is best-effort; the flat log above already has the line */
    }
  }
}

/** Write the pending batch now and wait for it (tests, and before reading the flat log back). */
export async function flushLogs(): Promise<void> {
  flush();
  await queue;
}

/** Everything logged since the last call (for the on-disk log file). Clears the pending list. */
export async function takePendingLines(): Promise<string[]> {
  await flushLogs(); // include the batch still sitting in the buffer, not just what reached storage
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

// Structured log store. `dlog` lines (chrome.storage `debug_log`, 400 lines) stay for the SW
// console; this is the searchable history the Logs page reads. Appends are batched; pruning to
// the cap runs every ~500 writes, not on every write (a count on each append would double the IO).
import type { LogEvent, LogLevel } from '../../engine/records';
import { inferLevel } from '../../engine/records';
import { STORE, changes, tx, walk } from './idb';

export const EVENT_CAP = 50_000;
const PRUNE_EVERY = 500;
const DEFAULT_LIMIT = 200;
const LEGACY_KEY = 'debug_log';
const CURSOR_KEY = 'events_import_cursor';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
let sinceLastPrune = 0;

export async function appendEvents(events: readonly LogEvent[]): Promise<void> {
  if (events.length === 0) return;
  await tx(STORE.events, 'readwrite', async (s) => {
    for (const e of events) {
      const { seq: _omit, ...row } = e; // the store assigns seq
      s.add(row);
    }
    return undefined;
  });
  sinceLastPrune += events.length;
  if (sinceLastPrune >= PRUNE_EVERY) {
    sinceLastPrune = 0;
    await pruneEvents();
  }
  changes.emit('events');
}

/** Drop the oldest events beyond `cap`. Returns how many were removed. */
export async function pruneEvents(cap = EVENT_CAP): Promise<number> {
  const total = await eventCount();
  const excess = total - cap;
  if (excess <= 0) return 0;
  let removed = 0;
  await tx(STORE.events, 'readwrite', (s) =>
    walk(s, null, 'next', (c) => {
      c.delete();
      removed++;
      return removed < excess;
    }),
  );
  return removed;
}

export interface EventQuery {
  runId?: string;
  jobId?: string;
  siteId?: string;
  /** Minimum level: 'warn' returns warn + error. */
  level?: LogLevel;
  /** Substring (case-insensitive) of msg, scope, or the JSON of `data`. */
  text?: string;
  limit?: number;
  /** Page backwards: only events with seq < beforeSeq. */
  beforeSeq?: number;
}

/** Newest first. Uses the runId / jobId / siteId index when given; everything else filters in JS. */
export async function queryEvents(q: EventQuery): Promise<LogEvent[]> {
  const limit = q.limit ?? DEFAULT_LIMIT;
  const minRank = q.level ? LEVEL_RANK[q.level] : 0;
  const needle = q.text?.toLowerCase();
  const out: LogEvent[] = [];
  const keep = (e: LogEvent): boolean => {
    if (q.beforeSeq !== undefined && (e.seq ?? Infinity) >= q.beforeSeq) return false;
    if (q.runId && e.runId !== q.runId) return false;
    if (q.jobId && e.jobId !== q.jobId) return false;
    if (q.siteId && e.siteId !== q.siteId) return false;
    if (LEVEL_RANK[e.level] < minRank) return false;
    if (needle && !`${e.scope} ${e.msg} ${e.data ? safeJson(e.data) : ''}`.toLowerCase().includes(needle)) return false;
    return true;
  };
  await tx(STORE.events, 'readonly', (s) => {
    let source: IDBObjectStore | IDBIndex = s;
    let range: IDBKeyRange | null = null;
    if (q.runId) [source, range] = [s.index('runId'), IDBKeyRange.only(q.runId)];
    else if (q.jobId) [source, range] = [s.index('jobId'), IDBKeyRange.only(q.jobId)];
    else if (q.siteId) [source, range] = [s.index('siteId'), IDBKeyRange.only(q.siteId)];
    else if (q.beforeSeq !== undefined) range = IDBKeyRange.upperBound(q.beforeSeq, true);
    return walk(source, range, 'prev', (c) => {
      const e = c.value as LogEvent;
      if (keep(e)) out.push(e);
      return out.length < limit;
    });
  });
  // An index cursor orders by (indexKey, seq); with a single-value range that is seq order.
  return out;
}

export function eventCount(): Promise<number> {
  return tx(STORE.events, 'readonly', (s) => s.count());
}

export async function clearEvents(): Promise<void> {
  await tx(STORE.events, 'readwrite', (s) => s.clear());
  changes.emit('events');
}

// Legacy `dlog` line: "<iso> <scope> <text>" (platform/debug-log.ts). Scopes that are pack ids
// double as the site; the job id is a "[123456]" token or the first long digit run in the text.
const LINE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(\S+)\s?(.*)$/s;
const SITE_SCOPES = new Set(['datadog', 'amazon', 'instahyre', 'linkedin']);

export function legacyLinesToEvents(lines: readonly string[]): LogEvent[] {
  return lines.filter((l) => l.trim()).map((line) => {
    const m = LINE.exec(line);
    const ts = m ? Date.parse(m[1]!) : NaN;
    const scope = m ? m[2]! : 'legacy';
    const text = m ? m[3]! : line;
    const jobId = /\[(\d{4,})\]/.exec(text)?.[1] ?? /\b\d{6,}\b/.exec(text)?.[0];
    return {
      ts: Number.isNaN(ts) ? 0 : ts,
      level: inferLevel(scope, text),
      origin: 'sw',
      scope,
      ...(SITE_SCOPES.has(scope) ? { siteId: scope } : {}),
      ...(jobId ? { jobId } : {}),
      msg: text.trim(),
    };
  });
}

/** One-shot import of chrome.storage `debug_log`: converts the lines after the last imported one
 *  (remembered in `events_import_cursor`; if it rotated out, everything) and appends them. */
export async function importLegacyDebugLog(): Promise<number> {
  const got = await chrome.storage.local.get([LEGACY_KEY, CURSOR_KEY]);
  const lines = (got[LEGACY_KEY] as string[] | undefined) ?? [];
  const cursor = got[CURSOR_KEY] as string | undefined;
  const from = cursor ? lines.lastIndexOf(cursor) + 1 : 0; // -1 + 1 = 0 when the cursor line is gone
  const fresh = lines.slice(from);
  if (fresh.length === 0) return 0;
  await appendEvents(legacyLinesToEvents(fresh));
  await chrome.storage.local.set({ [CURSOR_KEY]: fresh[fresh.length - 1] });
  return fresh.length;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

import type { Application, Job } from '../engine/types';
import type { Credentials } from './credentials';
import type { Profile } from '../config/schema';
import type { SerializedFile } from './serialized-file';
import { appliedJobIds, computeStats, type Stats } from '../engine/stats';

// Repository adapter: the only place that touches chrome.storage.
// Pure computation lives in engine/stats.ts; this file just supplies data + clock.
const KEY = 'applications';
const STATE_KEY = 'run_state';
const PROGRESS_KEY = 'run_progress';

// Live run status, persisted so the (ephemeral MV3) popup can show what's happening even after it
// closes — the worker tab activating closes the popup, so in-memory progress would otherwise be lost.
export interface RunProgress {
  readonly done: number;
  readonly total: number;
  readonly current: string;
  readonly phase: 'running' | 'done' | 'paused'; // paused = waiting for the user to log the next account in
  readonly at: number; // epoch ms of last update
}

export async function saveProgress(p: RunProgress): Promise<void> {
  await chrome.storage.local.set({ [PROGRESS_KEY]: p });
}

export async function getProgress(): Promise<RunProgress | null> {
  const got = await chrome.storage.local.get(PROGRESS_KEY);
  return (got[PROGRESS_KEY] as RunProgress | undefined) ?? null;
}

/** Persisted run state, so an alarm-driven step survives service-worker termination. */
export interface RunState {
  readonly siteId: string;
  readonly profile: Profile;
  readonly resume: SerializedFile;
  readonly queue: readonly Job[];
  readonly cursor: number;
  /** Set when the run is waiting for the user to log in as `nextAccount` (account rotation). */
  readonly paused?: { readonly reason: string; readonly nextAccount: string };
  /** From profile/accounts.csv when present — lets rotation log the next account in itself. */
  readonly credentials?: Credentials;
}

export async function saveRunState(s: RunState): Promise<void> {
  await chrome.storage.local.set({ [STATE_KEY]: s });
}

export async function getRunState(): Promise<RunState | null> {
  const got = await chrome.storage.local.get(STATE_KEY);
  return (got[STATE_KEY] as RunState | undefined) ?? null;
}

export async function clearRunState(): Promise<void> {
  await chrome.storage.local.remove(STATE_KEY);
}

async function readAll(): Promise<Application[]> {
  const got = await chrome.storage.local.get(KEY);
  return (got[KEY] as Application[] | undefined) ?? [];
}

const ACCOUNT_KEY = 'account';

/** Which login this extension instance applies from (one Chrome profile per account). */
export async function getAccount(): Promise<string> {
  const got = await chrome.storage.local.get(ACCOUNT_KEY);
  return (got[ACCOUNT_KEY] as string | undefined) ?? '';
}
export async function setAccount(email: string): Promise<void> {
  await chrome.storage.local.set({ [ACCOUNT_KEY]: email.trim() });
}

// chrome.storage.local is 10 MB (no `unlimitedStorage`), shared with the debug log. A record's
// heavy parts — the capture, the description, the log lines — live on disk (fs-config), so storage
// keeps: the log only for attempts that need review, only on the most recent records, and a hard
// retry that sheds the oldest logs if Chrome still refuses the write.
const LOG_LINES_KEPT = 30;
const RECORDS_KEEPING_LOGS = 60;
// The on-disk applications.jsonl is the complete history; chrome.storage only feeds the UI and the
// dedupe list. Unbounded, it eventually exhausts the 10 MB quota, and a rejected write used to
// cost the record, its capture and the run's counters.
const MAX_RECORDS = 2000;

export async function record(app: Application): Promise<void> {
  const all = await readAll();
  // Drop the screenshot dataURL before persisting — it's ~100-300 KB and would blow the
  // chrome.storage quota over a run. It's written to disk (fs-config.writeRecord) instead.
  // Same for the HTML/screenshot capture and the job description: the on-disk record keeps them
  // (fs-config.persistApplication); storage keeps the fields, note and a capped log.
  const { screenshot: _omit, capture: _omit2, description: _omit3, ...lean } = app;
  // An applied job's log is only interesting on disk; a parked/failed one is what the user reviews.
  const keepLog = app.log?.length && app.status !== 'applied';
  const stamped: Application = { ...lean, ...(keepLog ? { log: app.log!.slice(-LOG_LINES_KEPT) } : {}), at: new Date().toISOString(), account: await getAccount() };
  const next = [...all, stamped].slice(-MAX_RECORDS);
  try {
    await chrome.storage.local.set({ [KEY]: next });
  } catch (e) {
    // Out of quota: drop the log lines from everything but the newest handful and try once more.
    // Losing log lines that are already on disk beats losing the record itself.
    const slim = next.map((a, i) => (i < next.length - RECORDS_KEEPING_LOGS && a.log ? { ...a, log: undefined } : a));
    try {
      await chrome.storage.local.set({ [KEY]: slim });
    } catch {
      // Still refused: keep the newest half rather than losing the write (and with it the job's
      // place in the dedupe list, which is what makes a re-run apply to it twice).
      await chrome.storage.local.set({ [KEY]: slim.slice(-Math.ceil(slim.length / 2)).map(({ log: _l, fields: _f, ...a }) => a) });
    }
    console.warn('[jobbot] storage quota hit — trimmed old log lines from records', (e as Error).message);
  }
}

/** Applications made today by one account, for ONE site when given (per-account daily limits are
 *  per site: Amazon's 10/day is Amazon's). Counting every site together made an Amazon run rotate
 *  accounts because the LinkedIn applications of the same morning had used up the number. */
export async function appliedTodayCount(account: string, company?: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  return (await readAll()).filter((a) => a.status === 'applied' && a.date === today && (a.account ?? '') === account && (!company || a.company === company)).length;
}

/** Accounts whose run hit THIS site's own limit page today (recorded as a failed note). Limits are
 *  per site: Amazon's daily cap says nothing about Datadog's, and without the filter one capped
 *  Amazon account was excluded from every other site's rotation for the rest of the day. */
export async function accountsAtLimitToday(company?: string): Promise<Set<string>> {
  const today = new Date().toISOString().slice(0, 10);
  return new Set(
    (await readAll())
      .filter((a) => a.date === today && /limit reached/i.test(a.note ?? '') && (!company || a.company === company))
      .map((a) => a.account ?? ''),
  );
}

export async function allRecords(): Promise<Application[]> {
  return readAll();
}

export async function appliedIds(): Promise<Set<string>> {
  return appliedJobIds(await readAll());
}

export async function parked(): Promise<Application[]> {
  return (await readAll()).filter((a) => a.status === 'parked');
}

/** Most-recent-first list of jobs that need attention (parked or failed), with their notes. */
export async function needsAttention(): Promise<Application[]> {
  return (await readAll()).filter((a) => a.status === 'parked' || a.status === 'failed').reverse();
}

export async function stats(): Promise<Stats> {
  const now = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  const w = new Date(now);
  w.setDate(now.getDate() - 6); // 7-day window inclusive of today
  return computeStats(await readAll(), iso(now), iso(y), iso(w));
}

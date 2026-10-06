import type { Application, Job } from '../engine/types';
import type { Credentials } from './credentials';
import type { Profile } from '../config/schema';
import type { SerializedFile } from './serialized-file';
import { appliedJobIds, computeStats, type Stats } from '../engine/stats';

// Repository adapter: the only place that touches chrome.storage.
// Pure computation lives in engine/stats.ts; this file just supplies data + clock.
const KEY = 'applications';
// One run per site, so sites run in PARALLEL (2026-10-04, owner: "there should be parallelism").
// `run_state` (no suffix) is the pre-parallel key; it is read as its own site's run and migrated.
const LEGACY_STATE_KEY = 'run_state';
const STATE_PREFIX = 'run_state:';
const PROGRESS_KEY = 'run_progress';
const stateKey = (siteId: string): string => `${STATE_PREFIX}${siteId}`;
const progressKey = (siteId?: string): string => (siteId ? `${PROGRESS_KEY}:${siteId}` : PROGRESS_KEY);

// Live run status, persisted so the (ephemeral MV3) popup can show what's happening even after it
// closes — the worker tab activating closes the popup, so in-memory progress would otherwise be lost.
export interface RunProgress {
  readonly done: number;
  readonly total: number;
  readonly current: string;
  readonly phase: 'running' | 'done' | 'paused'; // paused = waiting for the user to log the next account in
  readonly at: number; // epoch ms of last update
}

/** Progress for one site's run (`siteId`), or the shared slot the in-page packs and the popup use.
 *  A site's progress is mirrored into the shared slot too, so the popup's "last thing happening"
 *  keeps working. */
export async function saveProgress(p: RunProgress, siteId?: string): Promise<void> {
  await chrome.storage.local.set(siteId ? { [progressKey(siteId)]: p, [PROGRESS_KEY]: p } : { [PROGRESS_KEY]: p });
}

export async function getProgress(siteId?: string): Promise<RunProgress | null> {
  const k = progressKey(siteId);
  const got = await chrome.storage.local.get(k);
  return (got[k] as RunProgress | undefined) ?? null;
}

/** Persisted run state, so an alarm-driven step survives service-worker termination. */
export interface RunState {
  /** The observability Run this queue belongs to. In storage, not module scope: the SW dies
   *  between jobs and the next wake must keep writing to the SAME Run (app/observe.ts). */
  readonly runId?: string;
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

/** Persist the run so a killed service worker resumes from it. The queue is the big part, and the
 *  10 MB budget is shared with the records and the log, so a quota rejection is possible however
 *  well QUEUE_CAP is chosen — machines differ in how much history has piled up. Halve the queue and
 *  retry rather than failing the start: a shorter queue still applies to jobs, and what is dropped
 *  is picked up by the next run (applied ids are excluded). Failing to start drops everything. */
export async function saveRunState(s: RunState): Promise<void> {
  let state = s;
  for (let attempt = 0; ; attempt++) {
    try {
      await chrome.storage.local.set({ [stateKey(state.siteId)]: state });
      return;
    } catch (e) {
      const half = Math.floor(state.queue.length / 2);
      if (half < 1 || attempt >= 8) throw e; // nothing left to shed — the caller must see this
      console.warn('[jobbot] run state too large for storage — halving the queue to', half, (e as Error).message);
      state = { ...state, queue: state.queue.slice(0, half) };
    }
  }
}

/** That site's run, or — with no site — the first run in progress (for callers that predate
 *  parallel runs and only ever had one). */
export async function getRunState(siteId?: string): Promise<RunState | null> {
  await migrateLegacyState();
  if (!siteId) return (await listRunStates())[0] ?? null;
  const k = stateKey(siteId);
  const got = await chrome.storage.local.get(k);
  return (got[k] as RunState | undefined) ?? null;
}

/** Every site's run in progress (paused ones included). */
export async function listRunStates(): Promise<RunState[]> {
  await migrateLegacyState();
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(STATE_PREFIX))
    .map(([, v]) => v as RunState)
    .filter((s) => !!s?.siteId);
}

export async function clearRunState(siteId?: string): Promise<void> {
  if (siteId) return void (await chrome.storage.local.remove([stateKey(siteId), progressKey(siteId)]));
  const all = await listRunStates();
  await chrome.storage.local.remove(all.flatMap((s) => [stateKey(s.siteId), progressKey(s.siteId)]));
}

async function migrateLegacyState(): Promise<void> {
  const got = await chrome.storage.local.get(LEGACY_STATE_KEY);
  const old = got[LEGACY_STATE_KEY] as RunState | undefined;
  if (!old) return;
  if (old.siteId) await chrome.storage.local.set({ [stateKey(old.siteId)]: old });
  await chrome.storage.local.remove(LEGACY_STATE_KEY);
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

/** Every job id never to apply to again: this browser's applied records, plus the on-disk
 *  registry's (every account, every machine) that `npm run install:chrome` ships in the profile
 *  seed under `seed_applied_ids` (profile-seed.ts) — readable here without the folder grant. */
export async function appliedIds(): Promise<Set<string>> {
  const ids = appliedJobIds(await readAll());
  const got = await chrome.storage.local.get('seed_applied_ids');
  for (const id of (got['seed_applied_ids'] as string[] | undefined) ?? []) ids.add(id);
  return ids;
}

/** Jobs this site PARKED after \`since\` (epoch ms): they wait on an answer only the user can give,
 *  so a repeat run that re-fills them every 30 min just repeats the park (Lever: the same 139 jobs,
 *  all night, 2026-10-05). Failed ones are not here — a failure is usually transient, retry it. */
export async function parkedSince(siteId: string, since: number): Promise<Set<string>> {
  const out = new Set<string>();
  for (const a of await readAll()) {
    if (a.company !== siteId || a.status !== 'parked') continue;
    const at = Date.parse(a.at ?? a.date);
    if (Number.isFinite(at) && at > since) out.add(a.jobId);
  }
  return out;
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

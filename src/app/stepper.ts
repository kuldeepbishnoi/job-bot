import type { RunPorts } from './runner';
import { applyOne } from './runner';
import { siteById } from '../sites';
import type { Profile } from '../config/schema';
import type { Site } from '../sites';
import type { RunState } from '../platform/store';
import type { SerializedFile } from '../platform/serialized-file';
import { selectJobs } from '../engine/select-jobs';
import { saveRunState, getRunState, clearRunState, getProgress, appliedTodayCount, saveProgress, getAccount, setAccount } from '../platform/store';

// MV3 service workers get killed after ~30s idle (and can't run for hours). So we DON'T loop the
// whole queue in one await. Instead: persist the queue, process ONE job, then schedule an alarm
// that re-wakes the worker for the next job. State lives in storage, so a killed SW resumes cleanly.
export const STEP_ALARM = 'jobbot-step';
export const WATCHDOG_ALARM = 'jobbot-watchdog';
const GAP_MINUTES = 0.5; // alarm backup between jobs (30s is the chrome.alarms minimum)
const PACE_MS = 6_000; // the real gap: a timer drives the next job while the SW is still awake
let stepping = false; // one step at a time — the timer and the backup alarm can both fire
// A step that shows no progress for this long is presumed dead (SW killed mid-apply, a tab that
// never answered…). The apply port caps one job at 4 min, so 6 min means the alarm chain broke.
const STALL_MS = 6 * 60 * 1000;

// A run whose service worker died mid-step never reaches finish(); its run_state would otherwise
// sit there forever. Progress is stamped on every step, so "no progress for this long" = dead.
const STALE_RUN_MS = 2 * 60 * 60 * 1000;

/** Is a run genuinely in progress? A stale one (no progress for 2h) is cleared and reported false. */
export async function runInProgress(now = Date.now()): Promise<boolean> {
  const state = await getRunState();
  if (!state) return false;
  const p = await getProgress();
  if (p && p.phase === 'running' && now - p.at < STALE_RUN_MS) return true;
  await clearRunState();
  return false;
}

/** Popup -> background: build the queue and process the first job now. */
export async function startRun(
  siteId: string,
  profile: Profile,
  resume: SerializedFile,
  ports: RunPorts,
  exclude: readonly string[] = [], // job ids applied to by ANY account (shared registry)
): Promise<void> {
  const site = siteById(siteId);
  if (!site) throw new Error(`unknown site ${siteId}`);

  const already = new Set([...(await ports.appliedIds()), ...exclude]);
  const all = selectJobs(await ports.discover(site, profile), profile.want).filter((j) => !already.has(j.id));
  const queue = profile.max_per_run ? all.slice(0, profile.max_per_run) : all;
  await saveRunState({ siteId, profile, resume, queue, cursor: 0 });

  // Backup driver: the owner's rule is "it never stops running". The step alarm is created only
  // AFTER a step completes, so a step that dies leaves no alarm — the watchdog re-drives it.
  await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
  await step(ports); // do the first one immediately (SW is alive during the click)
}

/** Watchdog tick: a run exists but hasn't progressed for STALL_MS → drive the current job again. */
export async function watchdog(ports: RunPorts, now = Date.now()): Promise<void> {
  const state = await getRunState();
  if (!state) {
    await chrome.alarms.clear(WATCHDOG_ALARM);
    return;
  }
  if (state.paused) return; // waiting on the user — not a stall
  const p = await getProgress();
  const stalled = !p || p.phase !== 'running' || now - p.at > STALL_MS;
  const armed = (await chrome.alarms.get(STEP_ALARM)) !== undefined;
  if (stalled && !armed) {
    console.warn('[jobbot] watchdog: run stalled at', state.cursor, '/', state.queue.length, '— re-driving');
    await step(ports);
  }
}

/** Process exactly one job, advance the cursor, and schedule the next wake (or finish).
 *  The next job is driven by a short timer (the SW is awake right after a step); the alarm is
 *  the backup for when the SW is torn down before the timer fires. */
export async function step(ports: RunPorts): Promise<void> {
  if (stepping) return;
  stepping = true;
  try {
    await chrome.alarms.clear(STEP_ALARM); // whichever driver got here first owns this step
    const state = await getRunState();
    if (!state) return;
    if (state.paused) return; // waiting for the user to log the next account in (popup → resume)

    const site = siteById(state.siteId);
    if (!site || state.cursor >= state.queue.length) return finish(ports);

    // Per-account daily limit (Amazon: 10) → rotate to the next account that still has room.
    const limit = state.profile.per_account_limit;
    if (limit && (await appliedTodayCount(await getAccount())) >= limit) return rotateAccount(site, state, ports, `limit ${limit}/day reached`);

    const job = state.queue[state.cursor]!;
    ports.progress(state.cursor, state.queue.length, job.title);
    const result = await applyOne(site, job, state.profile, state.resume, ports);
    await ports.record(result);
    // The ATS's own cap ("application limit reached") — rotate now; retry this job on the next account.
    if (result.status === 'failed' && /limit reached/i.test(result.note ?? '')) return rotateAccount(site, state, ports, result.note ?? 'limit reached');

    await saveRunState({ ...state, cursor: state.cursor + 1 });
    await chrome.alarms.create(STEP_ALARM, { delayInMinutes: GAP_MINUTES });
    setTimeout(() => void step(ports), PACE_MS);
  } finally {
    stepping = false;
  }
}

/** Next account in profile.accounts with room left today, or null when all are exhausted. */
async function nextAccountWithRoom(profile: Profile, current: string): Promise<string | null> {
  const limit = profile.per_account_limit ?? Number.POSITIVE_INFINITY;
  for (const a of profile.accounts) {
    if (a === current) continue;
    if ((await appliedTodayCount(a)) < limit) return a;
  }
  return null;
}

/** Log the current account out in the worker tab, open the login page, and pause the run until
 *  the user logs the next account in and clicks Resume. Credentials never touch the extension. */
async function rotateAccount(site: Site, state: RunState, ports: RunPorts, reason: string): Promise<void> {
  const current = await getAccount();
  const next = await nextAccountWithRoom(state.profile, current);
  if (!next) return finish(ports, `${reason} — every account in profile.accounts is at its limit for today`);
  if (site.logoutUrl) await ports.openJob(site.logoutUrl).catch(() => {});
  if (site.loginUrl) await ports.openJob(site.loginUrl).catch(() => {});
  await saveRunState({ ...state, paused: { reason, nextAccount: next } });
  await chrome.alarms.clear(STEP_ALARM);
  await saveProgress({ done: state.cursor, total: state.queue.length, current: `${reason} for ${current || 'this account'}. Log in as ${next} in the JobBot tab, then click Resume.`, phase: 'paused', at: Date.now() });
}

/** Popup -> background: the user logged the next account in. */
export async function resumeRun(ports: RunPorts): Promise<void> {
  const state = await getRunState();
  if (!state?.paused) return;
  await setAccount(state.paused.nextAccount);
  await saveRunState({ ...state, paused: undefined });
  await saveProgress({ done: state.cursor, total: state.queue.length, current: `resumed as ${state.paused.nextAccount}`, phase: 'running', at: Date.now() });
  await step(ports);
}

/** Popup -> background: abandon the run. Whatever job is mid-flight in the worker tab is left as-is
 *  (Amazon auto-saves progress server-side, so a half-filled apply can be resumed by hand). */
export async function stopRun(ports: RunPorts): Promise<void> {
  await finish(ports);
}

async function finish(ports: RunPorts, note?: string): Promise<void> {
  await chrome.alarms.clear(STEP_ALARM);
  await chrome.alarms.clear(WATCHDOG_ALARM);
  await clearRunState();
  await ports.cleanup();
  if (note) {
    const p = await getProgress();
    await saveProgress({ done: p?.done ?? 0, total: p?.total ?? 0, current: note, phase: 'done', at: Date.now() });
  }
}

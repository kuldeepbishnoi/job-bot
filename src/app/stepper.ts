import type { RunPorts } from './runner';
import { applyOne } from './runner';
import { siteById } from '../sites';
import type { Profile } from '../config/schema';
import type { SerializedFile } from '../platform/serialized-file';
import { selectJobs } from '../engine/select-jobs';
import { saveRunState, getRunState, clearRunState, getProgress } from '../platform/store';

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
): Promise<void> {
  const site = siteById(siteId);
  if (!site) throw new Error(`unknown site ${siteId}`);

  const already = await ports.appliedIds();
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

    const site = siteById(state.siteId);
    if (!site || state.cursor >= state.queue.length) return finish(ports);

    const job = state.queue[state.cursor]!;
    ports.progress(state.cursor, state.queue.length, job.title);
    await ports.record(await applyOne(site, job, state.profile, state.resume, ports));

    await saveRunState({ ...state, cursor: state.cursor + 1 });
    await chrome.alarms.create(STEP_ALARM, { delayInMinutes: GAP_MINUTES });
    setTimeout(() => void step(ports), PACE_MS);
  } finally {
    stepping = false;
  }
}

/** Popup -> background: abandon the run. Whatever job is mid-flight in the worker tab is left as-is
 *  (Amazon auto-saves progress server-side, so a half-filled apply can be resumed by hand). */
export async function stopRun(ports: RunPorts): Promise<void> {
  await finish(ports);
}

async function finish(ports: RunPorts): Promise<void> {
  await chrome.alarms.clear(STEP_ALARM);
  await chrome.alarms.clear(WATCHDOG_ALARM);
  await clearRunState();
  await ports.cleanup();
}

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
const GAP_MINUTES = 0.5; // ~30s between jobs — pacing + politeness (also the alarm minimum)

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
  const queue = selectJobs(await ports.discover(site, profile), profile.want).filter((j) => !already.has(j.id));
  await saveRunState({ siteId, profile, resume, queue, cursor: 0 });

  await step(ports); // do the first one immediately (SW is alive during the click)
}

/** Process exactly one job, advance the cursor, and schedule the next wake (or finish). */
export async function step(ports: RunPorts): Promise<void> {
  const state = await getRunState();
  if (!state) return;

  const site = siteById(state.siteId);
  if (!site || state.cursor >= state.queue.length) return finish(ports);

  const job = state.queue[state.cursor]!;
  ports.progress(state.cursor, state.queue.length, job.title);
  await ports.record(await applyOne(site, job, state.profile, state.resume, ports));

  await saveRunState({ ...state, cursor: state.cursor + 1 });
  chrome.alarms.create(STEP_ALARM, { delayInMinutes: GAP_MINUTES });
}

async function finish(ports: RunPorts): Promise<void> {
  await chrome.alarms.clear(STEP_ALARM);
  await clearRunState();
  await ports.cleanup();
}

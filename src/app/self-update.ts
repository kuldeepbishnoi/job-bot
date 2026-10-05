// Updates load themselves (owner, 2026-10-04: "it should be auto handled"). `npm run install:chrome`
// stamps the build (build.json in the unpacked folder — Chrome serves an unpacked extension's files
// from disk, so a new stamp is visible without a reload). Once a minute we compare; a newer build
// reloads the extension, but only between jobs. After ANY start — a self-reload, Chrome's own
// restart, a manual Reload — `resumeAfterRestart` re-arms what a reload can drop (alarms) and
// re-kicks the page loops, so every run carries on from its persisted state.
import { listRunStates } from '../platform/store';
import { stepAlarm, WATCHDOG_ALARM, isStepping } from './stepper';
import { getLinkedinRun, LINKEDIN_WATCHDOG_ALARM } from './linkedin-run';
import { instahyreAgain } from './instahyre-run';
import { dlog } from '../platform/debug-log';

export const SELF_UPDATE_ALARM = 'jobbot-self-update';
let loaded: string | null = null;

async function readStamp(): Promise<string | null> {
  try {
    const r = await fetch(chrome.runtime.getURL('build.json'), { cache: 'no-store' });
    return r.ok ? String(((await r.json()) as { at?: unknown }).at ?? '') || null : null;
  } catch {
    return null;
  }
}

/** On every service-worker start: remember which build is running, and keep checking. */
export async function initSelfUpdate(): Promise<void> {
  loaded = await readStamp();
  await chrome.alarms.create(SELF_UPDATE_ALARM, { periodInMinutes: 1 });
}

/** Set while a new build waits: the stepper finishes the job in flight but starts no new one, so
 *  parallel sites drain to a gap instead of never having one (2026-10-05: "waiting — a job is
 *  mid-flight" every minute for an hour with four sites running). */
export const UPDATE_PENDING_KEY = 'update_pending_since';
const LINKEDIN_GRACE_MS = 3 * 60_000; // LinkedIn's page loop never pauses; its recovery resumes it

export async function checkForUpdate(): Promise<void> {
  const now = await readStamp();
  if (!now || !loaded || now === loaded) return;
  const got = await chrome.storage.local.get(UPDATE_PENDING_KEY);
  const since = (got[UPDATE_PENDING_KEY] as number | undefined) ?? Date.now();
  if (got[UPDATE_PENDING_KEY] === undefined) await chrome.storage.local.set({ [UPDATE_PENDING_KEY]: since });
  if (isStepping()) return void dlog('self-update', 'new build waiting — draining the worker job in flight');
  const li = await getLinkedinRun().catch(() => null);
  if (li && Date.now() - li.lastActivityAt < 45_000 && Date.now() - since < LINKEDIN_GRACE_MS) return void dlog('self-update', 'new build waiting — LinkedIn mid-job');
  dlog('self-update', 'new build installed — reloading', { from: loaded, to: now });
  await chrome.storage.local.remove(UPDATE_PENDING_KEY);
  chrome.runtime.reload();
}

/** After a (re)start: re-arm each run's driver and the page loops. Idempotent. */
export async function resumeAfterRestart(): Promise<void> {
  await chrome.storage.local.remove(UPDATE_PENDING_KEY); // this IS the new build
  const states = await listRunStates();
  if (states.length) await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
  for (const s of states) {
    if (s.paused) continue;
    if (!(await chrome.alarms.get(stepAlarm(s.siteId)))) await chrome.alarms.create(stepAlarm(s.siteId), { delayInMinutes: 0.5 });
  }
  if (await getLinkedinRun().catch(() => null)) await chrome.alarms.create(LINKEDIN_WATCHDOG_ALARM, { periodInMinutes: 1 });
  // Instahyre's loop lives in the page and dies with the old extension context: start it again.
  const got = await chrome.storage.local.get(['instahyre_run', 'instahyre_again']);
  if (got['instahyre_run'] && got['instahyre_again']) void instahyreAgain().catch(() => {});
  if (states.length) dlog('self-update', 'resumed after restart', states.map((s) => s.siteId));
}

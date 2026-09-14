import type { RunPorts } from './runner';
import { applyOne } from './runner';
import { siteById } from '../sites';
import type { Profile } from '../config/schema';
import type { Site } from '../sites';
import type { RunState } from '../platform/store';
import type { Application, Job } from '../engine/types';
import type { SerializedFile } from '../platform/serialized-file';
import { selectJobs, spreadAcrossEmployers } from '../engine/select-jobs';
import { saveRunState, getRunState, clearRunState, getProgress, appliedTodayCount, saveProgress, getAccount, setAccount } from '../platform/store';
import { passwordFor, accountsFor, credentialsFor } from '../platform/credentials';
import { readRegistry } from '../platform/fs-config';
import { accountsAtLimitToday } from '../platform/store';
import type { Run } from '../engine/records';
import * as observe from './observe';

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
// A persisted queue this long is ~1.4 MB of the 10 MB chrome.storage budget. Beyond it we would be
// trading the records and the log for jobs this run was never going to reach anyway.
export const QUEUE_CAP = 5000;
// A single job may hold the run this long. Longer than the apply cap (4 min) so a normal slow apply
// is never cut short, short enough that one wedged job costs minutes, not a whole run.
export const JOB_DEADLINE_MS = 7 * 60 * 1000;

// A run whose service worker died mid-step never reaches finish(); its run_state would otherwise
// sit there forever. Progress is stamped on every step, so "no progress for this long" = dead.
const STALE_RUN_MS = 2 * 60 * 60 * 1000;

/** Is a run genuinely in progress? A stale one (no progress for 2h) is cleared and reported false. */
export async function runInProgress(now = Date.now()): Promise<boolean> {
  const state = await getRunState();
  if (!state) return false;
  // A run PAUSED for an account rotation is still a run: its queue is the user's, and they were
  // told to click "Resume as next account". Deleting it here meant the daily alarm silently threw
  // the queue away and Resume then reported success while doing nothing.
  if (state.paused) return true;
  const p = await getProgress();
  if (p && p.phase === 'running' && now - p.at < STALE_RUN_MS) return true;
  await clearRunState();
  // The run never reached finish() — say so instead of letting it sit "running" in the console.
  await observe.runEnded(state.runId ?? null, 'dead', p ? deadReason(now - p.at) : 'the run never reported progress — presumed dead');
  return false;
}

const deadReason = (ageMs: number): string => `no progress for ${Math.max(1, Math.round(ageMs / 60_000))} min — presumed dead`;

/** Popup -> background: build the queue and process the first job now. */
export async function startRun(
  siteId: string,
  profile: Profile,
  resume: SerializedFile,
  ports: RunPorts,
  exclude: readonly string[] = [], // job ids applied to by ANY account (shared registry)
  credentials?: RunState['credentials'],
  trigger: Run['trigger'] = 'manual',
): Promise<void> {
  const site = siteById(siteId);
  if (!site) throw new Error(`unknown site ${siteId}`);

  // Rotation identifies "the account we just tried" by getAccount(). If that does not actually
  // name one of this site's candidates, nextAccountWithRoom cannot tell the logged-in account from
  // an untried one and can pick the SAME account that just hit a limit — a pointless logout→login
  // that lands back on the capped account and repeats the failure. The per-account daily count is
  // stamped from the same value, so a wrong one also blows past the ATS's real cap.
  //
  // Only sites that can actually rotate are gated: rotateAccount needs somewhere to log in, so a
  // pack with no loginUrl (Datadog, the board packs) must never be blocked by an account field it
  // has no concept of. Compared case-insensitively, because parseCredentialsCsv lowercases emails
  // while setAccount and the schema do not — a case mismatch is not a different person.
  const rotatable = !!site.loginUrl;
  const candidates = accountsFor(credentials, site.id).length ? accountsFor(credentials, site.id) : profile.accounts;
  if (rotatable && candidates.length > 1) {
    const current = (await getAccount()).trim().toLowerCase();
    const known = candidates.map((a) => a.trim().toLowerCase());
    if (!current || !known.includes(current)) {
      throw new Error(
        `${site.label} has ${candidates.length} accounts configured but the Account field ${current ? `says "${current}", which is not one of them` : 'is empty'} — set it to whichever account is logged in before starting (${candidates.join(', ')})`,
      );
    }
  }

  // The shared registry is what stops N accounts re-applying to the same job. An extension page
  // passes it in; the daily alarm has no page, so read it here rather than run without it. The
  // worker CAN read it: writeRecord already writes that folder from this same context, and the
  // gesture-only APIs are the picker and requestPermission, neither of which this touches.
  const registry = exclude.length ? exclude : [...(await readRegistry().catch(() => new Set<string>()))];
  const already = new Set([...(await ports.appliedIds()), ...registry]);
  // Spread before capping: the cap takes the head of the queue, and a multi-company pack discovers
  // alphabetically, so an uninterleaved queue sends every application of a capped run to whichever
  // employer sorts first.
  const all = spreadAcrossEmployers(selectJobs(await ports.discover(site, profile), profile.want).filter((j) => !already.has(j.id)));
  // The queue is PERSISTED (a killed service worker resumes from it), and chrome.storage.local is
  // 10 MB shared with the application records and the log. A multi-company pack walking hundreds of
  // boards discovers tens of thousands of jobs — ~277 bytes each, so ~36k jobs alone would fill the
  // quota and the run would fail to start at all. Cap what we keep, and say so rather than letting
  // the rest vanish silently: the next run picks them up, because applied ids are excluded.
  // max_per_run is the blast radius: with auto_submit on, this many real applications. 0 = the
  // user explicitly lifted the limit; anything else caps here, defaulted by the schema so removing
  // the line from profile.yaml cannot silently mean "apply to everything discovered".
  const wanted = profile.max_per_run ? all.slice(0, profile.max_per_run) : all;
  const queue = wanted.slice(0, QUEUE_CAP);
  const dropped = wanted.length - queue.length;
  // One Run record per run, before any job: the console's whole view of this run hangs off it.
  const runId = await observe.runStarted({
    siteId,
    kind: 'worker',
    trigger,
    account: await getAccount(),
    autoSubmit: profile.auto_submit,
    onUnknown: profile.on_unknown,
    queued: queue.length,
    resumeName: resume.name,
    config: {
      selected: `${queue.length} of ${all.length} discovered${dropped ? `, ${dropped} left for the next run (queue capped at ${QUEUE_CAP})` : ''}`,
      excluded: String(already.size),
      ...(profile.max_per_run ? { max_per_run: String(profile.max_per_run) } : {}),
      ...(profile.per_account_limit ? { per_account_limit: String(profile.per_account_limit) } : {}),
    },
  });
  // Only this site's logins go into storage — an Amazon run has no business holding the Datadog
  // passwords, and run_state is an unencrypted LevelDB file until the run ends.
  // The runId lives there too, not in module scope: the SW dies between jobs and the next wake
  // must keep writing to the SAME Run.
  await saveRunState({ siteId, profile, resume, queue, cursor: 0, credentials: credentialsFor(credentials, siteId), ...(runId ? { runId } : {}) });

  // Backup driver: the owner's rule is "it never stops running". The step alarm is created only
  // AFTER a step completes, so a step that dies leaves no alarm — the watchdog re-drives it.
  await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
  await step(ports); // do the first one immediately (SW is alive during the click)
}


/** Resolve with `onTimeout()` if `p` has not settled in time. The work is not cancellable — we
 *  simply stop waiting on it — so whatever it eventually does must be harmless: the abandoned
 *  apply's own record write is skipped by the run-generation check in `step`. */
async function withDeadline<T>(p: Promise<T>, ms: number, onTimeout: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((r) => (timer = setTimeout(() => r('late'), ms)));
  try {
    const winner = await Promise.race([p, late]);
    return winner === 'late' ? await onTimeout() : (winner as T);
  } finally {
    clearTimeout(timer);
  }
}

/** The record for a job we abandoned — it must still appear, with the reason, not vanish. */
async function mkFailed(site: Site, job: Job, ports: RunPorts, note: string): Promise<Application> {
  await observe.event('warn', 'apply', `${job.id} ${note}`, undefined, { jobId: job.id, siteId: site.id });
  return { company: site.id, jobId: job.id, title: job.title, url: job.url, date: ports.today(), status: 'failed', note };
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
  // Re-driving forever hides a broken run. Past STALE_RUN_MS with no progress at all, give up
  // loudly — the console shows 'dead' with the age, instead of a run that never ends.
  if (p && now - p.at > STALE_RUN_MS) {
    await giveUp(ports, state, deadReason(now - p.at));
    return;
  }
  const stalled = !p || p.phase !== 'running' || now - p.at > STALL_MS;
  const armed = (await chrome.alarms.get(STEP_ALARM)) !== undefined;
  if (stalled && !armed) {
    console.warn('[jobbot] watchdog: run stalled at', state.cursor, '/', state.queue.length, '— re-driving');
    await observe.event('warn', 'run', `watchdog: stalled at ${state.cursor}/${state.queue.length} — re-driving`, undefined, { runId: state.runId ?? undefined, siteId: state.siteId });
    await step(ports);
  }
}

/** The watchdog's last resort: tear the run down and mark the Run dead with the evidence. */
async function giveUp(ports: RunPorts, state: RunState, reason: string): Promise<void> {
  await chrome.alarms.clear(STEP_ALARM);
  await chrome.alarms.clear(WATCHDOG_ALARM);
  await clearRunState();
  await ports.cleanup().catch(() => {});
  await observe.runEnded(state.runId ?? null, 'dead', reason);
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
    // A new SW generation: re-attach to the Run this queue belongs to before writing anything.
    const runId = state.runId ?? null;
    if (runId && observe.activeRunId() !== runId) await observe.adoptRun(runId);

    const site = siteById(state.siteId);
    if (!site) return finish(ports, `unknown site ${state.siteId}`);
    if (state.cursor >= state.queue.length) return finish(ports, `queue exhausted (${state.cursor}/${state.queue.length})`);

    // Per-account daily limit (Amazon: 10) → rotate to the next account that still has room.
    const limit = state.profile.per_account_limit;
    if (limit && (await appliedTodayCount(await getAccount(), site.id)) >= limit) return rotateAccount(site, state, ports, `limit ${limit}/day reached on ${site.id}`);

    const job = state.queue[state.cursor]!;
    ports.progress(state.cursor, state.queue.length, job.title);
    await observe.runStep(runId, { jobId: job.id, title: job.title, step: 'apply', since: Date.now() });
    // One job can never hold the run forever. ports.apply caps the content script, but openJob, the
    // OTP poll and a frame retry sit outside it, and a step that hangs blocks every later job: the
    // watchdog cannot help, because it politely returns while `stepping` is true.
    const result = await withDeadline(
      applyOne(site, job, state.profile, state.resume, ports),
      JOB_DEADLINE_MS,
      () => mkFailed(site, job, ports, `gave up after ${Math.round(JOB_DEADLINE_MS / 60_000)} min on this job — moving to the next`),
    );
    await ports.record(result);
    await observe.runOutcome(runId, result.status);

    // Stop clears the run state, but THIS step was already in flight and would otherwise re-save it
    // below — resurrecting the queue and its alarms. That is why Stop appeared to do nothing. The
    // record above still lands: an application that was submitted happened, whatever the user clicked.
    const live = await getRunState();
    if (!live || (live.runId ?? null) !== runId) {
      await observe.event('info', 'run', 'stopped mid-job — not continuing', { jobId: job.id });
      return;
    }

    // The ATS's own cap ("application limit reached") — rotate now; retry this job on the next account.
    if (result.status === 'failed' && /limit reached/i.test(result.note ?? '')) return rotateAccount(site, live, ports, result.note ?? 'limit reached');

    await saveRunState({ ...live, cursor: live.cursor + 1 });
    await chrome.alarms.create(STEP_ALARM, { delayInMinutes: GAP_MINUTES });
    setTimeout(() => void step(ports), PACE_MS);
  } finally {
    stepping = false;
  }
}

/** Next login with room left today: the CSV's logins for this site, else profile.accounts. An
 *  account that hit the ATS's limit page today is skipped too (we record that as a failed note). */
async function nextAccountWithRoom(site: Site, state: RunState, current: string): Promise<string | null> {
  const candidates = accountsFor(state.credentials, site.id).length ? accountsFor(state.credentials, site.id) : state.profile.accounts;
  const limit = state.profile.per_account_limit ?? Number.POSITIVE_INFINITY;
  const capped = await accountsAtLimitToday(site.id);
  for (const a of candidates) {
    if (a === current || capped.has(a)) continue;
    if ((await appliedTodayCount(a, site.id)) < limit) return a;
  }
  return null;
}

/** Log the current account out in the worker tab, open the login page, and pause the run until
 *  the user logs the next account in and clicks Resume. Credentials never touch the extension. */
async function rotateAccount(site: Site, state: RunState, ports: RunPorts, reason: string): Promise<void> {
  const current = await getAccount();
  const next = await nextAccountWithRoom(site, state, current);
  if (!next) return finish(ports, `${reason} — every account is at its limit for today`);
  if (site.logoutUrl) await ports.openJob(site.logoutUrl).catch(() => {});
  const tabId = site.loginUrl ? await ports.openJob(site.loginUrl).catch(() => -1) : -1;
  // With credentials on file, log the next account in ourselves (email → password → emailed code).
  const password = passwordFor(state.credentials, site.id, next);
  if (tabId >= 0 && password) {
    await saveProgress({ done: state.cursor, total: state.queue.length, current: `${reason} — logging in as ${next}…`, phase: 'running', at: Date.now() });
    // ports.login can THROW (its waitForFrame gives up when no content script answers, e.g. the
    // login URL redirected to a logged-in page). Unguarded, that rejected the whole step: the
    // pause was never written, the alarm was already cleared, and the watchdog re-drove the same
    // rotation every few minutes forever with the credentials still in storage.
    const res = await ports.login(tabId, next, password).catch((e: Error) => ({ ok: false as const, note: `login threw: ${e.message}` }));
    if (res.ok) {
      await setAccount(next);
      await observe.runResumed(state.runId ?? null, `auto-login: switched to ${next}`);
      await saveProgress({ done: state.cursor, total: state.queue.length, current: `switched to ${next}`, phase: 'running', at: Date.now() });
      await chrome.alarms.create(STEP_ALARM, { delayInMinutes: GAP_MINUTES });
      setTimeout(() => void step(ports), PACE_MS);
      return;
    }
    reason = `${reason}; auto-login as ${next} failed: ${res.note ?? 'unknown'}`;
  }
  await saveRunState({ ...state, paused: { reason, nextAccount: next } });
  await observe.runPaused(state.runId ?? null, reason, next); // the console shows what the user must do
  await chrome.alarms.clear(STEP_ALARM);
  await saveProgress({ done: state.cursor, total: state.queue.length, current: `${reason} for ${current || 'this account'}. Log in as ${next} in the JobBot tab, then click Resume.`, phase: 'paused', at: Date.now() });
}

/** Popup -> background: the user logged the next account in. */
export async function resumeRun(ports: RunPorts): Promise<void> {
  const state = await getRunState();
  if (!state?.paused) return;
  await setAccount(state.paused.nextAccount);
  await saveRunState({ ...state, paused: undefined });
  await observe.runResumed(state.runId ?? null, `resumed as ${state.paused.nextAccount}`);
  await saveProgress({ done: state.cursor, total: state.queue.length, current: `resumed as ${state.paused.nextAccount}`, phase: 'running', at: Date.now() });
  await step(ports);
}

/** Popup -> background: abandon the run. Whatever job is mid-flight in the worker tab is left as-is
 *  (Amazon auto-saves progress server-side, so a half-filled apply can be resumed by hand). */
export async function stopRun(ports: RunPorts): Promise<void> {
  if (!(await getRunState())) return void (await ports.cleanup()); // no worker run — just tidy the window
  await finish(ports, 'stopped by you', 'stopped');
}

/** Every exit goes through here, and every exit names its reason — a run that ends silently is
 *  exactly what the old UI did that hid failures. */
async function finish(ports: RunPorts, reason: string, phase: 'done' | 'stopped' = 'done'): Promise<void> {
  const state = await getRunState();
  await chrome.alarms.clear(STEP_ALARM);
  await chrome.alarms.clear(WATCHDOG_ALARM);
  await clearRunState();
  await ports.cleanup();
  await observe.runEnded(state?.runId ?? null, phase, reason); // only ever this run's id — another pack's may be active
  const p = await getProgress();
  await saveProgress({ done: p?.done ?? 0, total: p?.total ?? 0, current: reason, phase: 'done', at: Date.now() });
}

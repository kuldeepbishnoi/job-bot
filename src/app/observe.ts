import type { LogEvent, LogLevel, Run } from '../engine/records';
import { beginRun, updateRun, heartbeat, bumpCounts, endRun, getRun } from '../platform/data/runs';
import { appendEvents } from '../platform/data/events';
import { putDataUrlCapture } from '../platform/data/captures';
import { dlog } from '../platform/debug-log';

// The observability seam. Run orchestration (stepper, linkedin-run, instahyre-run) calls these
// instead of reaching into storage, so "what is this run doing" has exactly one writer and the
// console never has to infer state from a progress string.
//
// Every call is best-effort: observability must never fail an application. A throw here would
// abandon a job that was otherwise about to be submitted, so everything is swallowed and logged.

let currentRunId: string | null = null;

export function activeRunId(): string | null {
  return currentRunId;
}

export async function runStarted(init: {
  siteId: string;
  kind: Run['kind'];
  trigger: Run['trigger'];
  account: string;
  autoSubmit: boolean;
  onUnknown: Run['onUnknown'];
  queued?: number;
  resumeName?: string;
  tabId?: number;
  config?: Record<string, string>;
}): Promise<string | null> {
  try {
    const run = await beginRun({
      siteId: init.siteId,
      kind: init.kind,
      trigger: init.trigger,
      account: init.account,
      autoSubmit: init.autoSubmit,
      onUnknown: init.onUnknown,
      ...(init.resumeName ? { resumeName: init.resumeName } : {}),
      ...(init.tabId !== undefined ? { tabId: init.tabId } : {}),
      ...(init.config ? { config: init.config } : {}),
    });
    currentRunId = run.runId;
    if (init.queued !== undefined) await updateRun(run.runId, { counts: { ...run.counts, queued: init.queued } });
    await event('info', 'run', `run started on ${init.siteId}`, { trigger: init.trigger, queued: init.queued });
    return run.runId;
  } catch (e) {
    dlog('observe', 'runStarted failed', (e as Error).message);
    return null;
  }
}

/** Stamp liveness + what the run is doing right now. The console derives alive/stalled/dead from it. */
export async function runStep(runId: string | null, current?: Run['current']): Promise<void> {
  if (!runId) return;
  try {
    await heartbeat(runId, current);
  } catch (e) {
    dlog('observe', 'heartbeat failed', (e as Error).message);
  }
}

export async function runOutcome(runId: string | null, status: 'applied' | 'parked' | 'failed' | 'skipped'): Promise<void> {
  if (!runId) return;
  try {
    await bumpCounts(runId, status);
  } catch (e) {
    dlog('observe', 'bumpCounts failed', (e as Error).message);
  }
}

export async function runPaused(runId: string | null, reason: string, nextAccount?: string): Promise<void> {
  if (!runId) return;
  try {
    await updateRun(runId, { phase: 'paused', pause: { reason, ...(nextAccount ? { nextAccount } : {}) } });
    await event('warn', 'run', `paused: ${reason}`, { nextAccount });
  } catch (e) {
    dlog('observe', 'runPaused failed', (e as Error).message);
  }
}

export async function runResumed(runId: string | null, note: string): Promise<void> {
  if (!runId) return;
  try {
    await updateRun(runId, { phase: 'running', pause: undefined });
    await event('info', 'run', note);
  } catch (e) {
    dlog('observe', 'runResumed failed', (e as Error).message);
  }
}

/** Always give a reason. "Done" with no reason is the thing the old UI did that hid failures. */
export async function runEnded(runId: string | null, phase: 'done' | 'stopped' | 'dead', reason: string): Promise<void> {
  if (!runId) return;
  try {
    await endRun(runId, phase, reason);
    await event(phase === 'done' ? 'info' : 'warn', 'run', `run ${phase}: ${reason}`);
  } catch (e) {
    dlog('observe', 'runEnded failed', (e as Error).message);
  } finally {
    if (currentRunId === runId) currentRunId = null;
  }
}

/** One structured log line. Also goes to the legacy flat log, which the on-disk mirror still uses. */
export async function event(
  level: LogLevel,
  scope: string,
  msg: string,
  data?: Record<string, unknown>,
  ctx?: { runId?: string; jobId?: string; siteId?: string },
): Promise<void> {
  const runId = ctx?.runId ?? currentRunId ?? undefined;
  const ev: LogEvent = {
    ts: Date.now(),
    level,
    origin: 'sw',
    scope,
    msg,
    ...(data ? { data } : {}),
    ...(runId ? { runId } : {}),
    ...(ctx?.jobId ? { jobId: ctx.jobId } : {}),
    ...(ctx?.siteId ? { siteId: ctx.siteId } : {}),
  };
  try {
    await appendEvents([ev]);
  } catch (e) {
    dlog('observe', 'appendEvents failed', (e as Error).message);
  }
}

/** Store a screenshot where the console can actually show it (chrome.storage can't hold these). */
export async function capture(args: {
  siteId: string;
  jobId: string;
  label: string;
  dataUrl: string;
  runId?: string;
}): Promise<void> {
  try {
    const meta = await putDataUrlCapture({
      siteId: args.siteId,
      jobId: args.jobId,
      label: args.label,
      dataUrl: args.dataUrl,
      ...(args.runId ?? currentRunId ? { runId: args.runId ?? currentRunId! } : {}),
    });
    await event('debug', 'capture', `captured ${args.label}`, { bytes: meta.bytes }, { jobId: args.jobId, siteId: args.siteId });
  } catch (e) {
    dlog('observe', 'capture failed', (e as Error).message);
  }
}

/** Adopt a run that a previous service-worker generation started (the SW is killed between jobs). */
export async function adoptRun(runId: string): Promise<Run | null> {
  try {
    const run = await getRun(runId);
    if (run) currentRunId = runId;
    return run;
  } catch {
    return null;
  }
}

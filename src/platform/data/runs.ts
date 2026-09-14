// Run index in chrome.storage.local (`runs`, newest last, cap 200). Small enough for storage,
// and storage's onChanged is what the dashboard already listens to. Every mutation here goes
// through one promise chain: step + heartbeat + result can land back to back in the SW, and a
// plain read-modify-write would drop one of them.
import type { Run, RunCounts } from '../../engine/records';
import { EMPTY_COUNTS, runHealth } from '../../engine/records';
import { changes } from './idb';

const KEY = 'runs';
export const RUN_CAP = 200;
const ACTIVE = new Set<Run['phase']>(['discovering', 'running', 'paused']);

let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

async function readAll(): Promise<Run[]> {
  const got = await chrome.storage.local.get(KEY);
  return (got[KEY] as Run[] | undefined) ?? [];
}
async function writeAll(runs: readonly Run[]): Promise<void> {
  await chrome.storage.local.set({ [KEY]: runs.slice(-RUN_CAP) });
  changes.emit('runs');
}

export function listRuns(): Promise<Run[]> {
  return readAll();
}

export async function getRun(runId: string): Promise<Run | null> {
  return (await readAll()).find((r) => r.runId === runId) ?? null;
}

/** Runs in discovering | running | paused — liveness is the UI's call (runHealth), not ours. */
export async function activeRuns(): Promise<Run[]> {
  return (await readAll()).filter((r) => ACTIVE.has(r.phase));
}

export type RunInit = Omit<Run, 'runId' | 'startedAt' | 'heartbeatAt' | 'phase' | 'counts'> & { runId?: string };

export function beginRun(init: RunInit): Promise<Run> {
  return serialized(async () => {
    const now = Date.now();
    const { runId: given, ...rest } = init;
    const run: Run = {
      ...rest,
      runId: given ?? `${init.siteId}-${now.toString(36)}`,
      startedAt: now,
      heartbeatAt: now,
      phase: init.kind === 'worker' ? 'discovering' : 'running', // in-page packs have no discovery step
      counts: EMPTY_COUNTS,
    };
    const others = (await readAll()).filter((r) => r.runId !== run.runId);
    await writeAll([...others, run]);
    return run;
  });
}

/** Merge a patch. Always re-stamps heartbeatAt: a patch IS a sign of life. */
export function updateRun(runId: string, patch: Partial<Run>): Promise<Run | null> {
  return serialized(() => mutate(runId, (r) => ({ ...r, ...patch, runId, heartbeatAt: Date.now() })));
}

export async function heartbeat(runId: string, current?: Run['current']): Promise<void> {
  await updateRun(runId, current ? { current } : {});
}

export async function bumpCounts(runId: string, status: 'applied' | 'parked' | 'failed' | 'skipped'): Promise<void> {
  await serialized(() =>
    mutate(runId, (r) => {
      const counts: RunCounts = { ...r.counts, done: r.counts.done + 1, [status]: r.counts[status] + 1 };
      return { ...r, counts, heartbeatAt: Date.now() };
    }),
  );
}

export async function endRun(runId: string, phase: 'done' | 'stopped' | 'dead', endReason: string): Promise<void> {
  await serialized(() =>
    mutate(runId, (r) => {
      const now = Date.now();
      const { current: _c, pause: _p, ...rest } = r;
      return { ...rest, phase, endReason, endedAt: now, heartbeatAt: now };
    }),
  );
}

/** Flip runs whose heartbeat is older than the pack's dead threshold to 'dead' with an honest end
 *  reason. Does NOT touch heartbeatAt — the stale stamp is the evidence. Returns how many flipped. */
export function markDeadRuns(now: number, deadMsFor: (siteId: string) => number): Promise<number> {
  return serialized(async () => {
    const runs = await readAll();
    let flipped = 0;
    const next = runs.map((r) => {
      const deadMs = deadMsFor(r.siteId);
      if (r.phase === 'dead' || runHealth(r, now, deadMs, deadMs) !== 'dead') return r;
      flipped++;
      const minutes = Math.round((now - r.heartbeatAt) / 60_000);
      const { current: _c, ...rest } = r;
      return { ...rest, phase: 'dead' as const, endedAt: now, endReason: `no heartbeat for ${minutes} min — presumed dead` };
    });
    if (flipped) await writeAll(next);
    return flipped;
  });
}

async function mutate(runId: string, fn: (r: Run) => Run): Promise<Run | null> {
  const runs = await readAll();
  const i = runs.findIndex((r) => r.runId === runId);
  const cur = runs[i];
  if (!cur) return null;
  const next = fn(cur);
  await writeAll([...runs.slice(0, i), next, ...runs.slice(i + 1)]);
  return next;
}

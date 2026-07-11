import type { Application, Job } from '../engine/types';
import type { Profile } from '../config/schema';
import type { SerializedFile } from './serialized-file';
import { appliedJobIds, computeStats, type Stats } from '../engine/stats';

// Repository adapter: the only place that touches chrome.storage.
// Pure computation lives in engine/stats.ts; this file just supplies data + clock.
const KEY = 'applications';
const STATE_KEY = 'run_state';

/** Persisted run state, so an alarm-driven step survives service-worker termination. */
export interface RunState {
  readonly siteId: string;
  readonly profile: Profile;
  readonly resume: SerializedFile;
  readonly queue: readonly Job[];
  readonly cursor: number;
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

export async function record(app: Application): Promise<void> {
  const all = await readAll();
  await chrome.storage.local.set({ [KEY]: [...all, app] });
}

export async function appliedIds(): Promise<Set<string>> {
  return appliedJobIds(await readAll());
}

export async function parked(): Promise<Application[]> {
  return (await readAll()).filter((a) => a.status === 'parked');
}

export async function stats(): Promise<Stats> {
  const now = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  return computeStats(await readAll(), iso(now), iso(y));
}

import type { Application, Job } from '../engine/types';
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
  readonly phase: 'running' | 'done';
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
  // Drop the screenshot dataURL before persisting — it's ~100-300 KB and would blow the
  // chrome.storage quota over a run. It's written to disk (fs-config.writeRecord) instead.
  const { screenshot: _omit, ...lean } = app;
  await chrome.storage.local.set({ [KEY]: [...all, lean] });
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

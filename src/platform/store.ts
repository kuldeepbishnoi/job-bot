import type { Application } from '../engine/types';
import { appliedJobIds, computeStats, type Stats } from '../engine/stats';

// Repository adapter: the only place that touches chrome.storage.
// Pure computation lives in engine/stats.ts; this file just supplies data + clock.
const KEY = 'applications';

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

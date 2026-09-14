import { signal, computed, type Signal } from '@preact/signals';
import type { Application } from '@/engine/types';
import type { Run } from '@/engine/records';
import type { Profile } from '@/config/schema';
import type { ResumeMeta } from '@/engine/records';
import { listRuns } from '@/platform/data/runs';
import { listResumes } from '@/platform/data/resumes';
import { captureUsage } from '@/platform/data/captures';
import { eventCount } from '@/platform/data/events';
import { changes } from '@/platform/data/idb';
import { loadStoredProfile, type ProfileMeta } from '@/platform/data/profile-store';
import { PACKS, packById } from '@/sites/packs';
import { runHealth } from '@/engine/records';

// One signal per source of truth. Everything the dashboard renders reads from here, so a page
// never polls: chrome.storage.onChanged and the IDB change channel push new values in.
// (The old popup polled every 2s and rebuilt its DOM — that is the thing we are replacing.)

export const applications = signal<Application[]>([]);
export const runs = signal<Run[]>([]);
export const profile = signal<Profile | null>(null);
export const profileMeta = signal<ProfileMeta | null>(null);
export const resumes = signal<ResumeMeta[]>([]);
export const storage = signal<{ captures: { count: number; bytes: number }; events: number }>({
  captures: { count: 0, bytes: 0 },
  events: 0,
});
export const account = signal<string>('');
export const loadError = signal<string | null>(null);

/** Ticks once a second so "heartbeat 12s ago" ages without every card owning a timer. */
export const now = signal<number>(Date.now());
setInterval(() => (now.value = Date.now()), 1000);

export const activeRuns = computed(() =>
  runs.value.filter((r) => r.phase === 'discovering' || r.phase === 'running' || r.phase === 'paused'),
);

/** Health per run, derived from heartbeat age against the pack's own thresholds — no guessing. */
export const health = computed(() => {
  const t = now.value;
  const out: Record<string, ReturnType<typeof runHealth>> = {};
  for (const r of runs.value) {
    const pack = packById(r.siteId);
    out[r.runId] = runHealth(r, t, pack?.stallMs ?? 6 * 60_000, pack?.deadMs ?? 40 * 60_000);
  }
  return out;
});

export const runById = computed(() => new Map(runs.value.map((r) => [r.runId, r])));

/** Applications keyed the way records join across surfaces: jobId + the persisted timestamp. */
export const appKey = (a: Application): string => `${a.jobId}@${a.at ?? a.date}`;
export const appByKey = computed(() => new Map(applications.value.map((a) => [appKey(a), a])));

export const reviewCount = computed(
  () => applications.value.filter((a) => a.status === 'parked' || a.status === 'failed').length,
);

async function refreshStorageKeys(): Promise<void> {
  const got = await chrome.storage.local.get(['applications', 'account']);
  applications.value = (got['applications'] as Application[] | undefined) ?? [];
  account.value = (got['account'] as string | undefined) ?? '';
}

async function refreshRuns(): Promise<void> {
  runs.value = await listRuns();
}

async function refreshProfile(): Promise<void> {
  const got = await loadStoredProfile();
  profile.value = got?.profile ?? null;
  profileMeta.value = got?.meta ?? null;
}

async function refreshIdb(): Promise<void> {
  const [res, caps, evs] = await Promise.all([listResumes(), captureUsage(), eventCount()]);
  resumes.value = res;
  storage.value = { captures: caps, events: evs };
}

/** Call once per page. Loads everything, then subscribes; never throws — a failure is shown, not hidden. */
export async function initStore(): Promise<void> {
  const step = async (what: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      loadError.value = `${what}: ${(e as Error).message}`;
    }
  };
  await Promise.all([
    step('storage', refreshStorageKeys),
    step('runs', refreshRuns),
    step('profile', refreshProfile),
    step('local data', refreshIdb),
  ]);

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch['applications'] || ch['account']) void refreshStorageKeys();
    if (ch['runs']) void refreshRuns();
    if (ch['profile_v1'] || ch['profile_meta']) void refreshProfile();
  });
  changes.subscribe((store) => {
    if (store === 'runs') void refreshRuns();
    else if (store === 'profile') void refreshProfile();
    else void refreshIdb();
  });
}

/** Packs are static config; exposed here so views import one module. */
export const packs = PACKS;

/** A signal that resolves an async value once and re-runs when `deps` change. Small enough to own. */
export function asyncSignal<T>(initial: T, load: () => Promise<T>): { value: Signal<T>; reload: () => void } {
  const s = signal<T>(initial);
  const reload = (): void => {
    void load().then((v) => (s.value = v));
  };
  reload();
  return { value: s, reload };
}

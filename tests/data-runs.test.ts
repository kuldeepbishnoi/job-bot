import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeFake, type ChromeFake } from './helpers/chrome-fake';
import { listRuns, getRun, activeRuns, beginRun, updateRun, heartbeat, bumpCounts, endRun, markDeadRuns, RUN_CAP } from '@/platform/data/runs';
import { runHealth } from '@/engine/records';
import { changes } from '@/platform/data/idb';

let chrome: ChromeFake;
beforeEach(() => {
  chrome = installChromeFake();
});

const init = (siteId = 'datadog', kind: 'worker' | 'in-page' = 'worker') =>
  ({ siteId, kind, trigger: 'manual', account: 'me@x.com', autoSubmit: false, onUnknown: 'park' }) as const;

describe('runs index', () => {
  it('begins a run with defaults and lists it newest last', async () => {
    const a = await beginRun(init());
    const b = await beginRun(init('linkedin', 'in-page'));
    expect(a.runId.startsWith('datadog-')).toBe(true);
    expect(a.phase).toBe('discovering'); // worker packs discover first
    expect(b.phase).toBe('running'); // in-page packs have no discovery
    expect(a.counts).toEqual({ queued: 0, done: 0, applied: 0, parked: 0, failed: 0, skipped: 0 });
    expect(a.startedAt).toBe(a.heartbeatAt);
    expect((await listRuns()).map((r) => r.runId)).toEqual([a.runId, b.runId]);
    expect(await getRun(b.runId)).toEqual(b);
    expect(await getRun('nope')).toBeNull();
  });

  it('honours a caller-supplied runId and replaces a duplicate', async () => {
    await beginRun({ ...init(), runId: 'fixed' });
    await beginRun({ ...init(), runId: 'fixed' });
    expect((await listRuns()).filter((r) => r.runId === 'fixed')).toHaveLength(1);
  });

  it('caps the index at RUN_CAP, dropping the oldest', async () => {
    for (let i = 0; i < RUN_CAP + 5; i++) await beginRun({ ...init(), runId: `r${i}` });
    const runs = await listRuns();
    expect(runs).toHaveLength(RUN_CAP);
    expect(runs[0]!.runId).toBe('r5');
    expect(runs[runs.length - 1]!.runId).toBe(`r${RUN_CAP + 4}`);
    expect((chrome._data.get('runs') as unknown[]).length).toBe(RUN_CAP); // what's persisted, not just what's returned
  });

  it('updateRun merges and re-stamps the heartbeat; unknown id → null', async () => {
    const r = await beginRun(init());
    const stale = r.heartbeatAt - 10_000;
    await chrome.storage.local.set({ runs: [{ ...r, heartbeatAt: stale }] });
    const u = await updateRun(r.runId, { phase: 'running', counts: { ...r.counts, queued: 42 } });
    expect(u?.phase).toBe('running');
    expect(u?.counts.queued).toBe(42);
    expect(u!.heartbeatAt).toBeGreaterThan(stale);
    expect(await updateRun('ghost', { phase: 'running' })).toBeNull();
  });

  it('heartbeat sets current; bumpCounts counts the status + done', async () => {
    const r = await beginRun(init());
    await heartbeat(r.runId, { jobId: '10524143', title: 'SDE', step: 'fill', since: 1 });
    expect((await getRun(r.runId))?.current?.step).toBe('fill');
    await bumpCounts(r.runId, 'applied');
    await bumpCounts(r.runId, 'parked');
    await bumpCounts(r.runId, 'applied');
    expect((await getRun(r.runId))?.counts).toMatchObject({ done: 3, applied: 2, parked: 1, failed: 0, skipped: 0 });
  });

  it('endRun records phase + reason and clears current/pause', async () => {
    const r = await beginRun(init());
    await updateRun(r.runId, { phase: 'paused', pause: { reason: 'log in as next' }, current: { jobId: '1', title: 't', step: 'open', since: 1 } });
    await endRun(r.runId, 'stopped', 'stopped by you');
    const got = await getRun(r.runId);
    expect(got).toMatchObject({ phase: 'stopped', endReason: 'stopped by you' });
    expect(got?.endedAt).toBeTypeOf('number');
    expect(got?.current).toBeUndefined();
    expect(got?.pause).toBeUndefined();
    expect(await activeRuns()).toEqual([]);
  });

  it('activeRuns = discovering | running | paused, whatever the heartbeat says', async () => {
    const a = await beginRun({ ...init(), runId: 'a' });
    await updateRun('a', { phase: 'paused' });
    await beginRun({ ...init(), runId: 'b' });
    await endRun('b', 'done', 'exhausted (3/3)');
    await beginRun({ ...init(), runId: 'c' });
    expect((await activeRuns()).map((r) => r.runId)).toEqual(['a', 'c']);
    expect(runHealth(a, a.heartbeatAt + 1, 1000, 2000)).toBe('alive');
  });

  it('markDeadRuns flips only runs past the pack threshold, keeps the stale heartbeat as evidence', async () => {
    const now = 1_700_000_000_000;
    const mk = (runId: string, siteId: string, age: number, phase: 'running' | 'paused' | 'done' = 'running') => ({
      ...init(siteId), runId, startedAt: now - age - 1, heartbeatAt: now - age, phase, counts: { queued: 0, done: 0, applied: 0, parked: 0, failed: 0, skipped: 0 },
    });
    const deadMsFor = (siteId: string) => (siteId === 'linkedin' ? 40 * 60_000 : 2 * 3_600_000);
    await chrome.storage.local.set({
      runs: [
        mk('fresh', 'datadog', 5 * 60_000),
        mk('old-worker', 'datadog', 3 * 3_600_000),
        mk('old-linkedin', 'linkedin', 45 * 60_000),
        mk('young-linkedin', 'linkedin', 30 * 60_000),
        mk('paused', 'datadog', 9 * 3_600_000, 'paused'), // waiting on the user is not dead
        mk('ended', 'datadog', 9 * 3_600_000, 'done'),
      ],
    });
    expect(await markDeadRuns(now, deadMsFor)).toBe(2);
    const byId = Object.fromEntries((await listRuns()).map((r) => [r.runId, r]));
    expect(byId['old-worker']).toMatchObject({ phase: 'dead', endedAt: now, heartbeatAt: now - 3 * 3_600_000 });
    expect(byId['old-worker']!.endReason).toMatch(/no heartbeat for 180 min/);
    expect(byId['old-linkedin']!.phase).toBe('dead');
    expect(byId['young-linkedin']!.phase).toBe('running');
    expect(byId['fresh']!.phase).toBe('running');
    expect(byId['paused']!.phase).toBe('paused');
    expect(byId['ended']!.phase).toBe('done');
    expect(runHealth(byId['old-worker']!, now, 6 * 60_000, deadMsFor('datadog'))).toBe('dead');
    expect(await markDeadRuns(now, deadMsFor)).toBe(0); // idempotent
    expect((await activeRuns()).map((r) => r.runId).sort()).toEqual(['fresh', 'paused', 'young-linkedin']);
  });

  it('serializes concurrent mutations so none is lost', async () => {
    const r = await beginRun(init());
    await Promise.all(Array.from({ length: 10 }, () => bumpCounts(r.runId, 'applied')));
    expect((await getRun(r.runId))?.counts.applied).toBe(10);
  });

  it('emits a runs change on every write', async () => {
    const seen: string[] = [];
    const off = changes.subscribe((s) => void seen.push(s));
    const r = await beginRun(init());
    await heartbeat(r.runId);
    off();
    await heartbeat(r.runId);
    expect(seen).toEqual(['runs', 'runs']);
  });
});

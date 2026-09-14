import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installChromeRuntimeFake, type ChromeRuntimeFake } from './helpers/chrome-extras';
import { startRun, step, stopRun, watchdog, runInProgress, QUEUE_CAP } from '@/app/stepper';
import type { RunPorts } from '@/app/runner';
import { listRuns } from '@/platform/data/runs';
import { queryEvents, clearEvents } from '@/platform/data/events';
import { getRunState, saveProgress, setAccount } from '@/platform/store';
import { parseProfile } from '@/config/schema';
import type { Application, Job } from '@/engine/types';
import type { ApplyOutcome } from '@/platform/messaging';

// The registry lives in the profile folder; there is none in a test, so stand in for the reader.
let registry = new Set<string>();
vi.mock('@/platform/fs-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/platform/fs-config')>()),
  readRegistry: async () => registry,
}));

// The worker-pack run lifecycle as the console sees it: one Run per run, a heartbeat per job,
// counts that match the outcomes, and an end reason every single time.

let chrome: ChromeRuntimeFake;
beforeEach(async () => {
  registry = new Set();
  chrome = installChromeRuntimeFake();
  await clearEvents();
  // Only timers: the stepper schedules the NEXT job with setTimeout, which a test must not run.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const profile = parseProfile({
  identity: { first_name: 'K', last_name: 'B', email: 'k@x.com', phone: '+1', country: 'India' },
  resume: 'resume/cv.pdf',
  want: {},
  answers: {},
  auto_submit: true,
  on_unknown: 'skip',
});
const resume = { name: 'cv.pdf', type: 'application/pdf', dataBase64: '' };
const job = (id: string): Job => ({ id, title: `Job ${id}`, team: '', department: 'Engineering', url: `https://x/${id}`, locations: [], seniority: [] });

function fakePorts(jobs: Job[], apply: RunPorts['apply'] = async () => ({ status: 'submitted' })): { ports: RunPorts; recorded: Application[] } {
  const recorded: Application[] = [];
  return {
    recorded,
    ports: {
      discover: async () => jobs,
      appliedIds: async () => new Set<string>(),
      openJob: async () => 1,
      apply,
      seenOtps: async () => [],
      getOtp: async () => '12345678',
      sendOtp: async () => ({ status: 'submitted' }),
      capture: async () => null,
      login: async () => ({ ok: true }),
      record: async (a) => void recorded.push(a),
      progress: () => {},
      cleanup: async () => {},
      today: () => '2026-09-14',
      wait: async () => {},
    },
  };
}

const onlyRun = async () => {
  const runs = await listRuns();
  expect(runs).toHaveLength(1); // never a second Run for the same queue
  return runs[0]!;
};

describe('worker run lifecycle (stepper → observe)', () => {
  it('creates one Run, stamps what it is doing, counts outcomes and ends with a reason', async () => {
    const { ports } = fakePorts([job('1'), job('2')]);
    await startRun('datadog', profile, resume, ports, [], undefined, 'manual'); // does job 1

    const started = await onlyRun();
    expect(started).toMatchObject({
      siteId: 'datadog', kind: 'worker', trigger: 'manual', autoSubmit: true, onUnknown: 'skip', resumeName: 'cv.pdf', phase: 'running',
    });
    expect(started.config).toMatchObject({ selected: '2 of 2 discovered' });
    expect(started.current).toMatchObject({ jobId: '1', title: 'Job 1', step: 'apply' });
    // queued is what's LEFT: the console's total is done + queued and must not grow.
    expect(started.counts).toMatchObject({ done: 1, applied: 1, queued: 1 });
    expect((await getRunState())?.runId).toBe(started.runId);

    await step(ports); // job 2
    expect((await onlyRun()).counts).toMatchObject({ done: 2, applied: 2, queued: 0 });

    await step(ports); // cursor past the end → finish
    const ended = await onlyRun();
    expect(ended.phase).toBe('done');
    expect(ended.endReason).toBe('queue exhausted (2/2)');
    expect(ended.endedAt).toBeGreaterThan(0);
    expect(await getRunState()).toBeNull();
    expect(chrome.calls.alarmsCleared).toContain('jobbot-watchdog');
  });

  it('advances the heartbeat on every step', async () => {
    const { ports } = fakePorts([job('1'), job('2')]);
    await startRun('datadog', profile, resume, ports);
    const first = await onlyRun();
    // Age the stamp the way a killed service worker would, then take one more step.
    const runs = await listRuns();
    await chrome.storage.local.set({ runs: runs.map((r) => ({ ...r, heartbeatAt: r.heartbeatAt - 60_000, current: undefined })) });
    await step(ports);
    const second = await onlyRun();
    expect(second.heartbeatAt).toBeGreaterThan(first.heartbeatAt - 60_000);
    expect(second.current?.jobId).toBe('2');
  });

  it('counts parked and failed separately, so the tally matches the records', async () => {
    const outcomes: ApplyOutcome[] = [{ status: 'submitted' }, { status: 'parked', note: 'missing X' }, { status: 'error', note: 'boom' }];
    let i = 0;
    const { ports, recorded } = fakePorts([job('1'), job('2'), job('3')], async () => outcomes[i++]!);
    await startRun('datadog', profile, resume, ports);
    await step(ports);
    await step(ports);
    const run = await onlyRun();
    expect(run.counts).toMatchObject({ done: 3, applied: 1, parked: 1, failed: 1, queued: 0 });
    expect(recorded.map((r) => r.status)).toEqual(['applied', 'parked', 'failed']);
  });

  it('keeps writing to the SAME Run after a service-worker restart', async () => {
    const { ports } = fakePorts([job('1'), job('2')]);
    await startRun('datadog', profile, resume, ports);
    const runId = (await onlyRun()).runId;

    vi.resetModules(); // a new SW generation: module state gone, storage intact
    const fresh = await import('@/app/stepper');
    await fresh.step(ports);

    const run = await onlyRun(); // still one Run, not a second one
    expect(run.runId).toBe(runId);
    expect(run.counts.done).toBe(2);
  });

  it('Stop ends the run as stopped, with the reason', async () => {
    const { ports } = fakePorts([job('1'), job('2')]);
    await startRun('datadog', profile, resume, ports);
    await stopRun(ports);
    const run = await onlyRun();
    expect(run.phase).toBe('stopped');
    expect(run.endReason).toBe('stopped by you');
    expect(await getRunState()).toBeNull();
  });

  it('Stop with no run in progress invents nothing', async () => {
    const { ports } = fakePorts([]);
    await stopRun(ports);
    expect(await listRuns()).toEqual([]);
  });

  it('the watchdog marks a run with no progress dead, and says how long it was silent', async () => {
    const { ports } = fakePorts([job('1'), job('2')]);
    await startRun('datadog', profile, resume, ports);
    const now = Date.now();
    await saveProgress({ done: 1, total: 2, current: 'Job 2', phase: 'running', at: now - 3 * 60 * 60 * 1000 });

    await watchdog(ports, now);

    const run = await onlyRun();
    expect(run.phase).toBe('dead');
    expect(run.endReason).toMatch(/no progress for 18\d min — presumed dead/);
    expect(await getRunState()).toBeNull(); // and the queue is gone, so nothing re-drives it
  });

  it('a stalled-but-young run is re-driven, and the console is told why', async () => {
    const { ports } = fakePorts([job('1'), job('2')]);
    await startRun('datadog', profile, resume, ports);
    const now = Date.now();
    await saveProgress({ done: 1, total: 2, current: 'Job 2', phase: 'running', at: now - 10 * 60_000 });

    await watchdog(ports, now);

    const run = await onlyRun();
    expect(run.phase).toBe('running'); // re-driven, not buried
    expect(run.counts.done).toBe(2);
    const warned = await queryEvents({ runId: run.runId, level: 'warn' });
    expect(warned.some((e) => /watchdog: stalled/.test(e.msg))).toBe(true);
  });

  it('runInProgress buries a stale run instead of leaving it "running" forever', async () => {
    const { ports } = fakePorts([job('1'), job('2')]);
    await startRun('datadog', profile, resume, ports);
    await saveProgress({ done: 1, total: 2, current: 'Job 2', phase: 'running', at: Date.now() - 3 * 60 * 60 * 1000 });

    expect(await runInProgress()).toBe(false);
    expect((await onlyRun()).phase).toBe('dead');
  });

  it('logs the run start as a structured event tied to the run', async () => {
    const { ports } = fakePorts([job('1')]);
    await startRun('datadog', profile, resume, ports);
    const run = await onlyRun();
    const events = await queryEvents({ runId: run.runId });
    expect(events.some((e) => e.scope === 'run' && /run started on datadog/.test(e.msg))).toBe(true);
  });
});

describe('the shared registry on a hands-off run', () => {
  it('excludes what another account applied to, even when the caller passes no exclude list', async () => {
    // The daily alarm has no extension page to read the registry for it. Passing [] used to mean
    // "apply to everything", which is precisely what the registry exists to prevent.
    registry = new Set(['j1']);
    const { ports } = fakePorts([job('j1'), job('j2')]);
    await startRun('datadog', profile, resume, ports, [], undefined, 'daily');
    expect((await getRunState())?.queue.map((j) => j.id)).toEqual(['j2']);
  });

  it('an explicit exclude from a page still wins over the file', async () => {
    registry = new Set(['j1']);
    const { ports } = fakePorts([job('j1'), job('j2')]);
    await startRun('datadog', profile, resume, ports, ['j2'], undefined, 'manual');
    expect((await getRunState())?.queue.map((j) => j.id)).toEqual(['j1']);
  });
});

describe('a pack walking hundreds of boards', () => {
  it('caps the persisted queue instead of failing to start, and says what it left behind', async () => {
    // Only reachable with the blast-radius cap explicitly lifted (max_per_run: 0). QUEUE_CAP is the
    // storage guard behind it: chrome.storage.local is 10 MB shared with the records and the log,
    // and a job is ~277 bytes, so an uncapped queue would blow the quota and the run would never
    // begin — taking the record writes with it.
    const many = Array.from({ length: QUEUE_CAP + 250 }, (_, i) => job(`j${i}`));
    const { ports } = fakePorts(many);
    await startRun('datadog', { ...profile, max_per_run: 0 }, resume, ports, [], undefined, 'manual');

    const state = await getRunState();
    expect(state?.queue).toHaveLength(QUEUE_CAP);
    const run = (await listRuns()).at(-1);
    expect(run?.config?.['selected']).toMatch(/250 left for the next run/);
  });

  it('the schema default caps a run even when profile.yaml says nothing — removing the line is not "apply to everything"', async () => {
    const many = Array.from({ length: 4000 }, (_, i) => job(`j${i}`));
    const { ports } = fakePorts(many);
    const defaulted = parseProfile({ identity: profile.identity, resume: 'r.pdf' });
    await startRun('datadog', defaulted, resume, ports, [], undefined, 'manual');
    expect((await getRunState())?.queue).toHaveLength(50);
  });

  it('a smaller max_per_run still wins — the cap is a ceiling, not a target', async () => {
    const many = Array.from({ length: 200 }, (_, i) => job(`j${i}`));
    const { ports } = fakePorts(many);
    await startRun('datadog', { ...profile, max_per_run: 15 }, resume, ports, [], undefined, 'manual');
    expect((await getRunState())?.queue).toHaveLength(15);
  });
});

describe('multi-account safety guard', () => {
  const multi = { ...profile, accounts: ['a@x.com', 'b@x.com'] };

  it('refuses to start when several accounts are configured but none is marked current (#regression: an unknown identity let rotation reuse the already-logged-in account and repeat the same limit failure forever, since getAccount() === "" matched no real candidate)', async () => {
    const { ports } = fakePorts([job('j1')]);
    await expect(startRun('amazon', multi, resume, ports)).rejects.toThrow(/no current account is set/);
  });

  it('runs normally once the current account is set', async () => {
    await setAccount('a@x.com');
    const { ports, recorded } = fakePorts([job('j1')]);
    await startRun('amazon', multi, resume, ports);
    expect(recorded).toHaveLength(1);
  });

  it('never requires an account when the site has one candidate or none configured', async () => {
    const { ports, recorded } = fakePorts([job('j1')]);
    await startRun('amazon', profile, resume, ports); // profile.accounts is empty here
    expect(recorded).toHaveLength(1);
  });
});

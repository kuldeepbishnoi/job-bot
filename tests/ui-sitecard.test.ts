import { describe, it, expect } from 'vitest';
import type { Run } from '@/engine/records';
import { EMPTY_COUNTS } from '@/engine/records';
import type { SitePack } from '@/sites/packs';
import type { Profile } from '@/config/schema';
import { countsLine, hasResume, lastEndedRun, progressFor, startBlock } from '@/ui/components/SiteCard';

// Only the pure bits of the site card — the parts that decide what a user is told. Rendering is
// left to the browser; these are the sentences that must never lie.

const pack = (over: Partial<SitePack> = {}): SitePack => ({
  id: 'datadog',
  label: 'Datadog',
  icon: '🐶',
  kind: 'worker',
  hosts: ['job-boards.greenhouse.io'],
  steps: ['open', 'fill', 'submit'],
  stallMs: 6 * 60_000,
  deadMs: 2 * 60 * 60_000,
  needs: { resume: true, gmail: true, accounts: false },
  supports: { schedule: true, stop: true, resume: true, dryRun: false },
  ...over,
});

const run = (over: Partial<Run> = {}): Run => ({
  runId: 'datadog-abc123',
  siteId: 'datadog',
  kind: 'worker',
  trigger: 'manual',
  account: 'me@example.com',
  startedAt: 1000,
  heartbeatAt: 2000,
  phase: 'running',
  counts: EMPTY_COUNTS,
  autoSubmit: false,
  onUnknown: 'park',
  ...over,
});

const profile = (resume: string): Profile => ({ resume } as unknown as Profile);

describe('hasResume', () => {
  it('is false without a profile', () => {
    expect(hasResume(null, [])).toBe(false);
  });

  it('accepts an uploaded résumé referenced by id', () => {
    const meta = { id: 'r1', label: 'Backend', name: 'k.pdf', type: 'application/pdf', size: 1, addedAt: 0 };
    expect(hasResume(profile('r1'), [meta])).toBe(true);
  });

  it('accepts a legacy on-disk file name the folder fallback can load', () => {
    expect(hasResume(profile('resume/kuldeep_backend.pdf'), [])).toBe(true);
    expect(hasResume(profile('some-id-that-is-not-a-file'), [])).toBe(false);
  });
});

describe('progressFor', () => {
  it('measures a worker run against its queue', () => {
    const p = progressFor(run({ counts: { ...EMPTY_COUNTS, done: 3, queued: 7, applied: 3 } }), pack());
    expect(p).toEqual({ value: 3, total: 10, label: '3 of 10 jobs' });
  });

  it('measures an in-page run against its budget, since the page is the queue', () => {
    const inPage = pack({ id: 'linkedin', kind: 'in-page', limits: { perDay: 50 } });
    const r = run({ siteId: 'linkedin', kind: 'in-page', counts: { ...EMPTY_COUNTS, applied: 4 }, config: { budget: '20' } });
    expect(progressFor(r, inPage)).toEqual({ value: 4, total: 20, label: '4 of 20 applied' });
  });

  it('falls back to the pack limit, then to "what we did" — never to a made-up total', () => {
    const inPage = pack({ id: 'instahyre', kind: 'in-page' });
    const r = run({ counts: { ...EMPTY_COUNTS, applied: 2 } });
    expect(progressFor(r, inPage)).toEqual({ value: 2, total: 2, label: '2 of 2 applied' });
  });
});

describe('countsLine', () => {
  it('always states what was applied, and only mentions the rest when non-zero', () => {
    expect(countsLine(run({ counts: { ...EMPTY_COUNTS, applied: 5 } }))).toBe('5 applied');
    expect(countsLine(run({ counts: { ...EMPTY_COUNTS, applied: 5, parked: 2, failed: 1, skipped: 3 } }))).toBe(
      '5 applied · 2 parked · 1 failed · 3 skipped',
    );
  });
});

describe('lastEndedRun', () => {
  it('picks the newest ended run of that site, ignoring live ones and other sites', () => {
    const all = [
      run({ runId: 'a', endedAt: 10, phase: 'done' }),
      run({ runId: 'b', endedAt: 30, phase: 'stopped' }),
      run({ runId: 'c', siteId: 'amazon', endedAt: 99, phase: 'done' }),
      run({ runId: 'd' }),
    ];
    expect(lastEndedRun(all, 'datadog')?.runId).toBe('b');
    expect(lastEndedRun(all, 'nope')).toBeUndefined();
  });
});

describe('startBlock', () => {
  it('blocks on an active run and names its phase', () => {
    expect(startBlock(run({ phase: 'paused' }), [])).toBe('already running (paused)');
  });

  it('names the failing requirements, and lets an unknown one through', () => {
    const reqs = [
      { id: 'profile', label: 'Profile', ok: true },
      { id: 'resume', label: 'Résumé', ok: false },
      { id: 'gmail', label: 'Gmail', ok: null },
    ];
    expect(startBlock(undefined, reqs)).toBe('missing: Résumé');
    expect(startBlock(undefined, [reqs[0]!, reqs[2]!])).toBeNull();
  });
});

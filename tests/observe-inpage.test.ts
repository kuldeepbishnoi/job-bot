import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeRuntimeFake, type ChromeRuntimeFake } from './helpers/chrome-extras';
import { startInstahyre, recordInstahyreApplied, finishInstahyre } from '@/app/instahyre-run';
import { startLinkedin, onLinkedinResult, onLinkedinWarning, onLinkedinPageDone, stopLinkedin, linkedinWatchdog, getLinkedinRun } from '@/app/linkedin-run';
import { listRuns } from '@/platform/data/runs';
import { clearEvents, queryEvents } from '@/platform/data/events';
import { listCaptures } from '@/platform/data/captures';
import { parseProfile } from '@/config/schema';
import type { Msg } from '@/platform/messaging';

// In-page packs (Instahyre, LinkedIn) apply inside the user's own tab, so their "queue" is the
// page. Same contract as the worker packs: one Run, a heartbeat per attempt, counts, a reason.

let chrome: ChromeRuntimeFake;
beforeEach(async () => {
  chrome = installChromeRuntimeFake({ tabId: 9, existingTabs: [{ id: 9 }] });
  await clearEvents();
});

const profile = parseProfile({
  identity: { first_name: 'K', last_name: 'B', email: 'k@x.com', phone: '+1', country: 'India' },
  resume: 'resume/cv.pdf',
  want: {},
  answers: {},
  auto_submit: true,
  linkedin: { search_urls: ['https://www.linkedin.com/jobs/search/?keywords=backend'] },
});
const resume = { name: 'cv.pdf', type: 'application/pdf', dataBase64: '' };

const onlyRun = async () => {
  const runs = await listRuns();
  expect(runs).toHaveLength(1);
  return runs[0]!;
};

const result = (over: Partial<Extract<Msg, { t: 'linkedin-result' }>> = {}): Extract<Msg, { t: 'linkedin-result' }> => ({
  t: 'linkedin-result',
  runId: 'unset',
  job: { id: '4001', title: 'Backend Engineer', company: 'Acme', url: 'https://www.linkedin.com/jobs/view/4001/' },
  status: 'applied',
  ...over,
});

describe('Instahyre run lifecycle', () => {
  it('creates an in-page Run, counts each apply, and ends with a reason', async () => {
    await startInstahyre();
    const started = await onlyRun();
    expect(started).toMatchObject({ siteId: 'instahyre', kind: 'in-page', trigger: 'manual', phase: 'running', tabId: 9 });

    await recordInstahyreApplied({ id: 'opp-1', title: 'SDE', company: 'Acme' });
    const mid = await onlyRun();
    expect(mid.counts).toMatchObject({ done: 1, applied: 1 });
    expect(mid.current).toMatchObject({ jobId: 'opp-1', step: 'apply' });

    await finishInstahyre(1, 2);
    const ended = await onlyRun();
    expect(ended.phase).toBe('done');
    expect(ended.endReason).toBe('opportunities exhausted — 1 applied, 2 skipped');
  });

  it('keeps counting after a service-worker restart (the run id is in storage)', async () => {
    await startInstahyre();
    const runId = (await onlyRun()).runId;
    expect(chrome._data.get('instahyre_run')).toBe(runId);

    await recordInstahyreApplied({ id: 'opp-1', title: 'SDE', company: 'Acme' });
    await recordInstahyreApplied({ id: 'opp-2', title: 'SDE II', company: 'Acme' });
    const run = await onlyRun();
    expect(run.runId).toBe(runId);
    expect(run.counts.applied).toBe(2);
  });
});

describe('LinkedIn run lifecycle', () => {
  it('reuses the run id, stamps the budget the progress bar needs, and heartbeats every attempt', async () => {
    await startLinkedin(profile, resume, { maxPerRun: 3 });
    const live = await getLinkedinRun();
    const started = await onlyRun();
    expect(started.runId).toBe(live!.runId); // ONE run id, not a second record
    expect(started).toMatchObject({ siteId: 'linkedin', kind: 'in-page', phase: 'running', tabId: 9, resumeName: 'cv.pdf' });
    expect(started.config).toMatchObject({ budget: '3', urls: '1/1' });

    await onLinkedinResult(result({ runId: live!.runId }));
    await onLinkedinResult(result({ runId: live!.runId, job: { id: '4002', title: 'Platform', company: 'Beta', url: '' }, status: 'parked', note: 'no answer' }));
    const mid = await onlyRun();
    expect(mid.counts).toMatchObject({ done: 2, applied: 1, parked: 1 });
    expect(mid.current).toMatchObject({ jobId: '4002', step: 'apply' });
    expect(mid.heartbeatAt).toBeGreaterThanOrEqual(started.heartbeatAt);
  });

  it('files the screenshot in IndexedDB, labelled, so the console can show it', async () => {
    await startLinkedin(profile, resume);
    const runId = (await getLinkedinRun())!.runId;
    await onLinkedinResult(result({ runId, status: 'failed', capture: { screenshot: 'data:image/png;base64,AAAA', label: 'failed' } }));

    const shots = await listCaptures({ runId });
    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({ siteId: 'linkedin', jobId: '4001', label: 'failed', mime: 'image/png' });
    expect(shots[0]!.bytes).toBeGreaterThan(0);
  });

  it('turns a page warning into a warn-level event on the run', async () => {
    await startLinkedin(profile, resume);
    const runId = (await getLinkedinRun())!.runId;
    await onLinkedinWarning({ t: 'linkedin-warning', runId, code: 'conflicting-extension', detail: 'AutoApplyMax is driving this page' });

    const warned = await queryEvents({ runId, level: 'warn' });
    expect(warned[0]).toMatchObject({ scope: 'linkedin', msg: 'AutoApplyMax is driving this page', data: { code: 'conflicting-extension' } });
  });

  it("maps LinkedIn's daily limit onto a finished run with that reason", async () => {
    await startLinkedin(profile, resume);
    const runId = (await getLinkedinRun())!.runId;
    await onLinkedinPageDone({ t: 'linkedin-page-done', runId, reason: 'limit', applied: 2, skipped: 1, cards: 25, newCards: 0, pages: 1 });

    const run = await onlyRun();
    expect(run.phase).toBe('done');
    expect(run.endReason).toMatch(/daily Easy Apply limit/);
    expect(await getLinkedinRun()).toBeNull();
  });

  it('a page error is dead, not done — the console must not call it a success', async () => {
    await startLinkedin(profile, resume);
    const runId = (await getLinkedinRun())!.runId;
    await onLinkedinPageDone({ t: 'linkedin-page-done', runId, reason: 'error', applied: 0, skipped: 0, cards: 3, newCards: 3, pages: 1, note: 'modal never opened' });

    const run = await onlyRun();
    expect(run.phase).toBe('dead');
    expect(run.endReason).toBe('page error: modal never opened');
  });

  it('auto_submit off parks the run as stopped, with the instruction as the reason', async () => {
    await startLinkedin(profile, resume);
    const runId = (await getLinkedinRun())!.runId;
    await onLinkedinPageDone({ t: 'linkedin-page-done', runId, reason: 'halt', applied: 0, skipped: 0, cards: 1, newCards: 1, pages: 1 });

    const run = await onlyRun();
    expect(run.phase).toBe('stopped');
    expect(run.endReason).toMatch(/waiting for your Submit click/);
  });

  it('Stop ends it as stopped by you', async () => {
    await startLinkedin(profile, resume);
    expect(await stopLinkedin()).toBe(true);
    expect(await onlyRun()).toMatchObject({ phase: 'stopped', endReason: 'stopped by you' });
  });

  it('the watchdog buries a run that made no progress for DEAD_MS', async () => {
    await startLinkedin(profile, resume);
    const live = (await getLinkedinRun())!;
    const old = Date.now() - 45 * 60_000;
    await chrome.storage.local.set({ linkedin_run: { ...live, lastActivityAt: old, lastProgressAt: old, lastKickAt: old } });

    await linkedinWatchdog();

    const run = await onlyRun();
    expect(run.phase).toBe('dead');
    expect(run.endReason).toMatch(/no progress for 4\d min — gave up/);
  });
});

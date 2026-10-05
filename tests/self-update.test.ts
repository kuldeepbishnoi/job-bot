import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeRuntimeFake, type ChromeRuntimeFake } from './helpers/chrome-extras';

// Updates load themselves between jobs, and every run resumes after the reload (owner,
// 2026-10-04: "it should be auto handled").
let stamp = 'A';
let reloads = 0;
let chrome: ChromeRuntimeFake;
beforeEach(() => {
  chrome = installChromeRuntimeFake();
  stamp = 'A';
  reloads = 0;
  const c = globalThis.chrome as unknown as { runtime: Record<string, unknown>; alarms: Record<string, unknown> };
  c.runtime = { ...(c.runtime ?? {}), getURL: (p: string) => `chrome-extension://x/${p}`, reload: () => void reloads++ };
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ at: stamp }) })) as unknown as typeof fetch;
});

describe('self-update', () => {
  it('reloads once a newer build is installed, and not before', async () => {
    const su = await import('@/app/self-update');
    await su.initSelfUpdate();
    await su.checkForUpdate();
    expect(reloads).toBe(0); // same build
    stamp = 'B';
    await su.checkForUpdate();
    expect(reloads).toBe(1);
  });

  it('a pending update drains: the stepper starts no new job until the reload', async () => {
    const su = await import('@/app/self-update');
    const { step } = await import('@/app/stepper');
    await su.initSelfUpdate();
    await chrome.storage.local.set({ 'run_state:lever': { siteId: 'lever', queue: [{ id: 'j' }], cursor: 0 }, update_pending_since: Date.now() });
    let applied = 0;
    await step({ apply: async () => (applied++, { status: 'submitted' }) } as never, 'lever');
    expect(applied).toBe(0);
    expect(chrome.calls.alarmsCreated['jobbot-step:lever']).toBeDefined(); // comes back after the reload
  });

  it('waits while LinkedIn is mid-job', async () => {
    const su = await import('@/app/self-update');
    await su.initSelfUpdate();
    await chrome.storage.local.set({ linkedin_run: { lastActivityAt: Date.now() } });
    stamp = 'C';
    await su.checkForUpdate();
    expect(reloads).toBe(0);
  });

  it('after a restart every running site gets its step alarm back (a reload can drop alarms)', async () => {
    const su = await import('@/app/self-update');
    await chrome.storage.local.set({ 'run_state:lever': { siteId: 'lever', queue: [], cursor: 0 }, 'run_state:amazon': { siteId: 'amazon', queue: [], cursor: 0, paused: { reason: 'x', nextAccount: '' } } });
    await su.resumeAfterRestart();
    expect(Object.keys(chrome.calls.alarmsCreated)).toEqual(expect.arrayContaining(['jobbot-watchdog', 'jobbot-step:lever']));
    expect(chrome.calls.alarmsCreated['jobbot-step:amazon']).toBeUndefined(); // paused waits for the user
  });
});

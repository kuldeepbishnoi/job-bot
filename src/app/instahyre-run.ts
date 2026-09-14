import { record } from '../platform/store';
import { saveProgress, getProgress, getAccount } from '../platform/store';
import { send, sendToTab } from '../platform/messaging';
import type { Application } from '../engine/types';
import type { Want } from '../config/schema';
import * as observe from './observe';

const OPPS_URL = 'https://www.instahyre.com/candidate/opportunities';
const RUN_KEY = 'instahyre_run'; // the Run id, in storage: the SW dies between the page's messages
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setRunId(runId: string | null): Promise<void> {
  if (runId) await chrome.storage.local.set({ [RUN_KEY]: runId });
  else await chrome.storage.local.remove(RUN_KEY);
}

/** The Run this in-page loop reports into, re-adopted after a service-worker restart. */
async function currentRunId(): Promise<string | null> {
  const got = await chrome.storage.local.get(RUN_KEY);
  const runId = (got[RUN_KEY] as string | undefined) ?? null;
  if (runId && observe.activeRunId() !== runId) await observe.adoptRun(runId);
  return runId;
}

/** Find the user's logged-in Instahyre opportunities tab, or open one, and focus it.
 *  Instahyre applies in-page in the real session — never the hidden worker window. */
async function ensureOppsTab(): Promise<number> {
  const [existing] = await chrome.tabs.query({ url: `${OPPS_URL}*` });
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    return existing.id;
  }
  const tab = await chrome.tabs.create({ url: `${OPPS_URL}/?company_size=0&job_type=0&search=true`, active: true });
  if (tab.id === undefined) throw new Error('could not open Instahyre tab');
  return tab.id;
}

async function waitReady(tabId: number, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const ok = await sendToTab<{ pong?: boolean }>(tabId, { t: 'ping' })
      .then((r) => r?.pong === true)
      .catch(() => false);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('Instahyre page never became ready');
}

/** Kick off the in-page apply loop. The content script drives it and reports back via runtime
 *  messages (handled in background.ts); this just finds the tab and starts it. */
export async function startInstahyre(trigger: 'manual' | 'daily' = 'manual', want?: Want): Promise<void> {
  const tabId = await ensureOppsTab();
  await waitReady(tabId);
  const runId = await observe.runStarted({
    siteId: 'instahyre',
    kind: 'in-page',
    trigger,
    account: await getAccount(),
    autoSubmit: true, // Instahyre "applying" IS the click — there is no form to park
    onUnknown: 'skip',
    tabId,
  });
  await setRunId(runId);
  await saveProgress({ done: 0, total: 0, current: 'Instahyre', phase: 'running', at: Date.now() });
  await sendToTab(tabId, { t: 'instahyre-apply', want });
}

/** Popup/console -> background: end an Instahyre run.
 *
 *  The loop lives in the PAGE, so this has to reach the page — clearing background state does not
 *  stop it. Until 2026-09-15 there was no Instahyre stop path at all: the button cleared the worker
 *  and LinkedIn runs and the Instahyre loop carried on applying, which on this pack means real
 *  applications after the user asked it to stop. Best-effort on the message (the tab may be closed
 *  or already done), but the Run is ended either way so the console never shows a run nobody can stop.
 */
export async function stopInstahyre(): Promise<void> {
  const runId = await currentRunId();
  const [tab] = await chrome.tabs.query({ url: `${OPPS_URL}*` });
  if (tab?.id !== undefined) await sendToTab(tab.id, { t: 'instahyre-stop' }).catch(() => {});
  if (!runId) return; // nothing running — Stop is a no-op, not an error
  const p = await getProgress();
  await observe.runEnded(runId, 'stopped', 'stopped by you');
  await setRunId(null);
  await saveProgress({ done: p?.done ?? 0, total: p?.done ?? 0, current: 'Instahyre', phase: 'done', at: Date.now() });
}

/** Persist one applied opportunity + nudge the popup's live counter. */
export async function recordInstahyreApplied(job: { id: string; title: string; company: string }): Promise<void> {
  const app: Application = {
    company: 'instahyre',
    jobId: job.id,
    title: job.title,
    url: OPPS_URL,
    date: new Date().toISOString().slice(0, 10),
    status: 'applied',
  };
  await record(app);
  const runId = await currentRunId();
  await observe.runStep(runId, { jobId: job.id, title: `${job.title} · ${job.company}`, step: 'apply', since: Date.now() });
  await observe.runOutcome(runId, 'applied');
  const p = await getProgress();
  const done = (p?.done ?? 0) + 1;
  await saveProgress({ done, total: done, current: `${job.title} · ${job.company}`, phase: 'running', at: Date.now() });
  void send({ t: 'progress', done, total: done, current: `${job.title} · ${job.company}` }).catch(() => {});
}

/** Loop finished — flip progress to done and tell the popup. */
export async function finishInstahyre(applied: number, skipped = 0, stopped = false): Promise<void> {
  const runId = await currentRunId();
  if (stopped) {
    // stopInstahyre() already ended the Run; the page is just reporting its final tally.
    await observe.runEnded(runId, 'stopped', `stopped by you — ${applied} applied, ${skipped} skipped`);
    await setRunId(null);
    await saveProgress({ done: applied, total: applied, current: 'Instahyre', phase: 'done', at: Date.now() });
    void send({ t: 'runDone' }).catch(() => {});
    return;
  }
  await observe.runEnded(runId, 'done', `opportunities exhausted — ${applied} applied, ${skipped} skipped`);
  await setRunId(null);
  await saveProgress({ done: applied, total: applied, current: 'Instahyre', phase: 'done', at: Date.now() });
  void send({ t: 'runDone' }).catch(() => {});
}

import { record } from '../platform/store';
import { saveProgress, getProgress } from '../platform/store';
import { send, sendToTab } from '../platform/messaging';
import type { Application } from '../engine/types';

const OPPS_URL = 'https://www.instahyre.com/candidate/opportunities';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
export async function startInstahyre(): Promise<void> {
  const tabId = await ensureOppsTab();
  await waitReady(tabId);
  await saveProgress({ done: 0, total: 0, current: 'Instahyre', phase: 'running', at: Date.now() });
  await sendToTab(tabId, { t: 'instahyre-apply' });
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
  const p = await getProgress();
  const done = (p?.done ?? 0) + 1;
  await saveProgress({ done, total: done, current: `${job.title} · ${job.company}`, phase: 'running', at: Date.now() });
  void send({ t: 'progress', done, total: done, current: `${job.title} · ${job.company}` }).catch(() => {});
}

/** Loop finished — flip progress to done and tell the popup. */
export async function finishInstahyre(applied: number): Promise<void> {
  await saveProgress({ done: applied, total: applied, current: 'Instahyre', phase: 'done', at: Date.now() });
  void send({ t: 'runDone' }).catch(() => {});
}

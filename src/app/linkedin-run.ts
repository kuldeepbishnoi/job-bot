import type { Profile } from '../config/schema';
import type { Application } from '../engine/types';
import { dlog } from '../platform/debug-log';
import { send, sendToTab, type LinkedinJob, type Msg } from '../platform/messaging';
import type { SerializedFile } from '../platform/serialized-file';
import { allRecords, record, saveProgress } from '../platform/store';

// LinkedIn Easy Apply orchestration (background side). The content script works through ONE
// results page per `linkedin-apply` message; this module owns everything that must survive a
// page change or a service-worker restart: the run state (chrome.storage), paging through
// `start=0,25,50…` of each search URL, re-kicking the content script after LinkedIn reloads the
// tab, a watchdog for a stalled page, Stop, and the on-disk record of every attempt.
//
// Paging: the content script first walks pages IN-PAGE (LinkedIn's own pager is an SPA transition,
// so the script and its state survive — fewer reloads, less bot-like). When that stops (no pager,
// stopped, a reload) the background navigates to `start=` from the persisted state and restarts
// the loop, so a reload — LinkedIn does that on its own sometimes — costs one page, never the run.
//
// Concurrency: every read-modify-write of the run goes through `serialized()` (the page fires
// `result` then `page-done` back to back; Stop can land mid-navigation). A kick re-reads the run
// right before sending, so a kick in flight when the run is stopped/finished never resurrects it.

const KEY = 'linkedin_run';
export const LINKEDIN_WATCHDOG_ALARM = 'jobbot-linkedin-watchdog';
const PAGE_SIZE = 25;
const MAX_START = 975; // LinkedIn serves at most 1000 results per search
const EMPTY_PAGES_BEFORE_NEXT_URL = 3; // pages with cards but nothing unseen (start= ignored?) → give up on the URL
const STALL_MS = 5 * 60_000; // no result/page-done for this long → reload the tab and re-kick
const DEAD_MS = 40 * 60_000; // no progress at all for this long → give up
const KICK_DEBOUNCE_MS = 8_000;
const JOB_URL = (id: string) => `https://www.linkedin.com/jobs/view/${id}/`;

export interface LinkedinRun {
  readonly runId: string;
  readonly profile: Profile;
  readonly resume: SerializedFile;
  readonly urls: readonly string[]; // search URLs with f_AL=true forced, `start` stripped
  readonly urlIdx: number;
  readonly start: number; // pagination offset within urls[urlIdx]
  readonly emptyPages: number; // consecutive pages of this URL with cards but nothing unseen
  readonly applied: number;
  readonly skipped: number;
  readonly handled: readonly string[]; // job ids attempted or skipped this run — never reopened
  readonly tabId: number;
  readonly startedAt: number;
  readonly lastActivityAt: number;
  readonly lastKickAt: number;
  readonly budget: number; // applies allowed this run (profile caps)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => dlog('linkedin', ...a);

let chain: Promise<unknown> = Promise.resolve();
/** Run `fn` after every earlier state mutation has finished. Never nest: a serialized fn that
 *  awaits serialized() deadlocks — do the slow parts (tab navigation, kicks) outside. */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

export async function getLinkedinRun(): Promise<LinkedinRun | null> {
  const got = await chrome.storage.local.get(KEY);
  return (got[KEY] as LinkedinRun | undefined) ?? null;
}
async function save(run: LinkedinRun): Promise<void> {
  await chrome.storage.local.set({ [KEY]: run });
}

/** Force the Easy Apply filter and a fresh `start` on a user-supplied search URL. */
export function searchUrl(base: string, start: number): string {
  const u = new URL(base);
  u.searchParams.set('f_AL', 'true');
  if (start > 0) u.searchParams.set('start', String(start));
  else u.searchParams.delete('start');
  return u.toString();
}

/** Job ids this extension already applied to on LinkedIn (any run), so a re-run never repeats. */
async function appliedOnLinkedin(): Promise<string[]> {
  return (await allRecords()).filter((a) => a.company === 'linkedin' && a.status === 'applied').map((a) => a.jobId);
}

export async function startLinkedin(profile: Profile, resume: SerializedFile): Promise<void> {
  const cfg = profile.linkedin;
  if (!cfg) throw new Error('profile.yaml has no `linkedin:` block (search_urls) — see profile.example.yaml');
  if (await getLinkedinRun()) throw new Error('a LinkedIn run is already in progress — press Stop first');
  const budget = Math.min(cfg.max_per_run, profile.max_per_run ?? cfg.max_per_run); // finite: it's persisted as JSON
  const urls = cfg.search_urls.map((u) => searchUrl(u, 0));
  const tab = await chrome.tabs.create({ url: urls[0], active: true }); // LinkedIn throttles background tabs
  if (tab.id === undefined) throw new Error('could not open the LinkedIn tab');
  const now = Date.now();
  const run: LinkedinRun = {
    runId: `li-${now}`,
    profile,
    resume,
    urls,
    urlIdx: 0,
    start: 0,
    emptyPages: 0,
    applied: 0,
    skipped: 0,
    handled: [],
    tabId: tab.id,
    startedAt: now,
    lastActivityAt: now,
    lastKickAt: 0,
    budget,
  };
  await serialized(() => save(run));
  await saveProgress({ done: 0, total: budget, current: 'LinkedIn: opening search…', phase: 'running', at: now });
  await chrome.alarms.create(LINKEDIN_WATCHDOG_ALARM, { periodInMinutes: 1 });
  log('run started', { runId: run.runId, urls, budget, autoSubmit: profile.auto_submit });
  try {
    await kick(run.runId);
  } catch (e) {
    await finishRun(run.runId, `could not start: ${(e as Error).message}`); // never leave a dead run "in progress"
    throw e;
  }
}

/** Ask the content script in the run's tab to work through the current page. Re-reads the run
 *  before every side effect, so a kick outlives neither Stop nor finish; skips when the page's
 *  loop is already running (a reload re-kick racing our own). */
async function kick(runId: string): Promise<void> {
  const run = await serialized(async () => {
    const r = await getLinkedinRun();
    if (!r || r.runId !== runId) return null;
    await save({ ...r, lastKickAt: Date.now() });
    return r;
  });
  if (!run) return;
  await waitReady(run.tabId);
  const status = await sendToTab<{ running?: boolean }>(run.tabId, { t: 'linkedin-status' }).catch(() => ({ running: false }));
  if (status?.running) {
    log('kick skipped: page loop already running');
    return;
  }
  const fresh = await getLinkedinRun();
  if (!fresh || fresh.runId !== runId) return; // stopped while we waited
  const exclude = [...new Set([...fresh.handled, ...(await appliedOnLinkedin())])];
  const budget = Math.max(0, fresh.budget - fresh.applied);
  log('kick page', { url: fresh.urls[fresh.urlIdx], start: fresh.start, budget, exclude: exclude.length });
  await sendToTab(fresh.tabId, { t: 'linkedin-apply', runId, profile: fresh.profile, resume: fresh.resume, exclude, budget });
}

async function waitReady(tabId: number, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const ok = await sendToTab<{ pong?: boolean }>(tabId, { t: 'ping' })
      .then((r) => r?.pong === true)
      .catch(() => false);
    if (ok) return;
    await sleep(500);
  }
  throw new Error('LinkedIn page never became ready (is the tab still open and on linkedin.com/jobs?)');
}

/** One attempt reported by the page. ALWAYS recorded (Applications page + on-disk record + the
 *  next run's exclude list) — an application submitted just as Stop landed still happened. The
 *  run counters/progress update only when the run is still the one that made it. */
export async function onLinkedinResult(msg: Extract<Msg, { t: 'linkedin-result' }>): Promise<void> {
  const app: Application = {
    company: 'linkedin',
    jobId: msg.job.id,
    title: `${msg.job.title} · ${msg.job.company}`.slice(0, 140),
    url: msg.job.url || JOB_URL(msg.job.id),
    date: new Date().toISOString().slice(0, 10),
    status: msg.status,
    ...(msg.note ? { note: msg.note } : {}),
    ...(msg.fields?.length ? { fields: msg.fields } : {}),
  };
  await record(app);
  await serialized(async () => {
    const run = await getLinkedinRun();
    if (!run || run.runId !== msg.runId) return;
    const applied = run.applied + (msg.status === 'applied' ? 1 : 0);
    const skipped = run.skipped + (msg.status === 'applied' ? 0 : 1);
    await save({ ...run, applied, skipped, handled: [...new Set([...run.handled, msg.job.id])], lastActivityAt: Date.now() });
    const current = `${msg.status === 'applied' ? '✓' : '⚠'} ${msg.job.title} · ${msg.job.company}`;
    await saveProgress({ done: applied, total: run.budget, current, phase: 'running', at: Date.now() });
    void send({ t: 'progress', done: applied, total: run.budget, current }).catch(() => {});
  });
}

/** Cards the page skipped without an attempt (filtered / applied badge), so a re-kick after a
 *  reload doesn't re-scan them. */
export function onLinkedinHandled(runId: string, ids: readonly string[]): Promise<void> {
  return serialized(async () => {
    const run = await getLinkedinRun();
    if (!run || run.runId !== runId || !ids.length) return;
    await save({ ...run, handled: [...new Set([...run.handled, ...ids])], lastActivityAt: Date.now() });
  });
}

/** The page finished: page on within the URL, move to the next URL, or end the run. The state
 *  decision is serialized; the navigation + kick happen after, outside the chain. */
export async function onLinkedinPageDone(msg: Extract<Msg, { t: 'linkedin-page-done' }>): Promise<void> {
  const plan = await serialized(() => pageDone(msg));
  if (!plan) return;
  log('navigating', plan.url);
  try {
    await chrome.tabs.update(plan.tabId, { url: plan.url, active: true });
  } catch (e) {
    await finishRun(plan.runId, `tab gone: ${(e as Error).message}`);
    return;
  }
  await sleep(2500); // let the SPA settle before pinging
  await kick(plan.runId).catch((e: Error) => finishRun(plan.runId, e.message));
}

async function pageDone(msg: Extract<Msg, { t: 'linkedin-page-done' }>): Promise<{ runId: string; tabId: number; url: string } | null> {
  const run = await getLinkedinRun();
  if (!run || run.runId !== msg.runId) return null;
  log('page done', { reason: msg.reason, applied: msg.applied, skipped: msg.skipped, cards: msg.cards, newCards: msg.newCards, pages: msg.pages, note: msg.note, url: run.urls[run.urlIdx], start: run.start });
  const touched: LinkedinRun = { ...run, lastActivityAt: Date.now() };
  if (msg.reason !== 'exhausted') {
    await finish(touched, endNote(msg));
    return null;
  }
  // End of this URL = LinkedIn showed no cards at all, we hit its 1000-result ceiling, or
  // several pages in a row held nothing unseen (a layout that ignores `start=`). A page whose
  // cards were all handled on an earlier day still pages on — the unseen ones are further in.
  const emptyPages = msg.newCards === 0 ? run.emptyPages + 1 : 0;
  const nextStart = run.start + PAGE_SIZE * Math.max(1, msg.pages);
  const urlDone = msg.cards === 0 || nextStart > MAX_START || emptyPages >= EMPTY_PAGES_BEFORE_NEXT_URL;
  let next: LinkedinRun;
  if (urlDone) {
    if (run.urlIdx + 1 >= run.urls.length) {
      await finish(touched, `every search URL exhausted — ${run.applied} applied, ${run.skipped} skipped`);
      return null;
    }
    next = { ...touched, urlIdx: run.urlIdx + 1, start: 0, emptyPages: 0 };
  } else {
    next = { ...touched, start: nextStart, emptyPages };
  }
  await save(next);
  return { runId: next.runId, tabId: next.tabId, url: searchUrl(next.urls[next.urlIdx]!, next.start) };
}

function endNote(msg: Extract<Msg, { t: 'linkedin-page-done' }>): string {
  switch (msg.reason) {
    case 'budget': return `run cap reached (${msg.applied} applied this page)`;
    case 'limit': return "LinkedIn's daily Easy Apply limit reached — continue tomorrow";
    case 'halt': return msg.note ?? 'auto_submit is off — the filled application is waiting for your Submit click';
    case 'stopped': return 'stopped by you';
    case 'error': return `page error: ${msg.note ?? 'unknown'}`;
    default: return msg.note ?? 'done';
  }
}

/** End the run (call only from inside a serialized fn, with the current run). */
async function finish(run: LinkedinRun, note: string): Promise<void> {
  log('run finished', { applied: run.applied, skipped: run.skipped, note });
  await chrome.storage.local.remove(KEY);
  await chrome.alarms.clear(LINKEDIN_WATCHDOG_ALARM);
  await saveProgress({ done: run.applied, total: run.applied, current: `LinkedIn: ${note}`, phase: 'done', at: Date.now() });
  void send({ t: 'runDone' }).catch(() => {});
}

/** End the run by id from outside the chain (a failed kick); a no-op if it already ended. */
function finishRun(runId: string, note: string): Promise<void> {
  return serialized(async () => {
    const run = await getLinkedinRun();
    if (run && run.runId === runId) await finish(run, note);
  });
}

/** Popup "Stop": tell the page to abandon after the current job, and drop the run. */
export function stopLinkedin(): Promise<boolean> {
  return serialized(async () => {
    const run = await getLinkedinRun();
    if (!run) return false;
    await sendToTab(run.tabId, { t: 'linkedin-stop' }).catch(() => {});
    await finish(run, 'stopped by you');
    return true;
  });
}

/** chrome.tabs.onUpdated: the run's tab finished loading a jobs page — LinkedIn reloaded it, or
 *  we navigated. Restart the loop from persisted state unless a kick is already in flight (8s
 *  debounce) or the page reports its loop still running (SPA `currentJobId` changes also fire
 *  `complete` in Chrome; `kick` asks the page first, so those are harmless). */
export async function onLinkedinTabUpdated(tabId: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab): Promise<void> {
  if (info.status !== 'complete') return;
  const run = await getLinkedinRun();
  if (!run || run.tabId !== tabId) return;
  if (!/^https:\/\/www\.linkedin\.com\/jobs\//.test(tab.url ?? '')) {
    log('run tab left linkedin jobs', tab.url);
    return;
  }
  if (Date.now() - run.lastKickAt < KICK_DEBOUNCE_MS) return;
  await sleep(2000);
  await kick(run.runId).catch((e: Error) => log('re-kick failed', e.message));
}

/** Every minute: a page silent for STALL_MS gets reloaded (onUpdated re-kicks it); DEAD_MS ends it. */
export function linkedinWatchdog(): Promise<void> {
  return serialized(async () => {
    const run = await getLinkedinRun();
    if (!run) {
      await chrome.alarms.clear(LINKEDIN_WATCHDOG_ALARM);
      return;
    }
    const idle = Date.now() - Math.max(run.lastActivityAt, run.lastKickAt);
    if (idle > DEAD_MS) {
      await finish(run, `no progress for ${Math.round(idle / 60_000)} min — gave up`);
      return;
    }
    if (idle > STALL_MS) {
      const tab = await chrome.tabs.get(run.tabId).catch(() => null);
      if (!tab) {
        await finish(run, 'the LinkedIn tab was closed');
        return;
      }
      log('watchdog: page silent, reloading', { idleMs: idle, url: tab.url });
      await save({ ...run, lastActivityAt: Date.now() }); // one reload per STALL_MS
      await chrome.tabs.update(run.tabId, { url: searchUrl(run.urls[run.urlIdx]!, run.start) }).catch(() => {});
    }
  });
}

export type { LinkedinJob };

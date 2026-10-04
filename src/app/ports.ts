import type { RunPorts } from './runner';
import { openJob, closeWorker } from '../platform/worker-window';
import { getOtp, seenOtps, getLoginCode, seenLoginCodes } from '../platform/gmail-otp';
import { isPassportUrl } from '../ats/passport';
import type { LoginOutcome } from '../platform/messaging';
import { record, appliedIds, saveProgress, getProgress } from '../platform/store';
import { writeRecord } from '../platform/fs-config';
import { sendToTab, send, type ApplyOutcome, type OtpOutcome } from '../platform/messaging';
import type { Site } from '../sites';
import { siteById } from '../sites';
import { NOT_LOGGED_IN } from '../sites/site';
import type { Profile } from '../config/schema';
import type { Job } from '../engine/types';
import type { SerializedFile } from '../platform/serialized-file';
import { dlog, elog } from '../platform/debug-log';
import * as observe from './observe';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const APPLY_CAP_MS = 4 * 60 * 1000; // a content script that never answers must not hang the run

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Poll the tab until the form content script answers — Greenhouse injects after the parent
 *  page's 'complete' (the form is a late async iframe) and Amazon's apply app renders after its
 *  own XHRs, so 'apply' can't be sent blind. */
/** Wait until the frame that holds the FORM answers — not merely until some frame does.
 *
 *  A pong used to mean "a content script exists here". On Datadog that is true of the Greenhouse
 *  embed's bootstrap document, which the embed then REPLACES with the real form: we sent `apply`
 *  into a document that was about to be torn down, so the port closed with nothing filled and the
 *  run recorded Chrome's opaque "message channel closed" for all 13 jobs on 2026-09-14.
 *
 *  A script that knows what it needs now says so (`ready`). `ready === undefined` keeps the old
 *  meaning, so packs that have not adopted it are unaffected. */
async function waitForFrame(tabId: number, tries = 30): Promise<void> {
  let sawScript = false;
  for (let i = 0; i < tries; i++) {
    const r = await sendToTab<{ pong?: boolean; ready?: boolean; why?: string }>(tabId, { t: 'ping' }).catch(() => null);
    if (r?.pong === true) {
      sawScript = true;
      if (r.ready !== false) return;
    }
    await sleep(500);
  }
  throw new Error(
    sawScript
      ? 'the form never rendered in the frame (the page answered, but its form was not there)'
      : 'form frame never became ready (no content script answered)',
  );
}

/** Some apply apps (Amazon) *navigate away* the instant a submit succeeds, tearing down the
 *  content script before it can answer — the message port closes. For a site that declares
 *  `submittedUrl`, that closed port is the normal success signal: confirm by where the tab went.
 *  Every other site (Greenhouse) keeps the closed port as the error it is. */
async function outcomeAfterPortClosed(site: Site, tabId: number, jobId: string, err: unknown): Promise<ApplyOutcome> {
  if (!site.submittedUrl) throw err;
  await sleep(2000); // let the redirect commit
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab?.pendingUrl ?? tab?.url ?? '';
  // The ATS's own cap: Amazon answers a submit with code 203 → summary?result=application_limit_reach.
  if (/result=application_limit_reach/.test(url)) return { status: 'error', note: 'Amazon application limit reached (limit page after submit)' };
  if (!site.submittedUrl(url)) throw err;
  // The content script stashed what it filled right before clicking Submit.
  const key = `pending_fields:${jobId}`;
  const got = await chrome.storage.local.get(key);
  const filled = (got[key] as ApplyOutcome extends { filled?: infer F } ? F : never) ?? undefined;
  await chrome.storage.local.remove(key).catch(() => {});
  return { status: 'submitted', note: `submitted — page moved on to ${url}`, ...(filled ? { filled } : {}) };
}

/** The content script's "I clicked Submit for this job" marker (greenhouse.content.ts), consumed once. */
async function submitClicked(jobId: string): Promise<{ filled?: ApplyOutcome['filled'] } | null> {
  const key = `submit_clicked:${jobId}`;
  const got = (await chrome.storage.local.get(key).catch(() => ({}))) as Record<string, { at: number; filled?: ApplyOutcome['filled'] } | undefined>;
  const mark = got[key];
  await chrome.storage.local.remove(key).catch(() => {});
  return mark && Date.now() - mark.at < 10 * 60_000 ? mark : null;
}

/** A closed port can mean the document was replaced mid-apply (the Greenhouse embed does exactly
 *  that). That is recoverable — but only after proving we would not be applying twice. So: wait for
 *  the real form frame again, ask it whether this application is already confirmed, and retry ONLY
 *  when it is not. A site that signals success by navigating (Amazon) is left to
 *  `outcomeAfterPortClosed`, which reads the URL instead. */
async function retryAfterFrameSwap(
  site: Site,
  tabId: number,
  profile: Profile,
  job: Job,
  resume: SerializedFile,
  ctx: { jobId: string; siteId: string },
): Promise<ApplyOutcome | null> {
  if (site.submittedUrl) return null; // that site's closed port is its success signal, not a swap
  try {
    await waitForFrame(tabId, 12);
  } catch {
    return null; // no form came back — let the normal error path report it
  }
  const state = await sendToTab<{ confirmed?: boolean }>(tabId, { t: 'ping' }).catch(() => null);
  if (state?.confirmed) {
    elog('info', 'apply', `${job.id} the form was already submitted — not retrying`, undefined, ctx);
    return { status: 'submitted', note: 'submitted before the frame was replaced' };
  }
  elog('warn', 'apply', `${job.id} the form frame was replaced mid-apply — filling the new one`, undefined, ctx);
  return withTimeout(
    sendToTab<ApplyOutcome>(tabId, { t: 'apply', profile, job, resume, autoSubmit: profile.auto_submit }),
    APPLY_CAP_MS,
    `apply ${job.id} (retry)`,
  ).catch(() => null);
}

// Concrete ports, assembled from platform adapters. This is the "Main" seam (Ch26):
// the dirty wiring that hands effects to the pure runner. Nothing else builds these.
/** Which worker a site applies in. Sites run in parallel, one lane each — except sites whose apply
 *  emails a one-time code to the shared inbox: Greenhouse's code names no job, so two Greenhouse
 *  sites at once could swap codes (invariant 8). They share the 'greenhouse' lane and take turns. */
export function laneFor(siteId: string): string {
  const site = siteById(siteId);
  return site?.ats === 'greenhouse' ? 'greenhouse' : siteId;
}

export function chromePorts(siteId?: string): RunPorts {
  const lane = siteId ? laneFor(siteId) : 'default';
  return {
    forSite: (id: string) => chromePorts(id),
    discover: (site, profile) => site.discover(profile),
    appliedIds,
    openJob: (url) => openJob(url, lane),
    apply: async (site, tabId, profile, job, resume) => {
      const onLogin = async (): Promise<boolean> => !!site.isLoginPage?.((await chrome.tabs.get(tabId).catch(() => null))?.url ?? '');
      if (await onLogin()) throw new Error(`${NOT_LOGGED_IN}: ${site.label} sent the apply page to sign-in`);
      await waitForFrame(tabId).catch(async (e: Error) => {
        // The redirect can land after the load we waited for — look again before blaming the frame.
        if (await onLogin()) throw new Error(`${NOT_LOGGED_IN}: ${site.label} sent the apply page to sign-in`);
        throw e;
      });
      const ctx = { jobId: job.id, siteId: site.id };
      elog('info', 'apply', `${job.id} ${job.title}`, { url: job.url }, ctx);
      await chrome.storage.local.remove(`submit_clicked:${job.id}`).catch(() => {}); // only THIS attempt's click counts
      try {
        const out = await withTimeout(
          sendToTab<ApplyOutcome>(tabId, { t: 'apply', profile, job, resume, autoSubmit: profile.auto_submit }),
          APPLY_CAP_MS,
          `apply ${job.id}`,
        );
        elog(out.status === 'error' ? 'error' : 'info', 'outcome', `${job.id} ${out.status} ${'note' in out ? out.note ?? '' : ''}`, { filled: out.filled?.length ?? 0 }, ctx);
        return out;
      } catch (e) {
        elog('warn', 'apply', `${job.id} port closed: ${(e as Error).message}`, undefined, ctx);
        // Submit was already clicked → the closed port IS the submit landing. Never refill: that
        // was a second application to the same job (2026-10-04, every Datadog job twice).
        const clicked = await submitClicked(job.id);
        if (clicked) {
          // The replacement page may be Greenhouse's emailed-code step rather than a confirmation:
          // then the application is NOT done — hand it to the OTP path instead of calling it applied.
          const next = await waitForFrame(tabId, 12).then(() => sendToTab<{ otp?: boolean }>(tabId, { t: 'ping' })).catch(() => null);
          if (next?.otp) {
            elog('info', 'outcome', `${job.id} submit landed on the emailed-code step`, undefined, ctx);
            return { status: 'needs_otp', ...(clicked.filled ? { filled: clicked.filled } : {}) };
          }
          const out: ApplyOutcome = { status: 'submitted', note: 'submitted — the form was replaced right after Submit (the ATS moved on)', ...(clicked.filled ? { filled: clicked.filled } : {}) };
          elog('info', 'outcome', `${job.id} submitted (port closed after the submit click)`, undefined, ctx);
          return out;
        }
        const retried = await retryAfterFrameSwap(site, tabId, profile, job, resume, ctx);
        if (retried) return retried;
        const out = await outcomeAfterPortClosed(site, tabId, job.id, e);
        elog(out.status === 'error' ? 'error' : 'info', 'outcome', `${job.id} ${out.status} ${'note' in out ? out.note ?? '' : ''}`, undefined, ctx);
        return out;
      }
    },
    seenOtps,
    getOtp,
    login: async (tabId, email, password) => {
      await waitForFrame(tabId);
      const stale = await seenLoginCodes(email).catch(() => [] as string[]);
      const tabUrl = async () => (await chrome.tabs.get(tabId).catch(() => null))?.url ?? '';
      const left = async () => !isPassportUrl(await tabUrl());
      const settle = async (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await left()) return true; await sleep(1000); } return false; };
      let out: LoginOutcome;
      try {
        out = await withTimeout(sendToTab<LoginOutcome>(tabId, { t: 'login', email, password }), 60_000, 'login');
      } catch {
        return (await settle(5000)) ? { ok: true } : { ok: false, note: 'login page did not answer' };
      }
      dlog('login', email, out.status, 'note' in out ? out.note : '');
      if (out.status === 'needs_code') {
        const code = await getLoginCode(email, stale);
        if (!code) return { ok: false, note: `no verification code arrived for ${email} (is that mailbox forwarded to the connected Gmail?)` };
        try {
          out = await withTimeout(sendToTab<LoginOutcome>(tabId, { t: 'otp', code, autoSubmit: true }), 30_000, 'otp');
        } catch {
          return (await settle(5000)) ? { ok: true } : { ok: false, note: 'code page did not answer' };
        }
        dlog('login code', email, out.status, 'note' in out ? out.note : '');
      }
      if (out.status === 'captcha') return { ok: false, note: 'captcha shown — log in by hand' };
      if (out.status === 'error') return { ok: false, note: out.note };
      return (await settle(20_000)) ? { ok: true } : { ok: false, note: 'still on the login page' };
    },
    sendOtp: (tabId, code, autoSubmit) => sendToTab<OtpOutcome>(tabId, { t: 'otp', code, autoSubmit }),
    capture: async (tabId, ctx) => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.windowId === undefined) return null;
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        // The Application keeps the dataURL only until store.record strips it, so the blob also
        // goes to IndexedDB — that's the copy the console can actually render.
        if (dataUrl && ctx) await observe.capture({ ...ctx, dataUrl });
        return dataUrl;
      } catch {
        return null; // best-effort — a failed capture must never fail the apply
      }
    },
    record: async (app) => {
      await record(app); // chrome.storage (store strips the screenshot dataURL)
      await writeRecord(app); // full record to the profile folder on disk
    },
    progress: (done, total, current) => {
      void send({ t: 'progress', done, total, current }).catch(() => {}); // reaches the popup if open
      void saveProgress({ done, total, current, phase: 'running', at: Date.now() }, siteId); // survives popup close
    },
    cleanup: async () => {
      await closeWorker(lane);
      const p = await getProgress(siteId);
      if (p) await saveProgress({ ...p, phase: 'done', at: Date.now() }, siteId);
      await send({ t: 'runDone' }).catch(() => {});
    },
    today: () => new Date().toISOString().slice(0, 10),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

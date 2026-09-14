import type { RunPorts } from './runner';
import { openJob, closeWorker } from '../platform/worker-window';
import { getOtp, seenOtps, getLoginCode, seenLoginCodes } from '../platform/gmail-otp';
import { isPassportUrl } from '../ats/passport';
import type { LoginOutcome } from '../platform/messaging';
import { record, appliedIds, saveProgress, getProgress } from '../platform/store';
import { writeRecord } from '../platform/fs-config';
import { sendToTab, send, type ApplyOutcome, type OtpOutcome } from '../platform/messaging';
import type { Site } from '../sites';
import { dlog } from '../platform/debug-log';

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
async function waitForFrame(tabId: number, tries = 30): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const ready = await sendToTab<{ pong?: boolean }>(tabId, { t: 'ping' })
      .then((r) => r?.pong === true)
      .catch(() => false);
    if (ready) return;
    await sleep(500);
  }
  throw new Error('form frame never became ready');
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

// Concrete ports, assembled from platform adapters. This is the "Main" seam (Ch26):
// the dirty wiring that hands effects to the pure runner. Nothing else builds these.
export function chromePorts(): RunPorts {
  return {
    discover: (site, profile) => site.discover(profile),
    appliedIds,
    openJob,
    apply: async (site, tabId, profile, job, resume) => {
      await waitForFrame(tabId);
      dlog('apply', site.id, job.id, job.title);
      try {
        const out = await withTimeout(
          sendToTab<ApplyOutcome>(tabId, { t: 'apply', profile, job, resume, autoSubmit: profile.auto_submit }),
          APPLY_CAP_MS,
          `apply ${job.id}`,
        );
        dlog('outcome', job.id, out.status, 'note' in out ? out.note : '', 'filled', out.filled?.length ?? 0);
        return out;
      } catch (e) {
        dlog('port closed', job.id, String((e as Error).message));
        const out = await outcomeAfterPortClosed(site, tabId, job.id, e);
        dlog('outcome', job.id, out.status, 'note' in out ? out.note : '');
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
    capture: async (tabId) => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.windowId === undefined) return null;
        return await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
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
      void saveProgress({ done, total, current, phase: 'running', at: Date.now() }); // survives popup close
    },
    cleanup: async () => {
      await closeWorker();
      const p = await getProgress();
      if (p) await saveProgress({ ...p, phase: 'done', at: Date.now() });
      await send({ t: 'runDone' }).catch(() => {});
    },
    today: () => new Date().toISOString().slice(0, 10),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

import type { RunPorts } from './runner';
import { openJob, closeWorker } from '../platform/worker-window';
import { getOtp } from '../platform/gmail-otp';
import { record, appliedIds, saveProgress, getProgress } from '../platform/store';
import { writeRecord } from '../platform/fs-config';
import { sendToTab, send, type ApplyOutcome, type OtpOutcome } from '../platform/messaging';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll the tab until the Greenhouse form content script answers — it injects after the
 *  parent page's 'complete' (the form is a late async iframe), so 'apply' can't be sent blind. */
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

// Concrete ports, assembled from platform adapters. This is the "Main" seam (Ch26):
// the dirty wiring that hands effects to the pure runner. Nothing else builds these.
export function chromePorts(): RunPorts {
  return {
    discover: (site) => site.discover(),
    appliedIds,
    openJob,
    apply: async (tabId, profile, job, resume) => {
      await waitForFrame(tabId);
      return sendToTab<ApplyOutcome>(tabId, { t: 'apply', profile, job, resume, autoSubmit: profile.auto_submit });
    },
    getOtp,
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

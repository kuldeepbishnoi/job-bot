import type { RunPorts } from './runner';
import { openJob, closeWorker } from '../platform/worker-window';
import { getOtp } from '../platform/gmail-otp';
import { record, appliedIds } from '../platform/store';
import { sendToTab, send, type ApplyOutcome, type OtpOutcome } from '../platform/messaging';

// Concrete ports, assembled from platform adapters. This is the "Main" seam (Ch26):
// the dirty wiring that hands effects to the pure runner. Nothing else builds these.
export function chromePorts(): RunPorts {
  return {
    discover: (site) => site.discover(),
    appliedIds,
    openJob,
    apply: (tabId, profile, job, resume) =>
      sendToTab<ApplyOutcome>(tabId, { t: 'apply', profile, job, resume, autoSubmit: profile.auto_submit }),
    getOtp,
    sendOtp: (tabId, code, autoSubmit) => sendToTab<OtpOutcome>(tabId, { t: 'otp', code, autoSubmit }),
    record,
    progress: (done, total, current) => void send({ t: 'progress', done, total, current }).catch(() => {}),
    cleanup: async () => {
      await closeWorker();
      await send({ t: 'runDone' }).catch(() => {});
    },
    today: () => new Date().toISOString().slice(0, 10),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

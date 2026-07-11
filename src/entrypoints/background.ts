import { defineBackground } from 'wxt/sandbox';
import { startRun, step, STEP_ALARM } from '@/app/stepper';
import { chromePorts } from '@/app/ports';
import { startInstahyre, recordInstahyreApplied, finishInstahyre } from '@/app/instahyre-run';
import type { Msg } from '@/platform/messaging';

// Main: wires concrete ports to the alarm-driven stepper.
// The run is NOT a single long await (MV3 would kill the SW) — each job is one alarm wake.
export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
    if (msg.t === 'run') {
      (async () => {
        try {
          await startRun(msg.siteId, msg.profile, msg.resume, chromePorts());
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String((e as Error).message) });
        }
      })();
      return true; // async response
    }
    // Instahyre applies in-page in the user's logged-in tab; the content script drives the loop
    // and reports each apply back here so it lands in the same stats/records as Greenhouse.
    if (msg.t === 'runInstahyre') {
      (async () => {
        try {
          await startInstahyre();
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String((e as Error).message) });
        }
      })();
      return true;
    }
    if (msg.t === 'instahyre-applied') {
      void recordInstahyreApplied(msg.job);
      return; // fire-and-forget
    }
    if (msg.t === 'instahyre-done') {
      void finishInstahyre(msg.applied);
      return;
    }
    return;
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === STEP_ALARM) void step(chromePorts());
  });
});

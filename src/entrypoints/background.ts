import { defineBackground } from 'wxt/sandbox';
import { startRun, step, STEP_ALARM } from '@/app/stepper';
import { chromePorts } from '@/app/ports';
import type { Msg } from '@/platform/messaging';

// Main: wires concrete ports to the alarm-driven stepper.
// The run is NOT a single long await (MV3 would kill the SW) — each job is one alarm wake.
export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
    if (msg.t !== 'run') return;
    (async () => {
      try {
        await startRun(msg.siteId, msg.profile, msg.resume, chromePorts());
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String((e as Error).message) });
      }
    })();
    return true; // async response
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === STEP_ALARM) void step(chromePorts());
  });
});

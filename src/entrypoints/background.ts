import { defineBackground } from 'wxt/sandbox';
import { startRun, step, stopRun, resumeRun, runInProgress, watchdog, STEP_ALARM, WATCHDOG_ALARM } from '@/app/stepper';
import { chromePorts } from '@/app/ports';
import { startInstahyre, recordInstahyreApplied, finishInstahyre } from '@/app/instahyre-run';
import {
  startLinkedin, stopLinkedin, onLinkedinResult, onLinkedinHandled, onLinkedinPageDone, onLinkedinTabUpdated,
  linkedinWatchdog, LINKEDIN_WATCHDOG_ALARM,
} from '@/app/linkedin-run';
import { dailySchedule, siteIdFromAlarm } from '@/platform/schedule';
import type { Msg } from '@/platform/messaging';

// Main: wires concrete ports to the alarm-driven stepper.
// The run is NOT a single long await (MV3 would kill the SW) — each job is one alarm wake.
export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
    if (msg.t === 'run') {
      (async () => {
        try {
          await startRun(msg.siteId, msg.profile, msg.resume, chromePorts(), msg.exclude ?? [], msg.credentials);
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String((e as Error).message) });
        }
      })();
      return true; // async response
    }
    if (msg.t === 'resume') {
      resumeRun(chromePorts()).then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String((e as Error).message) }));
      return true;
    }
    if (msg.t === 'stop') {
      Promise.all([stopRun(chromePorts()), stopLinkedin()]).then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String((e as Error).message) }));
      return true;
    }
    // LinkedIn Easy Apply: in-page like Instahyre, but with a form — the profile travels with the
    // message; paging + recovery live in app/linkedin-run.ts.
    if (msg.t === 'runLinkedin') {
      startLinkedin(msg.profile, msg.resume).then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String((e as Error).message) }));
      return true;
    }
    if (msg.t === 'linkedin-result') {
      void onLinkedinResult(msg);
      return;
    }
    if (msg.t === 'linkedin-handled') {
      void onLinkedinHandled(msg.runId, msg.ids);
      return;
    }
    if (msg.t === 'linkedin-page-done') {
      void onLinkedinPageDone(msg);
      return;
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
    if (alarm.name === STEP_ALARM) {
      void step(chromePorts());
      return;
    }
    if (alarm.name === WATCHDOG_ALARM) {
      void watchdog(chromePorts());
      return;
    }
    if (alarm.name === LINKEDIN_WATCHDOG_ALARM) {
      void linkedinWatchdog();
      return;
    }
    // Daily hands-off run (enabled from the popup, which cached the profile + résumé for us).
    const siteId = siteIdFromAlarm(alarm.name);
    if (siteId) void runScheduled(siteId);
  });

  // LinkedIn reloads/navigates its own tab now and then — restart the loop from persisted state.
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    void onLinkedinTabUpdated(tabId, info, tab);
  });
});

async function runScheduled(siteId: string): Promise<void> {
  const sched = await dailySchedule(siteId);
  if (!sched) return; // toggled off; a stray alarm
  if (await runInProgress()) {
    console.log('[jobbot] daily run skipped: another run is still in progress');
    return;
  }
  try {
    if (siteId === 'linkedin') await startLinkedin(sched.profile, sched.resume);
    else await startRun(siteId, sched.profile, sched.resume, chromePorts());
  } catch (e) {
    console.error('[jobbot] daily run failed to start', e);
  }
}

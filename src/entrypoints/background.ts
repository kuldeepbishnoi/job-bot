import { defineBackground } from 'wxt/sandbox';
import { startRun, step, stopRun, resumeRun, runInProgress, watchdog, kickQueue, runAgain, STEP_ALARM, WATCHDOG_ALARM, siteFromStepAlarm, siteFromAgainAlarm } from '@/app/stepper';
import { chromePorts } from '@/app/ports';
import { startInstahyre, stopInstahyre, recordInstahyreApplied, finishInstahyre, instahyreAgain, instahyreAlive, INSTAHYRE_AGAIN_ALARM } from '@/app/instahyre-run';
import {
  startLinkedin, stopLinkedin, onLinkedinResult, onLinkedinHandled, onLinkedinPageDone, onLinkedinTabUpdated, onLinkedinWarning, onLinkedinAlive,
  linkedinWatchdog, LINKEDIN_WATCHDOG_ALARM,
} from '@/app/linkedin-run';
import { dailySchedule, siteIdFromAlarm } from '@/platform/schedule';
import type { Msg } from '@/platform/messaging';
import * as observe from '@/app/observe';
import { appendEvents } from '@/platform/data/events';
import { dlog, appendPendingLines } from '@/platform/debug-log';
import { syncSeed } from '@/platform/data/profile-store';
import { initSelfUpdate, checkForUpdate, resumeAfterRestart, SELF_UPDATE_ALARM } from '@/app/self-update';

// Main: wires concrete ports to the alarm-driven stepper.
// The run is NOT a single long await (MV3 would kill the SW) — each job is one alarm wake.
export default defineBackground(() => {
  // Every dlog line in this service worker also becomes a structured event (batched per flush),
  // so the console's Logs page shows everything without touching 40+ call sites.
  observe.mirrorLogsToEvents();

  // profile.yaml → the extension, on every service-worker start (a reload included): the dashboard
  // and every Start re-check too, so an edit never needs the folder link or a click in Chrome.
  void syncSeed().then((r) => dlog('profile', 'seed', r.status, 'error' in r ? r.error : ''));
  // A new build loads itself between jobs; after any restart every run picks up where it was.
  void initSelfUpdate();
  void resumeAfterRestart().catch((e: Error) => dlog('self-update', 'resume failed', e.message));
  // Sites queued behind another lane (or by an older build) start now that lanes run in parallel.
  void kickQueue(chromePorts()).catch((e: Error) => dlog('run', 'kickQueue failed', e.message));

  chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
    if (msg.t === 'run') {
      (async () => {
        try {
          const r = await startRun(msg.siteId, msg.profile, msg.resume, chromePorts(msg.siteId), msg.exclude ?? [], msg.credentials, 'manual', { detachFirstStep: true, queueIfBusy: true });
          sendResponse({ ok: true, ...(r.queuedBehind ? { note: `Queued — starts by itself when ${r.queuedBehind} finishes` } : {}) });
        } catch (e) {
          sendResponse({ ok: false, error: String((e as Error).message) });
        }
      })();
      return true; // async response
    }
    if (msg.t === 'resume') {
      resumeRun(chromePorts(msg.siteId), msg.siteId).then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String((e as Error).message) }));
      return true;
    }
    if (msg.t === 'stop') {
      // Every pack, including the in-page ones — Stop has to reach whatever is doing the work. With a
      // site named (a card's own Stop), only that site: the others are running in parallel.
      const id = msg.siteId;
      const stops = !id
        ? [stopRun(chromePorts()), stopLinkedin(), stopInstahyre()]
        : id === 'linkedin' ? [stopLinkedin()] : id === 'instahyre' ? [stopInstahyre()] : [stopRun(chromePorts(id), id)];
      Promise.all(stops).then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String((e as Error).message) }));
      return true;
    }
    // LinkedIn Easy Apply: in-page like Instahyre, but with a form — the profile travels with the
    // message; paging + recovery live in app/linkedin-run.ts.
    if (msg.t === 'runLinkedin') {
      startLinkedin(msg.profile, msg.resume, msg.overrides, msg.exclude ?? []).then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String((e as Error).message) }));
      return true;
    }
    if (msg.t === 'linkedin-result') {
      void onLinkedinResult(msg);
      return;
    }
    // Screenshot for the record: only the background can capture, and only with the optional
    // <all_urls> grant (the popup asks for it when a LinkedIn run starts). Never fails the apply.
    if (msg.t === 'linkedin-capture') {
      (async () => {
        try {
          // Capture ONLY the tab that asked, and only while it is the active tab of its window:
          // captureVisibleTab grabs whatever is visible now, which may be the user's email if they
          // switched tabs since the content script checked.
          const tab = _sender.tab;
          if (!tab?.id || tab.windowId === undefined) return sendResponse({ dataUrl: null, error: 'no tab' });
          const fresh = await chrome.tabs.get(tab.id).catch(() => null);
          if (!fresh?.active) return sendResponse({ dataUrl: null, error: 'tab is not active — screenshot skipped' });
          const dataUrl = await chrome.tabs.captureVisibleTab(fresh.windowId, { format: 'jpeg', quality: 70 });
          sendResponse({ dataUrl });
        } catch (e) {
          sendResponse({ dataUrl: null, error: String((e as Error).message) });
        }
      })();
      return true;
    }
    if (msg.t === 'linkedin-alive') {
      void onLinkedinAlive(msg);
      return;
    }
    if (msg.t === 'linkedin-warning') {
      void onLinkedinWarning(msg);
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
          await startInstahyre('manual', msg.want, msg.repeatEveryMinutes);
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
    if (msg.t === 'debug-lines') {
      void appendPendingLines(msg.lines);
      return;
    }
    if (msg.t === 'instahyre-alive') {
      void instahyreAlive();
      return;
    }
    if (msg.t === 'instahyre-done') {
      void finishInstahyre(msg.applied, msg.skipped, msg.stopped);
      return;
    }
    // A frame that can't reach the event store itself (content scripts see the PAGE's IndexedDB).
    if (msg.t === 'log') {
      void appendEvents([{ ...msg.event, origin: msg.event.origin ?? 'content' }]).catch(() => {});
      return;
    }
    if (msg.t === 'capture') {
      void observe.capture(msg);
      return;
    }
    return;
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    // Each site's run has its own step alarm (`jobbot-step:<site>`) — sites apply in parallel.
    if (alarm.name === SELF_UPDATE_ALARM) {
      void checkForUpdate();
      return;
    }
    const againSite = siteFromAgainAlarm(alarm.name);
    if (againSite) {
      void runAgain(chromePorts(againSite), againSite);
      return;
    }
    if (alarm.name === INSTAHYRE_AGAIN_ALARM) {
      void instahyreAgain();
      return;
    }
    const stepSite = siteFromStepAlarm(alarm.name);
    if (stepSite) {
      void step(chromePorts(stepSite), stepSite);
      return;
    }
    if (alarm.name === STEP_ALARM) {
      void step(chromePorts()); // a pre-parallel alarm still pending from before an update
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
  // Sites run in parallel now: only THIS site already running skips its daily run (a busy shared
  // lane queues it instead, inside startRun).
  if (await runInProgress(Date.now(), siteId)) {
    console.log('[jobbot] daily run skipped:', siteId, 'is still running');
    return;
  }
  try {
    // No exclude passed: with none, both start paths read the shared registry themselves, so a
    // hands-off daily run excludes what every account already applied to, exactly like a manual one.
    // sched.credentials (snapshotted when the toggle was armed) is what lets a multi-account site
    // log the next account in itself when it hits a limit — without it, a daily run just pauses
    // forever the first time rotation is needed, since nobody is there to click Resume.
    if (siteId === 'linkedin') await startLinkedin(sched.profile, sched.resume, undefined, [], 'daily');
    else await startRun(siteId, sched.profile, sched.resume, chromePorts(siteId), [], sched.credentials, 'daily', { queueIfBusy: true });
  } catch (e) {
    // console.error goes to a service-worker console nobody has open at 9am, which would make a
    // scheduled run that refuses to start a SILENT daily no-op — the user sees "armed" and no
    // applications, with nothing to read. Put it where the console shows it, like any other run.
    const why = String((e as Error).message);
    console.error('[jobbot] daily run failed to start', e);
    dlog('daily', siteId, 'run failed to start:', why);
    await observe
      .runEnded(await observe.runStarted({ siteId, kind: 'worker', trigger: 'daily', account: '', autoSubmit: false, onUnknown: 'skip', queued: 0, resumeName: sched.resume.name }), 'dead', `daily run could not start: ${why}`)
      .catch(() => {});
  }
}

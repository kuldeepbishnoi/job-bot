import { defineContentScript } from 'wxt/sandbox';
import * as ih from '@/ats/instahyre';
import { click, waitFor } from '@/ats/dom';
import type { Msg } from '@/platform/messaging';

// Runs in the user's already-logged-in Instahyre opportunities tab. Instahyre has no form/OTP.
// Flow (verified live): the listing card has no inline Apply — you open the card's modal
// (`openApplyModal`), click the Apply div inside it (`submitChoice(opp, true)`), which advances the
// modal to the next opportunity. So the whole loop lives here in the page (not a background
// long-runner, which MV3 would kill).

const MAX_APPLIES = 200; // safety cap so a runaway loop can't hammer the ATS
const SETTLE_MS = 1400; // let AngularJS run its digest + load the next opportunity
const GAP_MS = 800; // human-like pause between applies

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const report = (msg: Msg) => chrome.runtime.sendMessage(msg).catch(() => {});

export default defineContentScript({
  matches: ['https://www.instahyre.com/candidate/opportunities*'],
  main() {
    chrome.runtime.onMessage.addListener((msg: Msg, _s, respond) => {
      if (msg.t === 'ping') {
        respond({ pong: true });
        return true;
      }
      if (msg.t === 'instahyre-apply') {
        runLoop().then(respond);
        return true;
      }
      return false;
    });
  },
});

async function runLoop(): Promise<{ applied: number; skipped: number }> {
  const log = (...a: unknown[]) => console.log('[jobbot:instahyre]', ...a);
  let applied = 0;
  let skipped = 0;

  // Enter the modal flow: if no Apply control is visible, open the first card's modal.
  if (!ih.applyButton(document)) {
    const opener = ih.openModalLink(document);
    if (!opener) {
      log('no opportunities to apply to');
      void report({ t: 'instahyre-done', applied, skipped });
      return { applied, skipped };
    }
    click(opener);
    await sleep(SETTLE_MS);
  }

  for (let i = 0; i < MAX_APPLIES; i++) {
    // External jobs can't be completed inside Instahyre — advance past them.
    if (ih.isExternal(document)) {
      const next = ih.nextButton(document);
      if (!next) break;
      click(next);
      skipped++;
      await sleep(SETTLE_MS);
      continue;
    }

    const btn = await waitFor(() => ih.applyButton(document), SETTLE_MS).catch(() => null);
    if (!btn) {
      // Modal may have closed — try re-entering from the listing; otherwise we're done.
      const opener = ih.openModalLink(document);
      if (!opener) break;
      click(opener);
      await sleep(SETTLE_MS);
      continue;
    }

    const job = ih.currentJob(document);
    const before = job.id;
    click(btn);
    applied++;
    log('applied', job.title, '@', job.company);
    void report({ t: 'instahyre-applied', job });

    // A company with several roles pops the "apply to all similar jobs" modal — owner wants all.
    const bulk = await waitFor(() => ih.bulkApplyAllButton(document), 1500).catch(() => null);
    if (bulk) {
      click(bulk);
      log('applied to all similar roles at', job.company);
      await sleep(SETTLE_MS);
    }

    // Applying should auto-advance the modal to the next opportunity. Wait for the shown job to
    // change; if it hasn't after the settle window, nudge it with the next control.
    const advanced = await waitFor(
      () => (ih.currentJob(document).id !== before ? true : null),
      SETTLE_MS,
    ).catch(() => false);
    if (!advanced) {
      const next = ih.nextButton(document);
      if (next) click(next);
    }
    await sleep(GAP_MS);
  }

  log('done', { applied, skipped });
  void report({ t: 'instahyre-done', applied, skipped });
  return { applied, skipped };
}

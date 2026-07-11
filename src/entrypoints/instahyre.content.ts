import { defineContentScript } from 'wxt/sandbox';
import * as ih from '@/ats/instahyre';
import { click, waitFor } from '@/ats/dom';
import type { Msg } from '@/platform/messaging';

// Runs in the user's already-logged-in Instahyre opportunities tab. Instahyre has no form/OTP —
// applying is clicking the in-page "Apply" button, which advances to the next opportunity. So the
// whole loop lives here in the page (not a background long-runner, which MV3 would kill).

const MAX_APPLIES = 200; // safety cap so a runaway loop can't hammer the ATS
const SETTLE_MS = 1200; // let AngularJS run its digest + load the next opportunity
const GAP_MS = 900; // human-like pause between applies

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

    const btn = ih.applyButton(document);
    if (!btn) break; // no more opportunities in the Undecided queue

    const job = ih.currentJob(document);
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

    await sleep(SETTLE_MS + GAP_MS);
  }

  log('done', { applied, skipped });
  void report({ t: 'instahyre-done', applied, skipped });
  return { applied, skipped };
}

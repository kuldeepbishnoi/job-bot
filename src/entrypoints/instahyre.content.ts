import { defineContentScript } from 'wxt/sandbox';
import * as ih from '@/ats/instahyre';
import { click, waitFor } from '@/ats/dom';
import type { Msg } from '@/platform/messaging';

// Runs in the user's already-logged-in Instahyre opportunities tab. Instahyre has no form/OTP.
// Flow (verified live) has TWO lists, drained in order:
//   1. Matching / "Undecided" queue (the default view): open the card's modal (`openApplyModal`),
//      click the Apply div (`submitChoice(opp, true)`); applying auto-advances the modal to the next
//      opportunity (`swipeOpp`). This queue is small (~15-46) and refills slowly.
//   2. "Search other jobs" (the full ~12k-job board): once matching is empty, expand the search
//      panel + run an empty search, then walk the paginated results. Same `openApplyModal` cards,
//      but the modal has NO auto-advance — so apply → close → open the next card, and click "Next »"
//      when a page runs out. Dedupe by card identity so an already-handled card is never reopened.
// The whole loop lives here in the page (not a background long-runner, which MV3 would kill).

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

const log = (...a: unknown[]) => console.log('[jobbot:instahyre]', ...a);

async function runLoop(): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;

  // Phase 1: drain the matching/Undecided queue — unless we were started already on the search list.
  if (!onSearchList()) {
    const m = await drainMatching(MAX_APPLIES);
    applied += m.applied;
    skipped += m.skipped;
    log('matching queue drained', m);
  }

  // Phase 2: fall through to "Search other jobs" (the full board) with whatever budget remains.
  if (applied < MAX_APPLIES && (await enterSearchList())) {
    const s = await drainSearch(MAX_APPLIES - applied);
    applied += s.applied;
    skipped += s.skipped;
    log('search list drained', s);
  }

  log('done', { applied, skipped });
  void report({ t: 'instahyre-done', applied, skipped });
  return { applied, skipped };
}

/** Phase 1: the matching queue — modal auto-advances (`swipeOpp`) after each apply. */
async function drainMatching(budget: number): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;

  // Enter the modal flow: if no Apply control is visible, open the first card's modal.
  if (!ih.applyButton(document)) {
    const opener = ih.openModalLink(document);
    if (!opener) return { applied, skipped };
    click(opener);
    await sleep(SETTLE_MS);
  }

  while (applied < budget) {
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
      // Modal may have closed — try re-entering from the listing; otherwise the queue is empty.
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
    await handleBulk(job.company);

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

  return { applied, skipped };
}

/** Phase 2: the paginated "Search other jobs" board — no auto-advance, so apply → close → next
 *  card, and page with "Next »". Dedupes by card identity so a handled card is never reopened. */
async function drainSearch(budget: number): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;
  const handled = new Set<string>();

  while (applied < budget) {
    const card = ih.openModalLinks(document).find((el) => !handled.has(ih.cardId(el)));
    if (!card) {
      // Page exhausted — advance to the next page, or we're truly done.
      const next = ih.nextPageButton(document);
      if (!next) break;
      click(next);
      await sleep(SETTLE_MS);
      continue;
    }

    handled.add(ih.cardId(card)); // mark before opening so a failed apply can't loop on it
    click(card);
    await sleep(SETTLE_MS);

    if (ih.isExternal(document)) {
      await closeModal();
      skipped++;
      continue;
    }

    const btn = await waitFor(() => ih.applyButton(document), SETTLE_MS).catch(() => null);
    if (!btn) {
      await closeModal();
      continue;
    }

    const job = ih.currentJob(document);
    click(btn);
    applied++;
    log('applied', job.title, '@', job.company);
    void report({ t: 'instahyre-applied', job });
    await handleBulk(job.company);
    await closeModal();
    await sleep(GAP_MS);
  }

  return { applied, skipped };
}

/** A company with several roles pops the "apply to all similar jobs" modal — owner wants all. */
async function handleBulk(company: string): Promise<void> {
  const bulk = await waitFor(() => ih.bulkApplyAllButton(document), 1500).catch(() => null);
  if (bulk) {
    click(bulk);
    log('applied to all similar roles at', company);
    await sleep(SETTLE_MS);
  }
}

/** Close the open apply modal and let the list settle. */
async function closeModal(): Promise<void> {
  const close = ih.closeModalButton(document);
  if (close) click(close);
  await sleep(GAP_MS);
}

function onSearchList(): boolean {
  return location.href.includes('search=true') || !!ih.nextPageButton(document);
}

/** Open the "Search other jobs" panel and run the (empty = whole board) search. Returns true once
 *  the results list has cards to apply to. */
async function enterSearchList(): Promise<boolean> {
  if (onSearchList() && ih.openModalLinks(document).length > 0) return true;

  const expander = ih.searchExpander(document);
  if (expander) {
    click(expander);
    await sleep(GAP_MS);
  }
  const show = await waitFor(() => ih.showResultsButton(document), SETTLE_MS).catch(() => null);
  if (!show) return false;

  click(show);
  await waitFor(() => (ih.openModalLinks(document).length > 0 ? true : null), 6000).catch(() => {});
  return ih.openModalLinks(document).length > 0;
}

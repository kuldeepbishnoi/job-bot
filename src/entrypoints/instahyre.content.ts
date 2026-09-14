import { defineContentScript } from 'wxt/sandbox';
import * as ih from '@/ats/instahyre';
import { click, waitFor } from '@/ats/dom';
import { titleWanted } from '@/engine/select-jobs';
import type { Msg } from '@/platform/messaging';
import type { Want } from '@/config/schema';

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
// FAIL CLOSED on a missing want. Until 2026-09-15 this loop had no title filter at all and applied
// to every card with an Apply button — that sent real applications to Finance Manager, Customer
// Support Executive and IP Sales Engineer roles under the user's name, unwithdrawable. So a want
// that never arrives (a wiring mistake, an old cached message, a version skew) must apply to
// NOTHING rather than to everything. An explicitly EMPTY titles_any is different: that is the
// user's own "no title restriction", and titleWanted() already reads it that way.

// Stop has to reach THIS page. The apply loop runs here, not in the background, so clearing
// background run state cannot end it — until 2026-09-15 nothing told the page at all and Stop was
// a no-op while the loop kept applying, up to MAX_APPLIES. Checked before every apply and between
// every card, so the most it can overshoot is the click already in flight.
let stopped = false;

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
      if (msg.t === 'instahyre-stop') {
        stopped = true;
        log('stop requested — finishing the click in flight, then ending');
        respond({ ok: true });
        return true;
      }
      if (msg.t === 'instahyre-apply') {
        stopped = false; // a fresh run clears a previous stop
        if (!msg.want) {
          // Refuse rather than apply unfiltered — see the FAIL CLOSED note above.
          log('refusing to run: no `want` reached the page, so every card would be applied to');
          void report({ t: 'instahyre-done', applied: 0, skipped: 0 });
          respond({ applied: 0, skipped: 0, error: 'no title filter reached the page — nothing was applied to' });
          return true;
        }
        runLoop(msg.want).then(respond);
        return true;
      }
      return false;
    });
  },
});

const log = (...a: unknown[]) => console.log('[jobbot:instahyre]', ...a);

async function runLoop(want: Want): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;
  log('filter', { titles_any: want.titles_any, titles_none: want.titles_none });

  // Phase 1: drain the matching/Undecided queue — unless we were started already on the search list.
  if (!onSearchList()) {
    const m = await drainMatching(MAX_APPLIES, want);
    applied += m.applied;
    skipped += m.skipped;
    log('matching queue drained', m);
  }

  // Phase 2: fall through to "Search other jobs" (the full board) with whatever budget remains.
  if (!stopped && applied < MAX_APPLIES && (await enterSearchList())) {
    const s = await drainSearch(MAX_APPLIES - applied, want);
    applied += s.applied;
    skipped += s.skipped;
    log('search list drained', s);
  }

  log('done', { applied, skipped, stopped });
  void report({ t: 'instahyre-done', applied, skipped, stopped });
  return { applied, skipped };
}

/** Phase 1: the matching queue — modal auto-advances (`swipeOpp`) after each apply. */
async function drainMatching(budget: number, want: Want): Promise<{ applied: number; skipped: number }> {
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
    if (stopped) break;
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

    // The queue Instahyre calls "matching" is not a title filter — it surfaces Finance Manager and
    // Customer Support Executive roles too. Apply want.titles_any/titles_none before the click,
    // because after it there is no undo.
    if (!titleWanted(job.title, want)) {
      log('skipping (title not wanted)', job.title, '@', job.company);
      skipped++;
      const next = ih.nextButton(document);
      if (!next) break;
      click(next);
      await waitFor(() => (ih.currentJob(document).id !== before ? true : null), SETTLE_MS).catch(() => false);
      continue;
    }

    click(btn);
    applied++;
    log('applied', job.title, '@', job.company);
    void report({ t: 'instahyre-applied', job });
    await handleBulk(job.company, want);

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
async function drainSearch(budget: number, want: Want): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;
  const handled = new Set<string>();

  while (applied < budget) {
    if (stopped) break;
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

    // The card's own listing text carries "<Company> - <Title>", so an unwanted role can be
    // skipped without even opening its modal. The modal's title is checked again below, because
    // this text is a best-effort read of the card, not the authoritative job title.
    if (!titleWanted(ih.cardId(card), want)) {
      log('skipping card (title not wanted)', ih.cardId(card));
      skipped++;
      continue;
    }

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
    // Authoritative check against the OPEN modal's title — the card text above is only a hint.
    if (!titleWanted(job.title, want)) {
      log('skipping (title not wanted)', job.title, '@', job.company);
      skipped++;
      await closeModal();
      continue;
    }

    click(btn);
    applied++;
    log('applied', job.title, '@', job.company);
    void report({ t: 'instahyre-applied', job });
    await handleBulk(job.company, want);
    await closeModal();
    await sleep(GAP_MS);
  }

  return { applied, skipped };
}

/** A company with several roles pops the "apply to all similar jobs" modal. Those other roles are
 *  never shown to us and never title-checked, so "all similar roles at Acme" can quietly include
 *  the Finance Manager opening. Take it only when the user set NO title filter (the old behaviour,
 *  which is then what they asked for); otherwise decline and keep just the role we vetted. */
async function handleBulk(company: string, want: Want): Promise<void> {
  const filtering = want.titles_any.length > 0 || want.titles_none.length > 0;
  const bulk = await waitFor(() => ih.bulkApplyAllButton(document), 1500).catch(() => null);
  if (!bulk) return;
  if (filtering) {
    const cancel = ih.bulkCancelButton(document);
    if (cancel) click(cancel);
    log('declined "all similar roles" at', company, '— they are not title-checked and a filter is set');
    await sleep(SETTLE_MS);
    return;
  }
  click(bulk);
  log('applied to all similar roles at', company);
  await sleep(SETTLE_MS);
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

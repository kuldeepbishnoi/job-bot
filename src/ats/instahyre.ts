import { click, labelText } from './dom';

// Instahyre apply adapter — pure DOM, no chrome/network, so it unit-tests in happy-dom.
//
// Instahyre is an AngularJS SPA. Unlike Greenhouse there is NO form, NO resume upload, NO OTP.
// Verified against the live logged-in opportunities page:
//   - Each listing card `.employer-block` has a title link `openApplyModal(opp)` that opens the
//     apply modal, plus an inline `submitChoice(opp, false)` ("Not interested").
//   - The Apply control is a DIV `.apply[ng-click="submitChoice(opp, true)"]` that exists ONLY
//     inside the open modal (`.candidate-apply-modal`). There is NO inline Apply on the card.
//   - Applying advances the modal to the next opportunity (`swipeOpp(opp, 'next')`).
//   - External jobs surface `#apply-external-modal` ("Apply on company site") — can't be completed
//     here, so they're skipped.
// This module only *locates* controls + reads the current opportunity's identity; the content
// script drives the open→apply→advance loop.

/** Visible = AngularJS hasn't ng-hidden it and it's actually laid out. */
function shown(el: Element | null): el is Element {
  if (!el) return false;
  if (el.classList.contains('ng-hide') || el.closest('.ng-hide')) return false;
  return (el as HTMLElement).offsetParent !== null || el.getClientRects().length > 0;
}

/** A listing card's link that opens the apply modal (`openApplyModal(opp)`). Used to enter the
 *  modal flow when none is open. Returns the first still-visible card. */
export function openModalLink(doc: Document): HTMLElement | null {
  return openModalLinks(doc)[0] ?? null;
}

/** Every still-visible card link that opens an apply modal. The "Search other jobs" results page
 *  lists 30 cards at once (each an `openApplyModal(opp)`), so the search loop walks this whole list
 *  and dedupes by `cardId`. */
export function openModalLinks(doc: Document): HTMLElement[] {
  return [
    ...doc.querySelectorAll('.employer-block [ng-click*="openApplyModal"], [ng-click*="openApplyModal"]'),
  ].filter((el) => shown(el)) as HTMLElement[];
}

/** Stable-enough identity for a search-result card ("<Company> - <Title>") so the loop never
 *  re-opens a card it already applied to / skipped on the current session. */
export function cardId(el: Element): string {
  return labelText(el).slice(0, 120);
}

/** The Apply control inside the open modal (`submitChoice(opp, true)`) — a DIV, not a <button>. */
export function applyButton(doc: Document): HTMLElement | null {
  const el = [...doc.querySelectorAll('[ng-click*="submitChoice"]')].find(
    (e) => /submitChoice\([^,]+,\s*true\s*\)/.test(e.getAttribute('ng-click') ?? '') && shown(e),
  );
  return (el as HTMLElement) ?? null;
}

/** True when the current opportunity is an external "Apply on company site" job (skip it). */
export function isExternal(doc: Document): boolean {
  return shown(doc.querySelector('#apply-external-modal'));
}

/** The "apply to all similar roles at <company>" confirm button, when that modal is showing.
 *  Owner's rule: apply to all of them. Targets the applyBulk() action (not applyBulkCancel()). */
export function bulkApplyAllButton(doc: Document): HTMLElement | null {
  const el = [...doc.querySelectorAll('[ng-click*="applyBulk"]')].find(
    (e) => !/cancel/i.test(e.getAttribute('ng-click') ?? '') && shown(e),
  );
  return (el as HTMLElement) ?? null;
}

/** Advance to the next opportunity without applying (`swipeOpp(opp, 'next')`) — used to skip
 *  external jobs and as a fallback if applying doesn't auto-advance. */
export function nextButton(doc: Document): HTMLElement | null {
  const el = [...doc.querySelectorAll('[ng-click*="swipeOpp"], [ng-swipe-left]')].find(
    (e) => /next/.test(e.getAttribute('ng-click') ?? e.getAttribute('ng-swipe-left') ?? '') && shown(e),
  );
  return (el as HTMLElement) ?? null;
}

// --- "Search other jobs" fallback (the full 12k-job board, reached once the matching/Undecided
// queue is drained). It's a normal paginated list — same `openApplyModal` cards, but the modal has
// NO swipeOpp auto-advance, so the loop applies → closes the modal → opens the next card, and clicks
// "Next »" when a page is exhausted. Getting there is two clicks: expand the panel
// (`showSearchedJobs`) then run an empty search (`searchCustomJobs(...)`).

/** The "Search other jobs" panel toggle — expands the search form on the opportunities page. */
export function searchExpander(doc: Document): HTMLElement | null {
  return firstShown(doc, '[ng-click*="showSearchedJobs"]');
}

/** The "Show results" button that runs the (empty = whole board) search. */
export function showResultsButton(doc: Document): HTMLElement | null {
  return firstShown(doc, '[ng-click*="searchCustomJobs"]');
}

/** The "Next »" pager on the search-results list (`nextPage()`), to advance past the 30-per-page. */
export function nextPageButton(doc: Document): HTMLElement | null {
  return firstShown(doc, '[ng-click*="nextPage"]');
}

/** The open apply modal's close control (`closeApplyModal()`) — search modals don't auto-advance, so
 *  the loop closes back to the list after each apply/skip. */
export function closeModalButton(doc: Document): HTMLElement | null {
  return firstShown(doc, '[ng-click*="closeApplyModal"], [ng-click*="closeModal"]');
}

function firstShown(doc: Document, selector: string): HTMLElement | null {
  const el = [...doc.querySelectorAll(selector)].find((e) => shown(e));
  return (el as HTMLElement) ?? null;
}

/** Identity of the opportunity currently shown in the modal, for the on-disk record + detecting
 *  when the modal has advanced to the next job. */
export function currentJob(doc: Document): { id: string; title: string; company: string } {
  const modal = doc.querySelector('.candidate-apply-modal, .application-modal') ?? doc.body;
  const company = labelText(modal.querySelector('.company-name') ?? modal).slice(0, 80);
  const titleEl = modal.querySelector('.job-title, .position-title, .opportunity-title');
  const title = (titleEl ? labelText(titleEl) : companyTitleGuess(modal, company)).slice(0, 120);
  const id = `${company}::${title}`.replace(/\s+/g, ' ').trim() || `instahyre-${Date.now()}`;
  return { id, title: title || 'Instahyre opportunity', company: company || 'Instahyre' };
}

// The modal's job title has no stable class; fall back to the heading nearest the company name.
function companyTitleGuess(modal: Element, company: string): string {
  const companyEl = modal.querySelector('.company-name');
  const near = companyEl?.parentElement?.querySelector('.ng-binding:not(.company-name)');
  const t = near ? labelText(near) : '';
  return t && t !== company ? t : '';
}

export { click };

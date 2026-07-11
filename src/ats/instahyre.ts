import { click, labelText } from './dom';

// Instahyre apply adapter — pure DOM, no chrome/network, so it unit-tests in happy-dom.
//
// Instahyre is an AngularJS SPA. Unlike Greenhouse there is NO form, NO resume upload, NO OTP:
// applying is a single in-page button (`ng-click="submitChoice(opp, true)"`) clicked while the
// user is logged in. The opportunities view is a modal-style stepper — applying advances to the
// next opportunity. This module only *locates* the controls; the content script runs the loop.

/** An element is "shown" if AngularJS hasn't hidden it with the ng-hide class. */
function shown(el: Element | null): el is Element {
  if (!el) return false;
  if (el.classList.contains('ng-hide')) return false;
  // A parent ng-hide hides the child too.
  return !el.closest('.ng-hide');
}

/** The internal "Apply" control for the current opportunity (`submitChoice(opp, true)`).
 *  The ng-click lives on the wrapping `div.apply`; we return the clickable button inside it. */
export function applyButton(doc: Document): HTMLElement | null {
  const wrap = [...doc.querySelectorAll('[ng-click*="submitChoice"]')].find(
    (el) => /submitChoice\([^,]+,\s*true\s*\)/.test(el.getAttribute('ng-click') ?? '') && shown(el),
  );
  if (!wrap) return null;
  const btn = wrap.matches('button') ? wrap : wrap.querySelector('button');
  return (btn as HTMLElement) ?? (wrap as HTMLElement);
}

/** True when the current opportunity is an external "Apply on company site" job. We can't complete
 *  those inside Instahyre, so the loop must skip them. */
export function isExternal(doc: Document): boolean {
  return shown(doc.querySelector('#apply-external-modal'));
}

/** The "apply to all similar jobs at <company>" bulk modal's confirm button, when it's showing.
 *  Owner's rule: when a company posts several roles, apply to all of them. */
export function bulkApplyAllButton(doc: Document): HTMLElement | null {
  const modal = doc.querySelector('candidate-apply-all-modal, #candidate-apply-all-modal, .apply-all-modal');
  if (!shown(modal)) return null;
  const btn =
    modal!.querySelector('[ng-click*="applyBulk"]') ??
    [...modal!.querySelectorAll('button')].find((b) => /apply/i.test(labelText(b)));
  return (btn as HTMLElement) ?? null;
}

/** Advance to the next opportunity without applying (used to skip external jobs). Prefers an
 *  explicit next/swipe control; falls back to the "Not interested"-adjacent skip if present. */
export function nextButton(doc: Document): HTMLElement | null {
  const next = [...doc.querySelectorAll('[ng-click*="swipeOpp"], [ng-click*="nextOpp"], .next-opp')].find(
    (el) => /next/i.test(el.getAttribute('ng-click') ?? '') || el.classList.contains('next-opp'),
  );
  return shown(next ?? null) ? (next as HTMLElement) : null;
}

/** Best-effort identity of the opportunity on screen, for the on-disk application record. */
export function currentJob(doc: Document): { id: string; title: string; company: string } {
  const scope = doc.querySelector('.opportunity, .employer-block, #apply-modal, .apply-modal') ?? doc.body;
  const title = labelText(scope.querySelector('.job-title, .opportunity-title, h1, h2') ?? scope).slice(0, 120);
  const company = labelText(scope.querySelector('.company-name, .employer-name, .company') ?? scope).slice(0, 80);
  const id = `${company}::${title}`.replace(/\s+/g, ' ').trim() || `instahyre-${Date.now()}`;
  return { id, title: title || 'Instahyre opportunity', company: company || 'Instahyre' };
}

export { click };

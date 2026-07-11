import { describe, it, expect } from 'vitest';
import {
  openModalLink,
  applyButton,
  isExternal,
  bulkApplyAllButton,
  nextButton,
  currentJob,
} from '@/ats/instahyre';

// Fixtures mirror the live logged-in Instahyre opportunities DOM (AngularJS 1.2), verified via the
// Chrome MCP: listing cards open a modal (`openApplyModal`), and the Apply DIV
// (`submitChoice(opp, true)`) lives ONLY inside that modal. happy-dom has no layout, so shown()'s
// offsetParent check is exercised by presence/ng-hide here; live timing is the owner's run.

const parse = (html: string): Document => new DOMParser().parseFromString(html, 'text/html');

// happy-dom reports offsetParent null for everything; give attached, non-ng-hide nodes a rect so
// shown() treats them as visible (matches a real laid-out element).
function visible(doc: Document): void {
  for (const el of doc.querySelectorAll('*')) {
    (el as HTMLElement).getClientRects = () => [{ width: 1, height: 1 }] as unknown as DOMRectList;
  }
}

const listing = `
  <div class="employer-block">
    <a class="row text-link" ng-click="openApplyModal(opp)">Razorpay - AI Engineer</a>
    <button class="button-not-interested btn" ng-click="submitChoice(opp, false)">Not interested</button>
  </div>`;

const modal = (external = false) => `
  <div class="application-modal candidate-apply-modal">
    <div class="side-section"><div class="company-name ng-binding">Razorpay</div><div class="ng-binding">AI Engineer</div></div>
    <div class="apply ng-scope" ng-click="submitChoice(opp, true)">Apply</div>
    <div ng-click="!disableSwipe ? swipeOpp(opp, 'next'): ''">next</div>
  </div>
  <div id="apply-external-modal"${external ? '' : ' class="ng-hide"'}><button>Apply on company site</button></div>`;

describe('instahyre adapter — control location', () => {
  it('finds the card link that opens the apply modal', () => {
    const doc = parse(listing);
    visible(doc);
    expect(openModalLink(doc)).not.toBeNull();
    expect(openModalLink(doc)!.getAttribute('ng-click')).toContain('openApplyModal');
  });

  it('has NO apply button on the bare listing (Apply only exists in the modal)', () => {
    const doc = parse(listing);
    visible(doc);
    expect(applyButton(doc)).toBeNull();
  });

  it('finds the Apply div (submitChoice(opp, true)) once the modal is open', () => {
    const doc = parse(modal());
    visible(doc);
    const btn = applyButton(doc);
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain('Apply');
  });

  it('never returns the "Not interested" (submitChoice false) control as an apply target', () => {
    const doc = parse(listing);
    visible(doc);
    expect(applyButton(doc)).toBeNull();
  });

  it('ignores an ng-hidden apply control', () => {
    const doc = parse(`<div class="apply ng-hide" ng-click="submitChoice(opp, true)">Apply</div>`);
    visible(doc);
    expect(applyButton(doc)).toBeNull();
  });

  it('detects external vs internal opportunities', () => {
    const ext = parse(modal(true));
    visible(ext);
    expect(isExternal(ext)).toBe(true);
    const internal = parse(modal(false));
    visible(internal);
    expect(isExternal(internal)).toBe(false);
  });

  it('finds the bulk apply-all button only when shown, and not the cancel', () => {
    const open = parse(`
      <div class="candidate-apply-all-modal">
        <p>Want to apply to other similar jobs at Razorpay?</p>
        <button ng-click="applyBulk()">Apply all</button>
        <button ng-click="applyBulkCancel()">No thanks</button>
      </div>`);
    visible(open);
    const btn = bulkApplyAllButton(open);
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute('ng-click')).toBe('applyBulk()');

    const hidden = parse(`<div class="ng-hide"><button ng-click="applyBulk()">Apply all</button></div>`);
    visible(hidden);
    expect(bulkApplyAllButton(hidden)).toBeNull();
  });

  it('finds the swipe-next control to advance/skip', () => {
    const doc = parse(modal());
    visible(doc);
    expect(nextButton(doc)).not.toBeNull();
  });

  it('reads the opportunity identity from the modal', () => {
    const doc = parse(modal());
    visible(doc);
    const job = currentJob(doc);
    expect(job.company).toContain('Razorpay');
    expect(job.title).toContain('AI Engineer');
    expect(job.id).toContain('Razorpay');
  });
});

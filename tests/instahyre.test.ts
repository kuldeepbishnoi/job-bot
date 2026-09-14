import { describe, it, expect } from 'vitest';
import {
  openModalLink,
  openModalLinks,
  cardId,
  applyButton,
  isExternal,
  bulkApplyAllButton,
  nextButton,
  nextPageButton,
  searchExpander,
  showResultsButton,
  closeModalButton,
  currentJob,
  bulkCancelButton,
} from '@/ats/instahyre';
import { titleWanted } from '@/engine/select-jobs';

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

// The "Search other jobs" board: a paginated list of `openApplyModal` cards, reached by expanding
// the search panel (`showSearchedJobs`) then running an empty search (`searchCustomJobs`). Verified
// live: 30 cards/page, "Next »" (`nextPage`) pager, modal closed via `closeApplyModal`.
const searchList = `
  <div class="search-panel">
    <a ng-click="showSearchedJobs()">Search other jobs</a>
    <button ng-click="searchCustomJobs(undefined, null, null, true)">Show results</button>
  </div>
  <div class="employer-block"><a ng-click="openApplyModal(opp)">Urban Harvest - Software Engineer</a></div>
  <div class="employer-block"><a ng-click="openApplyModal(opp)">Infosys - Software Engineer</a></div>
  <div class="employer-block"><a ng-click="openApplyModal(opp)">Impact Analytics - Architect</a></div>
  <div class="pagination">
    <a ng-click="nthPage(1)">1</a>
    <a ng-click="nextPage()">Next »</a>
  </div>`;

describe('instahyre adapter — search-list fallback', () => {
  it('lists every visible card and dedupes by identity', () => {
    const doc = parse(searchList);
    visible(doc);
    const links = openModalLinks(doc);
    expect(links).toHaveLength(3);
    const ids = links.map((el) => cardId(el));
    expect(ids[0]).toContain('Urban Harvest');
    expect(new Set(ids).size).toBe(3);
  });

  it('finds the search panel + show-results controls to enter the board', () => {
    const doc = parse(searchList);
    visible(doc);
    expect(searchExpander(doc)!.getAttribute('ng-click')).toBe('showSearchedJobs()');
    expect(showResultsButton(doc)!.getAttribute('ng-click')).toContain('searchCustomJobs');
  });

  it('finds the "Next »" pager but not the numbered page links', () => {
    const doc = parse(searchList);
    visible(doc);
    expect(nextPageButton(doc)!.getAttribute('ng-click')).toBe('nextPage()');
  });

  it('finds the modal close control', () => {
    const doc = parse(`<div class="application-modal"><a ng-click="closeApplyModal()">×</a></div>`);
    visible(doc);
    expect(closeModalButton(doc)!.getAttribute('ng-click')).toBe('closeApplyModal()');
  });
});

// ---------------------------------------------------------------------------------------------
// #regression (2026-09-15): the Instahyre loop had NO title filter and applied to every card with
// an Apply button. Real applications went out to Finance Manager, Customer Support Executive and
// IP Sales Engineer roles under the owner's name. Every unit test passed the whole time, because
// the bug was never in the logic — profile.want simply never reached the page. These assert the
// wiring itself: the filter decision, and the bulk-apply path that bypasses it.
describe('instahyre title filtering (the wiring that was missing)', () => {
  const want = { titles_any: ['SDE', 'Software Engineer', 'Backend'], titles_none: ['Manager', 'Intern'], locations: [], seniority: [] };

  it('rejects the exact titles that were wrongly applied to live', () => {
    for (const bad of ['Finance Manager', 'Customer Support Executive', 'IP Sales Engineer', 'Head HRBP', 'Office Manager']) {
      expect(titleWanted(bad, want), bad).toBe(false);
    }
  });

  it('still accepts the roles the owner actually wants', () => {
    for (const good of ['Senior Software Engineer', 'SDE II (Backend)', 'Backend Developer']) {
      expect(titleWanted(good, want), good).toBe(true);
    }
  });

  it('titles_none wins over titles_any, so "Engineering Manager" is never applied to', () => {
    expect(titleWanted('Engineering Manager', { ...want, titles_any: ['Engineer'] })).toBe(false);
  });

  it('an explicitly empty filter still means "no title restriction" (the user\'s own choice)', () => {
    expect(titleWanted('Finance Manager', { titles_any: [], titles_none: [], locations: [], seniority: [] })).toBe(true);
  });

  it('the search-board card text is filterable as-is — "<Company> - <Title>" contains the title', () => {
    const doc = parse(`<div class="employer-block"><a ng-click="openApplyModal(opp)">Convosight - Finance Manager</a></div>`);
    visible(doc);
    expect(titleWanted(cardId(openModalLinks(doc)[0]!), want)).toBe(false);
    const ok = parse(`<div class="employer-block"><a ng-click="openApplyModal(opp)">Razorpay - Senior Software Engineer</a></div>`);
    visible(ok);
    expect(titleWanted(cardId(openModalLinks(ok)[0]!), want)).toBe(true);
  });

  it('exposes a cancel control for the "all similar roles" modal, whose other roles are never title-checked', () => {
    const doc = parse(`<div class="modal"><button ng-click="applyBulk()">Apply to all</button><button ng-click="applyBulkCancel()">No thanks</button></div>`);
    visible(doc);
    expect(bulkApplyAllButton(doc)?.textContent).toBe('Apply to all');
    expect(bulkCancelButton(doc)?.textContent).toBe('No thanks'); // used whenever a filter is set
  });
});

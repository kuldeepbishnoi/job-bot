import { describe, it, expect } from 'vitest';
import { applyButton, isExternal, bulkApplyAllButton, nextButton, currentJob } from '@/ats/instahyre';

// Fixtures reconstruct the Instahyre opportunities DOM the owner captured from the live, logged-in
// page (AngularJS 1.2). Not a HAR capture — the apply flow needs a session — so these lock in the
// selector contract; live timing/advance is validated by the owner's one-button run.

const parse = (html: string): Document => new DOMParser().parseFromString(html, 'text/html');

describe('instahyre adapter — control location', () => {
  it('finds the internal Apply button (submitChoice(opp, true))', () => {
    const doc = parse(`
      <div class="opportunity">
        <div class="apply" ng-click="submitChoice(opp, true)"><button class="btn btn-primary new-btn">Apply</button></div>
        <button class="btn decline new-btn" ng-click="submitChoice(opp, false)">Not interested</button>
      </div>`);
    const btn = applyButton(doc);
    expect(btn).not.toBeNull();
    expect(btn!.tagName).toBe('BUTTON');
    expect(btn!.textContent).toContain('Apply');
  });

  it('does NOT return the decline button as an apply target', () => {
    const doc = parse(`
      <div class="apply" ng-click="submitChoice(opp, false)"><button>Not interested</button></div>`);
    expect(applyButton(doc)).toBeNull();
  });

  it('ignores an ng-hidden apply control (already applied / off-screen)', () => {
    const doc = parse(`
      <div class="apply ng-hide" ng-click="submitChoice(opp, true)"><button>Apply</button></div>`);
    expect(applyButton(doc)).toBeNull();
  });

  it('detects an external-apply opportunity so the loop can skip it', () => {
    const shown = parse(`<div id="apply-external-modal"><button>Apply on company site</button></div>`);
    expect(isExternal(shown)).toBe(true);
    const hidden = parse(`<div id="apply-external-modal" class="ng-hide"><button>Apply on company site</button></div>`);
    expect(isExternal(hidden)).toBe(false);
    expect(isExternal(parse('<div></div>'))).toBe(false);
  });

  it('finds the "apply to all similar roles" bulk button only when its modal shows', () => {
    const open = parse(`
      <candidate-apply-all-modal>
        <p>Want to apply to other similar jobs at Acme?</p>
        <button ng-click="applyBulk()">Apply all</button>
      </candidate-apply-all-modal>`);
    expect(bulkApplyAllButton(open)).not.toBeNull();

    const closed = parse(`<candidate-apply-all-modal class="ng-hide"><button ng-click="applyBulk()">Apply all</button></candidate-apply-all-modal>`);
    expect(bulkApplyAllButton(closed)).toBeNull();
    expect(bulkApplyAllButton(parse('<div></div>'))).toBeNull();
  });

  it('finds a next/swipe control to advance past a skipped job', () => {
    const doc = parse(`<button ng-click="swipeOpp(opp, 'next')">Next</button>`);
    expect(nextButton(doc)).not.toBeNull();
    expect(nextButton(parse('<div></div>'))).toBeNull();
  });

  it('extracts a stable-ish job identity for the record', () => {
    const doc = parse(`
      <div class="opportunity">
        <div class="company-name">Acme Corp</div>
        <h2 class="job-title">Senior Backend Engineer</h2>
      </div>`);
    const job = currentJob(doc);
    expect(job.title).toContain('Senior Backend Engineer');
    expect(job.company).toContain('Acme Corp');
    expect(job.id).toContain('Senior Backend Engineer');
  });
});

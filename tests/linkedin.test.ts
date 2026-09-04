import { describe, it, expect } from 'vitest';
import {
  jobCards, cardJobId, cardInfo, cardLink, openCard, isResultsPage, currentJobIdFromUrl, nextPageButton,
  easyApplyButton, externalApplyOnly, jobClosedMessage, alreadyAppliedPane, paneJob,
  modal, safetyContinueButton, progress, actionButton, followCompanyCheckbox, uncheckFollowCompany, validationErrors,
  extract, optionsFor, isNumeric, currentAnswer, isAnswered, fill, isTypeaheadField, resumeSelected, attachResume,
  applicationSent, dismissButton, discardButton, limitReached, rateLimited, describeState, describeQuestions,
} from '@/ats/linkedin';
import { withIntent } from '@/engine/matcher';
import { resolve, guessAnswer, pickPhoneCountry } from '@/engine/resolver';
import { titleWanted } from '@/engine/select-jobs';
import { parseProfile } from '@/config/schema';
import { searchUrl } from '@/app/linkedin-run';
import type { Job } from '@/engine/types';

// Fixture markup transcribes LinkedIn's legacy /jobs/search/ DOM as two shipping auto-apply
// extensions drive it (selectors + attributes copied from their adapters, 2026-09): job cards,
// the details pane's Easy Apply button, the Easy Apply modal's question blocks, footer buttons,
// the post-submit dialog, the Discard confirm and the daily-limit dialog. happy-dom has no layout,
// so give every node a rect (shown() checks offsetParent OR a client rect).

const parse = (html: string): Document => new DOMParser().parseFromString(html, 'text/html');
function visible(doc: Document): void {
  for (const el of doc.querySelectorAll('*')) (el as HTMLElement).getClientRects = () => [{ width: 1, height: 1 }] as unknown as DOMRectList;
}
const load = (html: string): Document => {
  const d = parse(html);
  visible(d);
  return d;
};

const LIST = `
<div class="scaffold-layout__list">
  <ul class="scaffold-layout__list-container">
    <li data-occludable-job-id="4038498138" class="jobs-search-results__list-item">
      <div class="job-card-container" data-job-id="4038498138">
        <a class="job-card-container__link job-card-list__title--link" href="/jobs/view/4038498138/?eBP=x"><strong>Senior Software Engineer</strong><span class="visually-hidden">Senior Software Engineer with verification</span></a>
        <div class="artdeco-entity-lockup__subtitle"><span>Razorpay</span></div>
        <ul class="job-card-container__metadata-wrapper"><li>Bengaluru, Karnataka, India (Hybrid)</li></ul>
        <ul class="job-card-list__footer-wrapper"><li class="job-card-container__apply-method"><svg data-test-icon="linkedin-bug-xxsmall"></svg> Easy Apply</li></ul>
      </div>
    </li>
    <li data-occludable-job-id="4038498139">
      <div class="job-card-container" data-job-id="4038498139">
        <a class="job-card-container__link" href="/jobs/view/4038498139/"><strong>Engineering Manager</strong></a>
        <div class="artdeco-entity-lockup__subtitle">Acme</div>
        <ul class="job-card-container__metadata-wrapper"><li>Remote</li></ul>
        <ul class="job-card-list__footer-wrapper"><li>Applied 2 days ago · Viewed</li></ul>
      </div>
    </li>
    <li data-occludable-job-id="4038498140">
      <div class="job-card-container" data-job-id="4038498140">
        <a class="job-card-container__link" href="/jobs/view/4038498140/"><strong>Backend Developer</strong></a>
        <div class="artdeco-entity-lockup__subtitle">Globex</div>
        <ul class="job-card-list__footer-wrapper"><li>Promoted</li></ul>
      </div>
    </li>
    <li data-occludable-job-id="4038498141"><!----></li>
  </ul>
  <div class="jobs-search-pagination">
    <button aria-label="Page 1" aria-current="true" class="active">1</button>
    <button aria-label="Page 2">2</button>
    <button aria-label="View next page" class="jobs-search-pagination__button--next">Next</button>
  </div>
</div>`;

const NEW_LIST = `
<div>
  <div componentkey="job-card-component-ref-4100000001" role="button" tabindex="0"><figure><img alt=""></figure>
    <p>Software Engineer Software Engineer</p><p>Initech</p><p>Bengaluru, India</p><p>2 days ago</p><p>Easy Apply</p>
  </div>
  <div componentkey="job-card-component-ref-4100000002" role="button" tabindex="0"><figure><img alt=""></figure>
    <p>Data Analyst</p><p>Umbrella</p><p>Pune</p><p>Application submitted</p>
  </div>
</div>`;

const PANE = (apply: string, extra = '') => `
<div class="jobs-search__job-details">
  <div class="job-details-jobs-unified-top-card__container--two-pane">
    <h1 class="t-24 job-details-jobs-unified-top-card__job-title">Senior Software Engineer</h1>
    <div class="job-details-jobs-unified-top-card__company-name"><a href="/company/razorpay">Razorpay</a></div>
    ${extra}
    <div class="jobs-apply-button--top-card">${apply}</div>
  </div>
</div>`;
const EASY_BTN = `<button class="jobs-apply-button artdeco-button" aria-label="Easy Apply to Senior Software Engineer at Razorpay"><span class="artdeco-button__text">Easy Apply</span></button>`;
const EXTERNAL_BTN = `<button class="jobs-apply-button artdeco-button" aria-label="Apply to Senior Software Engineer at Razorpay on company website"><span>Apply</span></button>`;
const FILTER_CHIP = `<div class="search-reusables__filter-list"><button aria-label="Easy Apply filter." class="search-reusables__filter-pill-button">Easy Apply</button></div>`;

const MODAL = (body: string, footer: string, progressValue = 25) => `
<div class="artdeco-modal jobs-easy-apply-modal" role="dialog" data-test-modal-id="easy-apply-modal" aria-labelledby="jobs-apply-header">
  <button aria-label="Dismiss" class="artdeco-modal__dismiss"></button>
  <div class="jobs-easy-apply-content">
    <h2 id="jobs-apply-header">Apply to Razorpay</h2>
    <progress class="artdeco-completeness-meter-linear__progress-element" value="${progressValue}" max="100"></progress>
    <form>${body}</form>
    <footer>${footer}</footer>
  </div>
</div>`;

const QUESTIONS = `
<div class="jobs-easy-apply-form-section__grouping">
  <div data-test-form-element class="fb-dash-form-element">
    <label class="fb-dash-form-element__label" for="text-entity-list-form-component-formElement-urn-li-jobs-applyformcommon-easyApplyFormElement-4038498138-1-multipleChoice">Email address</label>
    <select id="text-entity-list-form-component-formElement-urn-li-jobs-applyformcommon-easyApplyFormElement-4038498138-1-multipleChoice" data-test-text-entity-list-form-select required>
      <option value="Select an option">Select an option</option>
      <option value="k@x.com">k@x.com</option>
      <option value="other@x.com">other@x.com</option>
    </select>
  </div>
  <div data-test-form-element class="fb-dash-form-element">
    <label class="fb-dash-form-element__label" for="text-entity-list-form-component-formElement-urn-li-jobs-applyformcommon-easyApplyFormElement-4038498138-2-phoneNumber-country">Phone country code</label>
    <select id="text-entity-list-form-component-formElement-urn-li-jobs-applyformcommon-easyApplyFormElement-4038498138-2-phoneNumber-country" data-test-text-entity-list-form-select>
      <option value="Select an option">Select an option</option>
      <option value="BIOT">British Indian Ocean Territory (+246)</option>
      <option value="IN">India (+91)</option>
      <option value="US">United States (+1)</option>
    </select>
  </div>
  <div data-test-form-element class="fb-dash-form-element">
    <div class="artdeco-text-input--container">
      <label class="artdeco-text-input--label" for="single-line-text-form-component-formElement-urn-li-jobs-applyformcommon-easyApplyFormElement-4038498138-3-phoneNumber-nationalNumber">Mobile phone number</label>
      <input class="artdeco-text-input--input" id="single-line-text-form-component-formElement-urn-li-jobs-applyformcommon-easyApplyFormElement-4038498138-3-phoneNumber-nationalNumber" type="text" value="9416375330">
    </div>
  </div>
  <div data-test-form-element class="fb-dash-form-element">
    <div class="artdeco-text-input--container">
      <label class="artdeco-text-input--label" for="single-line-text-form-component-formElement-urn-li-jobs-applyformcommon-easyApplyFormElement-4038498138-4-numeric">How many years of work experience do you have with Java?</label>
      <input class="artdeco-text-input--input" id="single-line-text-form-component-formElement-urn-li-jobs-applyformcommon-easyApplyFormElement-4038498138-4-numeric" type="text">
    </div>
    <div class="artdeco-inline-feedback artdeco-inline-feedback--error" role="alert"><span class="artdeco-inline-feedback__message">Enter a whole number between 0 and 99</span></div>
  </div>
  <div data-test-form-element class="fb-dash-form-element">
    <fieldset data-test-form-builder-radio-button-form-component="true">
      <legend><span class="fb-dash-form-element__label"><span aria-hidden="true">Are you comfortable commuting to this job's location?</span></span></legend>
      <div data-test-text-selectable-option><input type="radio" id="radio-button-form-component-formElement-urn-li-jobs-applyformcommon-easyApplyFormElement-4038498138-5-multipleChoice-0" name="radio-button-form-component-formElement-urn-li-jobs-applyformcommon-easyApplyFormElement-4038498138-5-multipleChoice" value="Yes" data-test-text-selectable-option__input="Yes"><label data-test-text-selectable-option__label for="radio-button-form-component-formElement-urn-li-jobs-applyformcommon-easyApplyFormElement-4038498138-5-multipleChoice-0">Yes</label></div>
      <div data-test-text-selectable-option><input type="radio" id="radio-button-form-component-formElement-urn-li-jobs-applyformcommon-easyApplyFormElement-4038498138-5-multipleChoice-1" name="radio-button-form-component-formElement-urn-li-jobs-applyformcommon-easyApplyFormElement-4038498138-5-multipleChoice" value="No" data-test-text-selectable-option__input="No"><label data-test-text-selectable-option__label for="radio-button-form-component-formElement-urn-li-jobs-applyformcommon-easyApplyFormElement-4038498138-5-multipleChoice-1">No</label></div>
    </fieldset>
  </div>
  <div data-test-form-element class="fb-dash-form-element">
    <fieldset data-test-checkbox-form-component="true">
      <legend><span data-test-checkbox-form-title>Which of the following languages do you speak?</span></legend>
      <div data-test-text-selectable-option><input type="checkbox" id="checkbox-form-component-formElement-urn-li-jobs-applyformcommon-easyApplyFormElement-4038498138-6-multipleChoice-0" name="checkbox-6" value="English"><label for="checkbox-form-component-formElement-urn-li-jobs-applyformcommon-easyApplyFormElement-4038498138-6-multipleChoice-0">English</label></div>
      <div data-test-text-selectable-option><input type="checkbox" id="checkbox-form-component-formElement-urn-li-jobs-applyformcommon-easyApplyFormElement-4038498138-6-multipleChoice-1" name="checkbox-6" value="Hindi"><label for="checkbox-form-component-formElement-urn-li-jobs-applyformcommon-easyApplyFormElement-4038498138-6-multipleChoice-1">Hindi</label></div>
      <div data-test-text-selectable-option><input type="checkbox" id="checkbox-form-component-formElement-urn-li-jobs-applyformcommon-easyApplyFormElement-4038498138-6-multipleChoice-2" name="checkbox-6" value="German"><label for="checkbox-form-component-formElement-urn-li-jobs-applyformcommon-easyApplyFormElement-4038498138-6-multipleChoice-2">German</label></div>
    </fieldset>
  </div>
  <div data-test-form-element class="fb-dash-form-element">
    <div data-test-single-typeahead-entity-form-component>
      <label for="single-typeahead-entity-form-component-formElement-urn-li-jobs-applyformcommon-easyApplyFormElement-4038498138-7-city-HOME-CITY">City</label>
      <input role="combobox" aria-autocomplete="list" aria-controls="triggered-expanded-7" id="single-typeahead-entity-form-component-formElement-urn-li-jobs-applyformcommon-easyApplyFormElement-4038498138-7-city-HOME-CITY" type="text">
      <div class="basic-typeahead__triggered-content" role="listbox" id="triggered-expanded-7"></div>
    </div>
  </div>
  <div data-test-form-element class="fb-dash-form-element">
    <label class="fb-dash-form-element__label" for="text-entity-list-form-component-formElement-urn-li-jobs-applyformcommon-easyApplyFormElement-4038498138-8-multipleChoice">What is your level of proficiency in English?</label>
    <select id="text-entity-list-form-component-formElement-urn-li-jobs-applyformcommon-easyApplyFormElement-4038498138-8-multipleChoice" data-test-text-entity-list-form-select>
      <option value="Select an option">Select an option</option>
      <option value="Native">Native or bilingual</option>
      <option value="Professional">Professional</option>
      <option value="Conversational">Conversational</option>
    </select>
  </div>
</div>`;

const NEXT = `<button aria-label="Continue to next step" data-easy-apply-next-button data-live-test-easy-apply-next-button class="artdeco-button"><span>Next</span></button>`;
const REVIEW = `<button aria-label="Review your application" data-live-test-easy-apply-review-button class="artdeco-button"><span>Review</span></button>`;
const SUBMIT = `
<div class="job-details-easy-apply-footer__section"><input id="follow-company-checkbox" type="checkbox" checked><label for="follow-company-checkbox">Follow Razorpay to stay up to date</label></div>
<button aria-label="Submit application" data-live-test-easy-apply-submit-button class="artdeco-button"><span>Submit application</span></button>`;

const RESUME_STEP = `
<div class="jobs-document-upload-redesign-card__container jobs-document-upload-redesign-card__container--selected"><input type="radio" name="resume" id="resume-1" checked><label for="resume-1">kuldeep.pdf</label></div>
<div class="jobs-document-upload__container"><label for="jobs-document-upload-file-input-upload-resume">Upload resume</label><input id="jobs-document-upload-file-input-upload-resume" class="jobs-document-upload__input" type="file"></div>`;

const SENT = `<div class="artdeco-modal" role="dialog" aria-labelledby="post-apply-modal"><button aria-label="Dismiss" class="artdeco-modal__dismiss"></button><h2 id="post-apply-modal">Your application was sent to Razorpay!</h2><button class="artdeco-button">Done</button></div>`;
const DISCARD = `<div role="alertdialog" data-test-modal-id="data-test-easy-apply-discard-modal"><p>Discard application?</p><button data-control-name="discard_application_confirm_btn" data-test-dialog-primary-btn>Discard</button><button>Cancel</button></div>`;
const LIMIT = `<div role="dialog" class="artdeco-modal"><div class="artdeco-modal__content"><h2>You've reached today's Easy Apply limit</h2><p>Save this job and continue applying tomorrow.</p><button aria-label="Got it">Got it</button></div></div>`;
const PACE = `<div class="artdeco-toast-item" role="alert">You're applying at a fast pace. We've briefly paused Easy Apply to safeguard against automated tools.</div>`;

const profile = parseProfile({
  identity: { first_name: 'K', last_name: 'B', email: 'k@x.com', phone: '+91 9416375330', country: 'India', city: 'Bengaluru' },
  resume: 'resume/cv.pdf',
  want: { titles_any: ['Software Engineer', 'Backend'], titles_none: ['Manager'] },
  on_unknown: 'guess',
  answers: { years_of_experience: 6, commute_ok: true, languages: ['English', 'Hindi'], language_proficiency: 'Professional' },
  linkedin: { search_urls: ['https://www.linkedin.com/jobs/search/?keywords=software%20engineer&location=India'] },
});
const job: Job = { id: '4038498138', title: 'Senior Software Engineer', team: '', department: '', url: '', locations: [], seniority: [] };

describe('linkedin adapter — job list', () => {
  it('enumerates cards in order with their ids (unhydrated placeholders included)', () => {
    const doc = load(LIST);
    expect(jobCards(doc).map((c) => cardJobId(c))).toEqual(['4038498138', '4038498139', '4038498140', '4038498141']);
  });

  it('reads title/company/location + badges from a legacy card, dropping the a11y duplicate', () => {
    const doc = load(LIST);
    const [a, b, c, d] = jobCards(doc).map((x) => cardInfo(x));
    expect(a).toMatchObject({ id: '4038498138', title: 'Senior Software Engineer', company: 'Razorpay', easyApply: true, applied: false });
    expect(a!.location).toContain('Bengaluru');
    expect(b).toMatchObject({ title: 'Engineering Manager', applied: true });
    expect(c).toMatchObject({ title: 'Backend Developer', easyApply: false, applied: false });
    expect(d!.easyApply).toBeNull(); // not hydrated yet — must be opened to know
  });

  it('reads the new-layout card (componentkey + positional paragraphs)', () => {
    const doc = load(NEW_LIST);
    const [a, b] = jobCards(doc).map((x) => cardInfo(x));
    expect(a).toMatchObject({ id: '4100000001', title: 'Software Engineer', company: 'Initech', easyApply: true, applied: false });
    expect(b).toMatchObject({ id: '4100000002', applied: true });
  });

  it('finds the card link and the next-page control', () => {
    const doc = load(LIST);
    expect(cardLink(jobCards(doc)[0]!).getAttribute('href')).toContain('/jobs/view/4038498138');
    expect(nextPageButton(doc)!.getAttribute('aria-label')).toBe('View next page');
    expect(currentJobIdFromUrl('https://www.linkedin.com/jobs/search/?currentJobId=4038498138&f_AL=true')).toBe('4038498138');
    expect(currentJobIdFromUrl('https://www.linkedin.com/jobs/view/4038498140/')).toBe('4038498140');
  });

  it('opens a card without following its link (a real navigation would kill the script)', () => {
    const doc = load(LIST);
    const card = jobCards(doc)[0]!;
    const link = card.querySelector('a')!;
    let defaultPrevented: boolean | null = null;
    let handlerRan = false;
    doc.addEventListener('click', (e) => {
      handlerRan = true; // LinkedIn's delegated handler still sees the click…
      defaultPrevented = e.defaultPrevented; // …but the anchor's navigation is off
    });
    openCard(card);
    expect(handlerRan).toBe(true);
    expect(defaultPrevented).toBe(true);
    // The one-shot block is gone: a later (user) click on the link is normal again.
    let later: boolean | null = null;
    doc.addEventListener('click', (e) => (later = e.defaultPrevented));
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(later).toBe(false);
  });

  it('knows which pages list cards', () => {
    expect(isResultsPage('https://www.linkedin.com/jobs/search/?keywords=sde&f_AL=true')).toBe(true);
    expect(isResultsPage('https://www.linkedin.com/jobs/search-results/?keywords=sde')).toBe(true);
    expect(isResultsPage('https://www.linkedin.com/jobs/collections/easy-apply/')).toBe(true);
    expect(isResultsPage('https://www.linkedin.com/jobs/view/4460487322/?eBP=x')).toBe(false);
    expect(isResultsPage('https://www.linkedin.com/jobs/')).toBe(false);
  });

  it('title filter honours want.titles_any / titles_none', () => {
    expect(titleWanted('Senior Software Engineer', profile.want)).toBe(true);
    expect(titleWanted('Engineering Manager', profile.want)).toBe(false);
    expect(titleWanted('Product Designer', profile.want)).toBe(false);
  });

  it('forces the Easy Apply filter and pages with start=', () => {
    expect(searchUrl('https://www.linkedin.com/jobs/search/?keywords=sde&start=50', 0)).toBe('https://www.linkedin.com/jobs/search/?keywords=sde&f_AL=true');
    expect(searchUrl('https://www.linkedin.com/jobs/search/?keywords=sde', 25)).toContain('start=25');
  });
});

describe('linkedin adapter — details pane', () => {
  it('finds the Easy Apply button, never the filter chip, never an external Apply', () => {
    const easy = load(FILTER_CHIP + PANE(EASY_BTN));
    expect(easyApplyButton(easy)!.className).toContain('jobs-apply-button');
    expect(externalApplyOnly(easy)).toBe(false);
    const ext = load(FILTER_CHIP + PANE(EXTERNAL_BTN));
    expect(easyApplyButton(ext)).toBeNull();
    expect(externalApplyOnly(ext)).toBe(true);
    const chipOnly = load(FILTER_CHIP + PANE(''));
    expect(easyApplyButton(chipOnly)).toBeNull();
  });

  it('accepts the new layout\'s <a aria-label="Easy Apply to this job">', () => {
    const doc = load(`<div class="scaffold-layout__detail"><a aria-label="Easy Apply to this job" href="/jobs/view/1/?openSDUIApplyFlow=true">Easy Apply</a></div>`);
    expect(easyApplyButton(doc)!.tagName).toBe('A');
  });

  it('detects closed jobs and already-applied panes, and reads the pane title/company', () => {
    const closed = load(PANE('', `<div class="jobs-details-top-card__apply-error">No longer accepting applications</div>`));
    expect(jobClosedMessage(closed)).toContain('No longer accepting');
    const applied = load(PANE('', `<div class="artdeco-inline-feedback"><span class="artdeco-inline-feedback__message">Applied 3 days ago</span></div>`));
    expect(alreadyAppliedPane(applied)).toBe(true);
    expect(alreadyAppliedPane(load(PANE(EASY_BTN)))).toBe(false);
    expect(paneJob(load(PANE(EASY_BTN)))).toEqual({ title: 'Senior Software Engineer', company: 'Razorpay' });
  });
});

describe('linkedin adapter — modal + questions', () => {
  it('finds the modal, its progress and the one footer action (Submit > Review > Next)', () => {
    const next = load(MODAL(QUESTIONS, NEXT, 25));
    const m = modal(next)!;
    expect(m).not.toBeNull();
    expect(progress(m)).toBe(25);
    expect(actionButton(m)!.kind).toBe('next');
    expect(actionButton(modal(load(MODAL('', REVIEW, 75)))!)!.kind).toBe('review');
    const submit = load(MODAL('', SUBMIT, 100));
    expect(actionButton(modal(submit)!)!.kind).toBe('submit');
    expect(modal(load(PANE(EASY_BTN)))).toBeNull();
  });

  it('extracts every question with the right kind, id, options and numeric hint', () => {
    const m = modal(load(MODAL(QUESTIONS, NEXT)))!;
    const fields = extract(m);
    expect(fields.map((f) => [f.kind, f.label])).toEqual([
      ['select', 'Email address'],
      ['select', 'Phone country code'],
      ['text', 'Mobile phone number'],
      ['text', 'How many years of work experience do you have with Java?'],
      ['select', "Are you comfortable commuting to this job's location?"],
      ['multiselect', 'Which of the following languages do you speak?'],
      ['select', 'City'],
      ['select', 'What is your level of proficiency in English?'],
    ]);
    expect(optionsFor(m, fields[0]!)).toEqual(['k@x.com', 'other@x.com']); // placeholder dropped
    expect(optionsFor(m, fields[4]!)).toEqual(['Yes', 'No']);
    expect(optionsFor(m, fields[5]!)).toEqual(['English', 'Hindi', 'German']);
    expect(optionsFor(m, fields[6]!)).toEqual([]); // typeahead — typed, not picked
    expect(isTypeaheadField(m, fields[6]!)).toBe(true);
    expect(isNumeric(m, fields[3]!)).toBe(true);
    expect(isNumeric(m, fields[2]!)).toBe(false);
    expect(currentAnswer(m, fields[2]!)).toBe('9416375330'); // pre-filled by LinkedIn → kept
    expect(isAnswered(m, fields[3]!)).toBe(false);
    expect(validationErrors(m)).toEqual(['Enter a whole number between 0 and 99']);
    expect(describeQuestions(m)).toContain('text# "How many years');
  });

  it('resolves LinkedIn answers from the profile through the shared engine', () => {
    const m = modal(load(MODAL(QUESTIONS, NEXT)))!;
    const fields = extract(m).map(withIntent);
    const answer = (i: number) => resolve(fields[i]!, profile, job, optionsFor(m, fields[i]!));
    expect(answer(0)).toEqual({ kind: 'choice', values: ['k@x.com'] });
    expect(answer(1)).toEqual({ kind: 'choice', values: ['India (+91)'] }); // not "British Indian Ocean…"
    expect(answer(3)).toEqual({ kind: 'text', value: '6' });
    expect(answer(4)).toEqual({ kind: 'choice', values: ['Yes'] });
    expect(answer(5)).toEqual({ kind: 'choice', values: ['English', 'Hindi'] });
    expect(fields[6]!.intent).toBe('identity.city');
    expect(answer(6)).toEqual({ kind: 'choice', values: ['Bengaluru'] }); // typeahead: text passes through
    expect(answer(7)).toEqual({ kind: 'choice', values: ['Professional'] });
  });

  it('MAX years on a free-text box types the threshold the question names, else 10', () => {
    const max = parseProfile({ ...profile, answers: { years_of_experience: 'MAX' } });
    const f = withIntent({ id: 'x', label: 'How many years of experience do you have with Go?', kind: 'text', required: true });
    expect(resolve(f, max, job)).toEqual({ kind: 'text', value: '10' });
    const f2 = withIntent({ id: 'x', label: 'Do you have 5+ years of experience with Go?', kind: 'text', required: true });
    expect(resolve(f2, max, job)).toEqual({ kind: 'text', value: '5' });
  });

  it('picks the phone country by name prefix, then by dial code', () => {
    const opts = ['British Indian Ocean Territory (+246)', 'India (+91)', 'Indiana (+0)', 'United States (+1)'];
    expect(pickPhoneCountry(opts, 'India', '+91 9416375330')).toBe('India (+91)');
    expect(pickPhoneCountry(opts, 'Bharat', '+1 555')).toBe('United States (+1)');
    expect(pickPhoneCountry(opts, 'Bharat', '555')).toBeNull();
  });

  it('fills every control type and reads the value back', () => {
    const m = modal(load(MODAL(QUESTIONS, NEXT)))!;
    const fields = extract(m).map(withIntent);
    fill(m, fields[0]!, { kind: 'choice', values: ['k@x.com'] });
    expect(currentAnswer(m, fields[0]!)).toBe('k@x.com');
    fill(m, fields[3]!, { kind: 'text', value: '6' });
    expect(currentAnswer(m, fields[3]!)).toBe('6');
    fill(m, fields[4]!, { kind: 'choice', values: ['Yes'] });
    expect(currentAnswer(m, fields[4]!)).toBe('Yes');
    fill(m, fields[5]!, { kind: 'choice', values: ['English', 'Hindi'] });
    expect(currentAnswer(m, fields[5]!)).toBe('English, Hindi');
    fill(m, fields[7]!, { kind: 'choice', values: ['Professional'] });
    expect(currentAnswer(m, fields[7]!)).toBe('Professional');
    expect(() => fill(m, fields[4]!, { kind: 'choice', values: ['Maybe'] })).toThrow(/no radio option/);
  });

  it('guess policy never leaves a required select empty', () => {
    const m = modal(load(MODAL(QUESTIONS, NEXT)))!;
    const f = extract(m).map(withIntent)[7]!;
    const bare = parseProfile({ ...profile, answers: {} });
    expect(resolve(f, bare, job, optionsFor(m, f)).kind).toBe('unknown');
    expect(guessAnswer(f, optionsFor(m, f), bare)).toEqual({ kind: 'choice', values: ['Native or bilingual'] });
  });

  it('unchecks "Follow company" on the review step', () => {
    const m = modal(load(MODAL('', SUBMIT, 100)))!;
    const box = followCompanyCheckbox(m)!;
    expect(box.checked).toBe(true);
    expect(uncheckFollowCompany(m)).toBe(true);
    expect(box.checked).toBe(false);
    expect(uncheckFollowCompany(m)).toBe(false);
  });

  it('reuses the selected résumé and only uploads when none is selected', () => {
    const selected = modal(load(MODAL(RESUME_STEP, NEXT)))!;
    expect(resumeSelected(selected)).toBe(true);
    expect(attachResume(selected, new File(['x'], 'cv.pdf'))).toBe(false);
    expect(extract(selected).find((f) => f.kind === 'file')?.intent).toBe('resume');
    const none = modal(load(MODAL(RESUME_STEP.replace(' jobs-document-upload-redesign-card__container--selected', '').replace(' checked', ''), NEXT)))!;
    expect(resumeSelected(none)).toBe(false);
    expect(attachResume(none, new File(['x'], 'cv.pdf'))).toBe(true);
  });

  it('safety reminder → its "Continue applying" button', () => {
    const doc = load(`<div role="dialog" class="artdeco-modal"><h2>Job safety reminder</h2><p>…</p><button>Continue applying</button></div>`);
    expect(safetyContinueButton(doc)!.textContent).toBe('Continue applying');
    expect(modal(doc)).toBeNull(); // the reminder is not the Easy Apply modal
  });
});

describe('linkedin adapter — dialogs after submit / on failure', () => {
  it('detects the "application sent" dialog and its dismiss control', () => {
    const doc = load(SENT);
    expect(applicationSent(doc)).toBe(true);
    expect(dismissButton(doc)!.getAttribute('aria-label')).toBe('Dismiss');
    expect(modal(doc)).toBeNull();
  });

  it('finds the Discard confirm, the daily-limit dialog and the pace warning', () => {
    expect(discardButton(load(DISCARD))!.textContent).toBe('Discard');
    expect(discardButton(load(SENT))).toBeNull();
    expect(limitReached(load(LIMIT))).toBe(true);
    expect(limitReached(load(SENT))).toBe(false);
    expect(rateLimited(load(PACE))).toBe(true);
    expect(rateLimited(load(LIMIT))).toBe(false);
  });

  it('describeState is self-describing', () => {
    const s = describeState(load(LIST + PANE(EASY_BTN) + MODAL(QUESTIONS, NEXT)));
    expect(s).toContain('cards=4');
    expect(s).toContain('easyApply=true');
    expect(s).toContain('modal=true');
    expect(s).toContain('action=next');
    expect(s).toContain('whole number');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  activeForm, formKey, extract, optionsFor, isAnswered, fill, continueButton, submitButton, reviewMode, formsLoaded,
  validationErrors, isDuplicate, isApplyPage, submittedByNavigation, aiConsentStep, answerAiConsent, progress,
} from '@/ats/amazon';
import { withIntent } from '@/engine/matcher';
import { resolve } from '@/engine/resolver';
import { parseProfile } from '@/config/schema';
import type { Job } from '@/engine/types';

// fixtures/amazon-apply.html = the real /api/apply/forms question schema wrapped in the markup the
// apply app's React bundle renders (see debug/amazon-fixture.mjs). happy-dom has no layout, so
// give attached, non-[hidden] nodes a rect so shown() treats them as visible.
const html = readFileSync('fixtures/amazon-apply.html', 'utf8');
const parse = (h: string): Document => new DOMParser().parseFromString(h, 'text/html');
function visible(doc: Document): void {
  for (const el of doc.querySelectorAll('*')) {
    (el as HTMLElement).getClientRects = () => [{ width: 1, height: 1 }] as unknown as DOMRectList;
  }
  // The app's React onSubmit preventDefaults; happy-dom can't navigate a parsed document anyway.
  for (const form of doc.querySelectorAll('form')) form.addEventListener('submit', (e) => e.preventDefault());
}
const load = (): Document => {
  const d = parse(html);
  visible(d);
  return d;
};

const profile = parseProfile({
  identity: { first_name: 'K', last_name: 'B', email: 'k@x.com', phone: '+1', country: 'India' },
  resume: 'resume/cv.pdf',
  amazon: { search_url: 'https://www.amazon.jobs/en/search?country[]=CAN' },
  answers: {
    years_of_experience: 6,
    skills_experience: true,
    degree_bachelors: true,
    degree_masters: false,
    gender: 'DECLINE', disability: 'DECLINE', indigenous: 'DECLINE', visible_minority: 'DECLINE', racial_identity: 'DECLINE',
    ex_military: 'DECLINE', reserve_forces: 'DECLINE', military_spouse: 'DECLINE',
  },
});
const job: Job = { id: '10459503', title: 'MLE', team: '', department: '', url: 'x', locations: ['Vancouver'], seniority: [] };

describe('amazon adapter — forms + questions', () => {
  let doc: Document;
  beforeEach(() => {
    doc = load();
  });

  it('finds the one active form and identifies it', () => {
    const form = activeForm(doc)!;
    expect(form).not.toBeNull();
    expect(formKey(form)).toContain('Job-specific questions');
    expect(formKey(form)).not.toBe(formKey(doc.querySelector('.question-form.form2')!)); // distinct per card
    expect(reviewMode(doc)).toBe(false);
  });

  it('extracts every job-specific dropdown with label, kind, required', () => {
    const fields = extract(activeForm(doc)!);
    expect(fields).toHaveLength(6);
    expect(fields.every((f) => f.kind === 'select')).toBe(true);
    expect(fields.every((f) => /-AQ$/.test(f.id))).toBe(true); // Amazon's per-job question ids
    expect(fields.filter((f) => f.required)).toHaveLength(3);
    expect(fields[0]!.label).toMatch(/^Which option best describes your total contributing/);
  });

  it('does not extract questions from read-only or hidden forms via the active form', () => {
    const ids = extract(activeForm(doc)!).map((f) => f.id);
    expect(ids).not.toContain('HOW_DID_YOU_HEAR_ABOUT_THIS_ROLE');
    expect(ids).not.toContain('DIVERSITY_GENDER_CAN');
  });

  it('answers every job-specific question from the profile (years ladder + yes/no)', () => {
    const fields = extract(activeForm(doc)!).map(withIntent);
    const answers = fields.map((f) => resolve(f, profile, job, optionsFor(doc, f)));
    expect(answers.map((a) => (a.kind === 'choice' ? a.values[0] : a.kind))).toEqual([
      'more than 5 years', // total architecture/design experience
      'Yes', // ML/LLM fundamentals
      'Yes', // ML / data mining
      'more than 5 years', // full SDLC
      'No', // Master's degree
      'Yes', // deploying LLMs on GPUs
    ]);
  });

  it('fills a select2-backed dropdown by option text and fires change', () => {
    const [f] = extract(activeForm(doc)!);
    expect(isAnswered(doc, f!)).toBe(false);
    let changed = 0;
    doc.addEventListener('change', () => changed++);
    fill(doc, f!, { kind: 'choice', values: ['more than 5 years'] });
    const select = doc.querySelector<HTMLSelectElement>(`[data-questionid="${f!.id}"] select`)!;
    expect(select.value).toBe('5'); // Amazon's option KEY, not the title
    expect(changed).toBe(1);
    expect(isAnswered(doc, f!)).toBe(true);
  });

  it('refuses an option the dropdown does not offer', () => {
    const [f] = extract(activeForm(doc)!);
    expect(() => fill(doc, f!, { kind: 'choice', values: ['forty years'] })).toThrow(/no option "forty years"/);
  });

  it('finds the Continue button and never the Skip one', () => {
    const btn = continueButton(activeForm(doc)!)!;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe('Continue');
    expect(activeForm(doc)!.textContent).toContain('Skip & continue'); // the fixture offers a Skip — not picked
    expect(submitButton(doc)).toBeNull(); // not in review mode yet
  });

  it('reports the progress rail', () => {
    const p = progress(doc);
    expect(p.find((x) => x.state === 'active')?.title).toBe('Job-specific questions');
    expect(p.filter((x) => x.state === 'finished').map((x) => x.title)).toContain('General questions');
  });
});

describe('amazon adapter — self-identification radios (Canada wording)', () => {
  // Un-hide the EEO + military forms to exercise radio/multiselect handling.
  const withEeo = (): Document => {
    const d = parse(html.replace(/ hidden>/g, '>').replace('question-form form4 active', 'question-form form4'));
    visible(d);
    return d;
  };

  it('maps DECLINE onto "I choose not to self-identify" for every radio question', () => {
    const doc = withEeo();
    const forms = [...doc.querySelectorAll('.question-form.form6, .question-form.form7')];
    const radios = forms.flatMap((f) => extract(f)).map(withIntent).filter((f) => f.kind === 'select' && optionsFor(doc, f).some((o) => /choose not/.test(o)));
    expect(radios.length).toBe(7); // indigenous, disability, visible minority, gender, ex-military, reserve, spouse
    for (const f of radios) {
      const a = resolve(f, profile, job, optionsFor(doc, f));
      expect(a, f.label).toEqual({ kind: 'choice', values: ['I choose not to self-identify'] });
      fill(doc, f, a);
      expect(isAnswered(doc, f)).toBe(true);
      const checked = doc.querySelector<HTMLInputElement>(`[data-questionid="${f.id}"] input:checked`)!;
      expect(checked.value).toBe('NOT_IDENTIFY');
    }
  });

  it('treats the racial-identity list as a multiselect and still declines through it', () => {
    const doc = withEeo();
    const f = extract(doc.querySelector('.question-form.form6')!).map(withIntent).find((x) => x.id === 'DIVERSITY_RACE_BACKGROUND_CAN')!;
    expect(f.kind).toBe('multiselect');
    expect(f.intent).toBe('answers.racial_identity');
    expect(optionsFor(doc, f)).toContain('Black');
    const a = resolve(f, profile, job, optionsFor(doc, f));
    expect(a).toEqual({ kind: 'choice', values: ['I choose not to self-identify'] }); // the 12th option
    fill(doc, f, a);
    const selected = [...doc.querySelectorAll<HTMLOptionElement>(`[data-questionid="${f.id}"] option`)].filter((o) => o.selected).map((o) => o.value);
    expect(selected).toEqual(['NOT_IDENTIFY']);
  });
});

describe('amazon adapter — page states', () => {
  it('a not-yet-loaded shell (reviewing flag, no rail, no questions) is NOT review mode', () => {
    // Exactly what the first live run saw: forms=1 active=0 reviewing=1 submit=0 questions=0 nav=0
    const doc = parse(`<div class="question-forms reviewing"><div class="card question-form form0"></div></div>`);
    visible(doc);
    expect(formsLoaded(doc)).toBe(false);
    expect(reviewMode(doc)).toBe(false);
    expect(activeForm(doc)).toBeNull();
  });

  it('review mode exposes the enabled Submit application button', () => {
    const doc = parse(`<ul class="form-list"><li class="form-list-item finished">General questions</li></ul><div class="question-forms reviewing"></div>
      <div class="submit-application-stickey-container"><div class="submit-application-button"><button class="btn btn-primary submit" type="submit">Submit application</button></div></div>`);
    visible(doc);
    expect(reviewMode(doc)).toBe(true);
    expect(activeForm(doc)).toBeNull();
    expect(submitButton(doc)!.textContent).toBe('Submit application');
  });

  it('a disabled submit button is not offered', () => {
    const doc = parse(`<div class="submit-application-button"><button class="btn btn-primary submit" disabled>Submit application</button></div>`);
    visible(doc);
    expect(submitButton(doc)).toBeNull();
  });

  it('collects visible validation errors', () => {
    const doc = parse(`<div class="card question-form active"><div id="q-error" class="invalid-feedback show-invalid d-block">This question is required</div><div class="invalid-feedback">hidden one</div></div>`);
    visible(doc);
    expect(validationErrors(doc)).toEqual(['This question is required']);
  });

  it('recognises the duplicate-application screen', () => {
    const doc = parse(`<main><div data-react-class="ApplicationDuplicateScreen" data-react-props="{}"></div></main>`);
    expect(isDuplicate(doc)).toBe(true);
    expect(isDuplicate(parse('<main></main>'))).toBe(false);
  });

  it('knows the apply page from the pages a successful submit lands on', () => {
    expect(isApplyPage('https://www.amazon.jobs/en-US/applicant/jobs/10459503/apply')).toBe(true);
    expect(isApplyPage('https://www.amazon.jobs/applicant/jobs/10459503/apply')).toBe(true);
    expect(submittedByNavigation('https://www.amazon.jobs/en-US/applicant/jobs/10459503/apply')).toBe(false);
    expect(submittedByNavigation('https://www.amazon.jobs/en-US/applicant/jobs/10459503/summary?result=duplicate')).toBe(false);
    expect(submittedByNavigation('https://www.amazon.jobs/en-US/applicant/jobs/10459503/summary?result=application_limit_reach')).toBe(false);
    expect(submittedByNavigation('https://www.amazon.jobs/en-US/applicant/jobs/10459503/summary')).toBe(true);
    expect(submittedByNavigation('https://www.amazon.jobs/en-US/applicant/dashboard/applications')).toBe(true);
    expect(submittedByNavigation('https://www.google.com/')).toBe(false);
  });

  it('answers the AI-preference modal: Yes, or No then confirm', () => {
    const step1 = `<div id="aiPreferenceModal" class="modal show"><form>
        <input type="radio" id="consent-yes" name="consent-choice" data-testid="consent-yes"><input type="radio" id="consent-no" name="consent-choice" data-testid="consent-no">
        <div class="modal-footer"><button type="submit" class="btn btn-primary">Continue</button></div></form></div>`;
    let doc = parse(step1);
    visible(doc);
    expect(aiConsentStep(doc)).toBe('choice');
    answerAiConsent(doc, true);
    expect(doc.querySelector<HTMLInputElement>('#consent-yes')!.checked).toBe(true);

    doc = parse(step1);
    visible(doc);
    answerAiConsent(doc, false);
    expect(doc.querySelector<HTMLInputElement>('#consent-no')!.checked).toBe(true);

    const step2 = `<div id="aiPreferenceModal" class="modal show"><form><input type="radio" id="decline-confirm" name="decline-choice"><input type="radio" id="decline-change" name="decline-choice"><div class="modal-footer"><button type="submit">Continue</button></div></form></div>`;
    doc = parse(step2);
    visible(doc);
    expect(aiConsentStep(doc)).toBe('confirm');
    answerAiConsent(doc, false);
    expect(doc.querySelector<HTMLInputElement>('#decline-confirm')!.checked).toBe(true);
    expect(aiConsentStep(parse('<div></div>'))).toBeNull();
  });
});

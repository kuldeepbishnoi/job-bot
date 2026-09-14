import { describe, it, expect } from 'vitest';
import { resolve, matchOptions, guessAnswer, salaryFor, salaryInUnit, noticeDays, pickNoticeOption } from '@/engine/resolver';
import { fitNumber, fitText } from '@/engine/fit-answer';
import { cityNames } from '@/engine/resolver';
import { parseProfile } from '@/config/schema';
import type { Field, Job } from '@/engine/types';

const base = {
  identity: { first_name: 'Kuldeep', last_name: 'Bishnoi', email: 'k@x.com', phone: '+91', country: 'India' },
  resume: 'resume/cv.pdf',
  want: { locations: ['Bangalore', 'Remote'] },
  answers: { work_authorization: true, how_did_you_hear: 'LinkedIn' },
};
const profile = parseProfile(base);

const job: Job = {
  id: '1', title: 'SDE', team: 'Backend', department: 'Engineering',
  url: 'x', locations: ['Paris'], seniority: ['Individual Contributor'],
};

const f = (p: Partial<Field>): Field => ({ id: 'x', label: 'x', kind: 'text', required: true, ...p });

describe('guessAnswer (on_unknown: guess — never stuck)', () => {
  const sel = f({ kind: 'select', label: 'Are you subject to any post-government employment restrictions?' });
  it('prefers a decline option, else No, and never a Yes', () => {
    expect(guessAnswer(sel, ['Yes', 'No', 'I choose not to self-identify'])).toEqual({ kind: 'choice', values: ['I choose not to self-identify'] });
    expect(guessAnswer(sel, ['Yes', 'No'])).toEqual({ kind: 'choice', values: ['No'] });
    expect(guessAnswer(sel, ['No, I was NEVER a government employee.', 'Yes, I am a FORMER government employee.'])).toEqual({ kind: 'choice', values: ['No, I was NEVER a government employee.'] });
    expect(guessAnswer(sel, ['Yes'])).toEqual({ kind: 'choice', values: ['Yes'] }); // the only option there is
  });
  it('picks the applicant\'s own country from a country list, and never "North Korea" for "No"', () => {
    const p = parseProfile(base); // identity.country: India
    expect(guessAnswer(sel, ['Afghanistan', 'British Indian Ocean Territory', 'India', 'North Korea'], p)).toEqual({ kind: 'choice', values: ['India'] });
    // No decline, no own country, no yes/no, and MORE than two options = a ladder or a list where
    // options[0] would assert the strongest claim ("Native or bilingual", "10+ years"). Park it.
    expect(guessAnswer(sel, ['Afghanistan', 'Albania', 'North Korea'], p)).toBeNull();
    expect(guessAnswer(sel, ['Option A', 'Option B'], p)).toEqual({ kind: 'choice', values: ['Option A'] }); // a binary has no claim to overstate
  });
  it('never stops: free text gets N/A, a checkbox gets checked, an empty select parks', () => {
    expect(guessAnswer(f({ kind: 'text' }), [])).toEqual({ kind: 'text', value: 'N/A' });
    expect(guessAnswer(f({ kind: 'checkbox' }), [])).toEqual({ kind: 'check', value: true });
    expect(guessAnswer(sel, ['', 'Select an option'])).toBeNull();
  });
});

describe('resolver', () => {
  it('maps a numeric years answer onto the range option that contains it', () => {
    const p = parseProfile({ ...base, answers: { years_of_experience: 6 } });
    const field = f({ kind: 'select', intent: 'answers.years_of_experience' });
    const ladder = ['less than 2 years', '2 years to less than 3 years', '3 years to less than 4 years', '4 years to less than 5 years', 'more than 5 years'];
    expect(resolve(field, p, job, ladder)).toEqual({ kind: 'choice', values: ['more than 5 years'] });
    expect(resolve(f({ kind: 'text', intent: 'answers.years_of_experience' }), p, job)).toEqual({ kind: 'text', value: '6' });
    expect(resolve(field, p, job, ['Yes', 'No'])).toEqual({ kind: 'choice', values: ['Yes'] }); // no threshold: "do you have experience …?" → any experience = Yes
    const fivePlus = f({ kind: 'select', intent: 'answers.years_of_experience', label: 'Do you have 5+ years of full software development life cycle experience?' });
    expect(resolve(fivePlus, p, job, ['Yes', 'No'])).toEqual({ kind: 'choice', values: ['Yes'] }); // 6 >= 5
    const tenPlus = f({ kind: 'select', intent: 'answers.years_of_experience', label: 'Do you have 10+ years of engineering experience?' });
    expect(resolve(tenPlus, p, job, ['Yes', 'No'])).toEqual({ kind: 'choice', values: ['No'] });
  });

  it('prefers an exact option over a substring hit (India, not British Indian Ocean Territory)', () => {
    const p = parseProfile({ ...base, answers: { citizenship: 'India' } });
    const field = f({ kind: 'select', intent: 'answers.citizenship' });
    expect(resolve(field, p, job, ['Bahrain', 'British Indian Ocean Territory', 'India', 'Indonesia'])).toEqual({ kind: 'choice', values: ['India'] });
    expect(matchOptions(['Paris, France', 'Bangalore, India'], ['Paris'])).toEqual(['Paris, France']); // fuzzy still works
  });

  it('matches yes/no as whole words, so "No" never means "North Korea" or "I choose not to"', () => {
    const p = parseProfile({ ...base, answers: { sanctioned_country: false, government_employee: false } });
    // Neither option says yes or no, and neither is inferable:it resolves unknown → the field parks and
    // lands in review.jsonl. It must NEVER become a country ("North Korea" contains "no").
    expect(resolve(f({ kind: 'select', intent: 'answers.sanctioned_country' }), p, job, ['Cuba', 'North Korea'])).toEqual({ kind: 'unknown' });
    expect(resolve(f({ kind: 'select', intent: 'answers.government_employee' }), p, job, ['Yes, I am a FORMER government employee.', 'No, I was NEVER a government employee.'])).toEqual({ kind: 'choice', values: ['No, I was NEVER a government employee.'] });
    expect(resolve(f({ kind: 'select', intent: 'answers.indigenous' }), parseProfile({ ...base, answers: { indigenous: false } }), job, ['Yes', 'I choose not to self-identify', 'No'])).toEqual({ kind: 'choice', values: ['No'] });
  });

  it('years_of_experience: MAX always takes the top bucket and says Yes to any N+ years', () => {
    const p = parseProfile({ ...base, answers: { years_of_experience: 'MAX' } });
    const field = f({ kind: 'select', intent: 'answers.years_of_experience' });
    expect(resolve(field, p, job, ['less than 2 years', '2 years to less than 3 years', '3 years to less than 4 years', 'more than 4 years'])).toEqual({ kind: 'choice', values: ['more than 4 years'] });
    expect(resolve(field, p, job, ['0-1 years', '1-3 years', '3-5 years', '5-8 years', '8+ years'])).toEqual({ kind: 'choice', values: ['8+ years'] });
    expect(resolve(field, p, job, ['1-2 years', '2-5 years', '5-10 years'])).toEqual({ kind: 'choice', values: ['5-10 years'] }); // no open-ended top: still the highest
    expect(resolve(f({ kind: 'select', intent: 'answers.years_of_experience', label: 'Do you have 10+ years of experience?' }), p, job, ['Yes', 'No'])).toEqual({ kind: 'choice', values: ['Yes'] });
  });

  it('maps DECLINE onto Amazon\'s "I choose not to self-identify"', () => {
    const p = parseProfile({ ...base, answers: { indigenous: 'DECLINE' } });
    const field = f({ kind: 'select', intent: 'answers.indigenous' });
    expect(resolve(field, p, job, ['Yes', 'No', 'I choose not to self-identify'])).toEqual({ kind: 'choice', values: ['I choose not to self-identify'] });
  });

  it('fills identity text', () => {
    expect(resolve(f({ intent: 'identity.first_name' }), profile, job)).toEqual({ kind: 'text', value: 'Kuldeep' });
  });

  it('maps a boolean answer onto the yes/no option', () => {
    const field = f({ kind: 'select', intent: 'answers.work_authorization' });
    expect(resolve(field, profile, job, ['Yes', 'No'])).toEqual({ kind: 'choice', values: ['Yes'] });
  });

  it('maps boolean false onto the No option', () => {
    const p = parseProfile({ ...base, answers: { needs_sponsorship: false } });
    const field = f({ kind: 'select', intent: 'answers.needs_sponsorship' });
    expect(resolve(field, p, job, ['Yes', 'No'])).toEqual({ kind: 'choice', values: ['No'] });
  });

  it('derives cities from job location + want.locations (multiselect)', () => {
    const field = f({ kind: 'multiselect', intent: 'locations' });
    const options = ['Paris, France', 'Bangalore, India', 'London, UK', 'Remote'];
    const ans = resolve(field, profile, job, options);
    expect(ans.kind).toBe('choice');
    if (ans.kind === 'choice') {
      expect(ans.values).toContain('Paris, France'); // the job's own city
      expect(ans.values).toContain('Bangalore, India'); // wanted
      expect(ans.values).toContain('Remote');
      expect(ans.values).not.toContain('London, UK');
    }
  });

  it('maps a canonical token onto the form-specific option wording', () => {
    const p = parseProfile({ ...base, answers: { gender: 'DECLINE', veteran_status: 'NOT_A_VETERAN' } });
    const gender = f({ kind: 'select', intent: 'answers.gender' });
    expect(resolve(gender, p, job, ['Male', 'Female', 'Decline to self-identify'])).toEqual({
      kind: 'choice',
      values: ['Decline to self-identify'],
    });
    const vet = f({ kind: 'select', intent: 'answers.veteran_status' });
    expect(resolve(vet, p, job, ['I am a protected veteran', 'I am not a protected veteran'])).toEqual({
      kind: 'choice',
      values: ['I am not a protected veteran'],
    });
  });

  it('parks unknown intents', () => {
    expect(resolve(f({ label: 'Expected salary?' }), profile, job).kind).toBe('unknown');
  });

  it('checks a required checkbox (submit gate); skips an optional one', () => {
    const consent = f({ kind: 'checkbox', label: 'By checking this box, I consent…', required: true });
    expect(resolve(consent, profile, job)).toEqual({ kind: 'check', value: true });
    const optional = f({ kind: 'checkbox', label: 'Subscribe to updates', required: false });
    expect(resolve(optional, profile, job)).toEqual({ kind: 'unknown' });
  });

  it('honors a boolean override targeting a checkbox', () => {
    const p = parseProfile({ ...base, overrides: { 'Subscribe to updates': false } });
    const optional = f({ kind: 'checkbox', label: 'Subscribe to updates', required: false });
    expect(resolve(optional, p, job)).toEqual({ kind: 'check', value: false });
  });

  it('matchOptions is bidirectional/contains-based', () => {
    expect(matchOptions(['Paris, France'], ['Paris'])).toEqual(['Paris, France']);
    expect(matchOptions(['Yes', 'No'], ['yes'])).toEqual(['Yes']);
  });
});

describe('derived answers (salary / notice / city / top choice)', () => {
  const p = parseProfile({
    identity: { first_name: 'K', last_name: 'B', email: 'k@x.com', phone: '+91 9', country: 'India', city: 'Bengaluru' },
    resume: 'r.pdf',
    answers: { current_salary: 2000000, current_variable_salary: 200000, expected_salary: 3000000, notice_period: 30, top_choice: false },
  });
  const job: Job = { id: '1', title: '', team: '', department: '', url: '', locations: [], seniority: [] };
  const f = (label: string, intent: Field['intent'], kind: Field['kind'] = 'text'): Field => ({ id: label, label, kind, required: true, intent });

  it('derives fixed / variable / total from one current_salary and converts to the unit the label names', () => {
    expect(salaryFor('answers.current_fixed_salary', p.answers)).toBe(2000000);
    expect(salaryFor('answers.current_variable_salary', p.answers)).toBe(200000);
    expect(salaryFor('answers.total_ctc', p.answers)).toBe(2200000);
    expect(salaryFor('answers.expected_salary', {})).toBeUndefined();
    expect(salaryInUnit(2000000, 'What is your current CTC (in LPA)?')).toBe(20);
    expect(salaryInUnit(2500000, 'Expected salary in lakhs')).toBe(25);
    expect(salaryInUnit(2400000, 'Current salary per month')).toBe(200000);
    expect(salaryInUnit(2000000, 'Total CTC - Fixed+Variable (INR_Annual)')).toBe(2000000);
    expect(resolve(f('What is your current fixed salary?', 'answers.current_fixed_salary'), p, job)).toEqual({ kind: 'text', value: '2000000' });
    expect(resolve(f('Expected CTC (LPA)', 'answers.expected_salary'), p, job)).toEqual({ kind: 'text', value: '30' });
    expect(resolve(f('Expected CTC', 'answers.expected_salary', 'select'), p, job, ['Less than 10 LPA', '10-20 LPA', '20-40 LPA', 'More than 40 LPA'])).toEqual({ kind: 'choice', values: ['20-40 LPA'] });
    expect(resolve(f('Current CTC', 'answers.current_salary', 'select'), p, job, ['5,00,000 - 10,00,000', '10,00,000 - 25,00,000', '25,00,000+'])).toEqual({ kind: 'choice', values: ['10,00,000 - 25,00,000'] });
    expect(resolve(f('Expected Salary', 'answers.expected_salary'), parseProfile({ ...p, answers: {} }), job)).toEqual({ kind: 'unknown' });
  });

  it('notice period: days on a text box, the containing (or next longer) option on a ladder, months when asked', () => {
    expect(noticeDays('Immediate')).toEqual({ min: 0, max: 0 });
    expect(noticeDays('15 days')).toEqual({ min: 15, max: 15 });
    expect(noticeDays('1 month')).toEqual({ min: 30, max: 30 });
    expect(noticeDays('More than 60 days')).toEqual({ min: 60, max: Infinity });
    expect(noticeDays('15-30 days')).toEqual({ min: 15, max: 30 });
    expect(pickNoticeOption(['Immediate', '15 days', '30 days', '60 days', '90 days'], 30)).toBe('30 days');
    expect(pickNoticeOption(['Immediate', '2 weeks', '1 month', '2 months'], 45)).toBe('2 months');
    expect(pickNoticeOption(['Immediate', 'Less than 15 days', '15-30 days', 'More than 30 days'], 30)).toBe('15-30 days');
    expect(resolve(f('What is your current notice period?', 'answers.notice_period', 'select'), p, job, ['Select an option', 'Immediate', '15 days', '30 days', '60 days'])).toEqual({ kind: 'choice', values: ['30 days'] });
    expect(resolve(f('Notice period (in months)', 'answers.notice_period'), p, job)).toEqual({ kind: 'text', value: '1' });
    expect(resolve(f('Notice period in days', 'answers.notice_period'), p, job)).toEqual({ kind: 'text', value: '30' });
    expect(resolve(f('Do you have a notice period?', 'answers.notice_period', 'select'), p, job, ['Yes', 'No'])).toEqual({ kind: 'choice', values: ['Yes'] });
    expect(resolve(f('Are you an immediate joiner?', 'answers.immediate_joiner', 'select'), p, job, ['Yes', 'No'])).toEqual({ kind: 'choice', values: ['No'] });
  });

  it('exact-years boxes use the honest figure even when the ladder answer is MAX', () => {
    const maxp = parseProfile({ ...p, answers: { years_of_experience: 'MAX', exact_years_of_experience: 4.7 } });
    const ladder = ['0-2 years', '3-5 years', '6-10 years', '10+ years'];
    expect(resolve(f('How many years of experience do you have?', 'answers.years_of_experience', 'select'), maxp, job, ladder)).toEqual({ kind: 'choice', values: ['10+ years'] });
    expect(resolve(f('Please indicate how many exact years of relevant experience you have', 'answers.exact_years_of_experience'), maxp, job)).toEqual({ kind: 'text', value: '4.7' });
    expect(resolve(f('Exact years of experience', 'answers.exact_years_of_experience', 'select'), maxp, job, ladder)).toEqual({ kind: 'choice', values: ['3-5 years'] });
    // No exact figure: fall back to a numeric years answer, never to MAX.
    const numeric = parseProfile({ ...p, answers: { years_of_experience: 6 } });
    expect(resolve(f('How many exact years?', 'answers.exact_years_of_experience'), numeric, job)).toEqual({ kind: 'text', value: '6' });
    expect(resolve(f('How many exact years?', 'answers.exact_years_of_experience'), parseProfile({ ...p, answers: { years_of_experience: 'MAX' } }), job)).toEqual({ kind: 'unknown' });
  });

  it('"are you located in <city>" is Yes only for the profile city; the top-choice box stays off', () => {
    // Bangalore and Bengaluru are the same city (see cityNames) — both answer Yes for this profile.
    expect(resolve(f('Are you currently located in Bangalore?', 'answers.in_city', 'select'), p, job, ['Yes', 'No'])).toEqual({ kind: 'choice', values: ['Yes'] });
    expect(resolve(f('Are you currently located in Bengaluru?', 'answers.in_city', 'select'), p, job, ['Yes', 'No'])).toEqual({ kind: 'choice', values: ['Yes'] });
    expect(resolve(f('Are you currently located in Hyderabad?', 'answers.in_city', 'select'), p, job, ['Yes', 'No'])).toEqual({ kind: 'choice', values: ['No'] });
    expect(resolve(f('Mark job as a top choice', 'answers.top_choice', 'checkbox'), p, job)).toEqual({ kind: 'check', value: false });
    expect(resolve({ ...f('Mark job as a top choice', 'answers.top_choice', 'checkbox'), required: false }, parseProfile({ ...p, answers: {} }), job)).toEqual({ kind: 'check', value: false });
  });

  it('guess policy: Yes to "comfortable / willing / okay" questions, optional checkboxes stay unticked', () => {
    expect(guessAnswer(f('Are you comfortable working from Bangalore office?', undefined, 'select'), ['Yes', 'No'], p)).toEqual({ kind: 'choice', values: ['Yes'] });
    expect(guessAnswer(f('Have you been convicted of a felony?', undefined, 'select'), ['Yes', 'No'], p)).toEqual({ kind: 'choice', values: ['No'] });
    expect(guessAnswer({ ...f('Mark job as a top choice', undefined, 'checkbox'), required: false }, [], p)).toEqual({ kind: 'check', value: false });
    expect(guessAnswer(f('I agree to the terms', undefined, 'checkbox'), [], p)).toEqual({ kind: 'check', value: true });
  });
});

describe('fitting an answer to the box (engine/fit-answer)', () => {
  const p = parseProfile({
    identity: { first_name: 'K', last_name: 'B', email: 'k@x.com', phone: '+91 9', country: 'India', city: 'Gurugram' },
    resume: 'r.pdf',
    answers: { expected_salary: 7000000, current_salary: 5100000, years_of_experience: 4.7, exact_years_of_experience: 4.7, cover_letter: 'Backend engineer, Go and distributed systems.' },
  });
  const f = (label: string, intent: Field['intent']): Field => ({ id: label, label, kind: 'text', required: true, intent });
  const NUM = 'Enter a whole number between 0 and 99';

  it('rescales a salary the box cannot hold instead of clamping it to the ceiling', () => {
    // The bug: Math.min(99, 7000000) told the employer the candidate expects 99.
    expect(fitNumber('7000000', f('Expected CTC', 'answers.expected_salary'), p, NUM)).toBe('70');
    expect(fitNumber('5100000', f('Current CTC', 'answers.current_salary'), p, NUM)).toBe('51');
    expect(fitNumber('7000000', f('Expected CTC', 'answers.expected_salary'), p, '')).toBe('7000000');
    // Nothing fits (a box capped at 9 cannot express 70 lakh in lakhs or thousands) → park.
    expect(fitNumber('7000000', f('Expected CTC', 'answers.expected_salary'), p, 'between 0 and 9')).toBeNull();
    // A salary with no profile answer is never invented as 0.
    expect(fitNumber('N/A', f('Current fixed salary', 'answers.current_fixed_salary'), p, NUM)).toBeNull();
  });

  it('floors years instead of rounding them up', () => {
    expect(fitNumber('4.7', f('Years of experience', 'answers.years_of_experience'), p, NUM)).toBe('4');
    expect(fitNumber('4.7', f('Exact years', 'answers.exact_years_of_experience'), p, NUM)).toBe('4');
    expect(fitNumber('N/A', f('How many years of experience in Java?', 'answers.years_of_experience'), p, NUM)).toBe('4');
    expect(fitNumber('120', f('Years of experience', 'answers.years_of_experience'), p, NUM)).toBe('99');
  });

  it('pads a too-short message from the profile\'s own words and trims a too-long one', () => {
    const padded = fitText('N/A', p, 'Minimum 20 characters');
    expect(padded.length).toBeGreaterThanOrEqual(20);
    expect(padded).toContain('K B');
    expect(padded).not.toMatch(/^N\/A/);
    expect(fitText('x'.repeat(500), p, 'Maximum 400 characters').length).toBeLessThanOrEqual(400);
  });
});

describe('yes/no against options that do not say "yes" or "no"', () => {
  const p = parseProfile({
    identity: { first_name: 'K', last_name: 'B', email: 'k@x.com', phone: '+91 9', country: 'India', city: 'Gurugram' },
    resume: 'r.pdf', answers: { skills_experience: false, commute_ok: true },
  });
  const job: Job = { id: '1', title: '', team: '', department: '', url: '', locations: [], seniority: [] };
  const f = (label: string, intent: Field['intent']): Field => ({ id: label, label, kind: 'select', required: true, intent });

  it('infers the unnamed side of a two-option question', () => {
    const opts = ['Yes, I know Kubernetes well', 'Not at this time'];
    expect(resolve(f('Do you have experience with Kubernetes?', 'answers.skills_experience'), p, job, opts)).toEqual({ kind: 'choice', values: ['Not at this time'] });
    expect(resolve(f('Are you comfortable commuting?', 'answers.commute_ok'), p, job, opts)).toEqual({ kind: 'choice', values: ['Yes, I know Kubernetes well'] });
  });

  it('parks rather than guessing when three options carry no yes/no', () => {
    expect(resolve(f('Do you have experience with Kubernetes?', 'answers.skills_experience'), p, job, ['Expert', 'Intermediate', 'Beginner'])).toEqual({ kind: 'unknown' });
    expect(resolve(f('Do you have experience with Kubernetes?', 'answers.skills_experience'), p, job, ['Expert', 'Some', 'None at all'])).toEqual({ kind: 'unknown' });
  });
});

describe('city aliases', () => {
  const p = parseProfile({
    identity: { first_name: 'K', last_name: 'B', email: 'k@x.com', phone: '+91 9', country: 'India', city: 'Bengaluru' },
    resume: 'r.pdf',
  });
  const job: Job = { id: '1', title: '', team: '', department: '', url: '', locations: [], seniority: [] };
  const f = (label: string): Field => ({ id: label, label, kind: 'select', required: true, intent: 'answers.in_city' });

  it('Bangalore IS Bengaluru — the answer must not be a false "No"', () => {
    expect(cityNames('Bengaluru')).toContain('bangalore');
    expect(cityNames('Gurugram')).toContain('gurgaon');
    expect(cityNames('Springfield')).toEqual(['springfield']);
    expect(resolve(f('Are you currently located in Bangalore?'), p, job, ['Yes', 'No'])).toEqual({ kind: 'choice', values: ['Yes'] });
    expect(resolve(f('Are you currently located in Bengaluru?'), p, job, ['Yes', 'No'])).toEqual({ kind: 'choice', values: ['Yes'] });
    expect(resolve(f('Are you currently located in Chennai?'), p, job, ['Yes', 'No'])).toEqual({ kind: 'choice', values: ['No'] });
    const gurugram = parseProfile({ ...p, identity: { ...p.identity, city: 'Gurugram' } });
    expect(resolve(f('Are you based out of Gurgaon?'), gurugram, job, ['Yes', 'No'])).toEqual({ kind: 'choice', values: ['Yes'] });
  });
});

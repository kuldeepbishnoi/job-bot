import { describe, it, expect } from 'vitest';
import { resolve, matchOptions, guessAnswer } from '@/engine/resolver';
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
    expect(guessAnswer(sel, ['Yes'])).toBeNull();
  });
  it('has no safe guess for a country picker or free text — those still park', () => {
    expect(guessAnswer(sel, ['Afghanistan', 'Albania', 'North Korea'])).toBeNull(); // "No" ≠ "North"
    expect(guessAnswer(f({ kind: 'text' }), [])).toBeNull();
    expect(guessAnswer(f({ kind: 'checkbox' }), [])).toEqual({ kind: 'check', value: true });
  });
});

describe('resolver', () => {
  it('maps a numeric years answer onto the range option that contains it', () => {
    const p = parseProfile({ ...base, answers: { years_of_experience: 6 } });
    const field = f({ kind: 'select', intent: 'answers.years_of_experience' });
    const ladder = ['less than 2 years', '2 years to less than 3 years', '3 years to less than 4 years', '4 years to less than 5 years', 'more than 5 years'];
    expect(resolve(field, p, job, ladder)).toEqual({ kind: 'choice', values: ['more than 5 years'] });
    expect(resolve(f({ kind: 'text', intent: 'answers.years_of_experience' }), p, job)).toEqual({ kind: 'text', value: '6' });
    expect(resolve(field, p, job, ['Yes', 'No'])).toEqual({ kind: 'unknown' }); // not a years ladder
  });

  it('prefers an exact option over a substring hit (India, not British Indian Ocean Territory)', () => {
    const p = parseProfile({ ...base, answers: { citizenship: 'India' } });
    const field = f({ kind: 'select', intent: 'answers.citizenship' });
    expect(resolve(field, p, job, ['Bahrain', 'British Indian Ocean Territory', 'India', 'Indonesia'])).toEqual({ kind: 'choice', values: ['India'] });
    expect(matchOptions(['Paris, France', 'Bangalore, India'], ['Paris'])).toEqual(['Paris, France']); // fuzzy still works
  });

  it('matches yes/no as whole words, so "No" never means "North Korea" or "I choose not to"', () => {
    const p = parseProfile({ ...base, answers: { sanctioned_country: false, government_employee: false } });
    expect(resolve(f({ kind: 'select', intent: 'answers.sanctioned_country' }), p, job, ['Cuba', 'North Korea'])).toEqual({ kind: 'choice', values: ['No'] }); // no real "No" option → literal fallback, never a country
    expect(resolve(f({ kind: 'select', intent: 'answers.government_employee' }), p, job, ['Yes, I am a FORMER government employee.', 'No, I was NEVER a government employee.'])).toEqual({ kind: 'choice', values: ['No, I was NEVER a government employee.'] });
    expect(resolve(f({ kind: 'select', intent: 'answers.indigenous' }), parseProfile({ ...base, answers: { indigenous: false } }), job, ['Yes', 'I choose not to self-identify', 'No'])).toEqual({ kind: 'choice', values: ['No'] });
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

import { describe, it, expect } from 'vitest';
import { resolve, matchOptions } from '@/engine/resolver';
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

describe('resolver', () => {
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

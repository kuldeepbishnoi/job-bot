import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extract } from '@/ats/greenhouse';
import { withIntent } from '@/engine/matcher';
import { resolve } from '@/engine/resolver';
import type { Profile } from '@/config/schema';
import type { Job } from '@/engine/types';

// Regression fixture captured live via mitmproxy on 2026-07-11 from the Datadog Greenhouse
// embed iframe. Fresh copy vs the older fixture — proves the extractor still matches the
// real form and locks in the cover_letter file bug fix (must NOT get the resume).
const html = readFileSync('fixtures/greenhouse-form-datadog.html', 'utf8')
  .replace(/<link\b[^>]*>/gi, '')
  .replace(/<script\b[\s\S]*?<\/script>/gi, '');
const doc = new DOMParser().parseFromString(html, 'text/html');
const fields = extract(doc).map(withIntent);
const byId = (id: string) => fields.find((f) => f.id === id);

const profile = {
  identity: {
    first_name: 'Kuldeep', last_name: 'Bishnoi', preferred_name: 'Kuldeep',
    email: 'k@example.com', phone: '+91 9', country: 'India', linkedin: '', website: '',
  },
  resume: 'resume/kuldeep.pdf',
  want: { titles_any: [], titles_none: [], locations: [], seniority: [] },
  answers: {},
  overrides: {},
  on_unknown: 'skip', auto_submit: false,
} as unknown as Profile;
const job = { id: '1', title: 't', team: '', department: '', url: '', locations: [], seniority: [] } as Job;

describe('greenhouse extract (live Datadog capture)', () => {
  it('finds all standard identity fields with the right intents/kinds', () => {
    expect(byId('first_name')?.intent).toBe('identity.first_name');
    expect(byId('last_name')?.intent).toBe('identity.last_name');
    expect(byId('preferred_name')?.intent).toBe('identity.preferred_name');
    expect(byId('email')?.intent).toBe('identity.email');
    expect(byId('phone')?.kind).toBe('tel');
    expect(byId('country')?.kind).toBe('select');
    expect(byId('resume')?.kind).toBe('file');
    expect(byId('resume')?.intent).toBe('resume');
  });

  it('extracts cover_letter as a file field with NO intent (so it gets skipped, not filled)', () => {
    const cl = byId('cover_letter');
    expect(cl?.kind).toBe('file');
    expect(cl?.intent).toBeUndefined();
    // The critical bug: resolver must return unknown for cover_letter, not 'file'.
    const answer = resolve(cl!, profile, job, []);
    expect(answer.kind).toBe('unknown');
  });

  it('resolves resume to file even without options', () => {
    const r = byId('resume');
    expect(resolve(r!, profile, job, []).kind).toBe('file');
  });

  it('skips the alt cover_letter_text textarea (was crashing extract on live forms)', () => {
    expect(byId('cover_letter_text')).toBeUndefined();
    expect(byId('resume_text')).toBeUndefined();
  });

  it('picks up the EEO react-selects as non-required selects', () => {
    expect(byId('gender')?.kind).toBe('select');
    expect(byId('gender')?.required).toBe(false);
    expect(byId('veteran_status')?.kind).toBe('select');
    expect(byId('disability_status')?.kind).toBe('select');
  });

  it('finds custom questions with question_XXXXX ids', () => {
    // LinkedIn Profile is a text question in Datadog's form.
    expect(byId('question_67702888')?.intent).toBe('identity.linkedin');
  });
});

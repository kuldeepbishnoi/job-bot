import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extract, fill } from '@/ats/greenhouse';
import { withIntent } from '@/engine/matcher';

// Drop external <link>/<script> so happy-dom doesn't try to fetch them; we only need the form DOM.
const html = readFileSync('fixtures/greenhouse-form.html', 'utf8')
  .replace(/<link\b[^>]*>/gi, '')
  .replace(/<script\b[\s\S]*?<\/script>/gi, '');
const doc = new DOMParser().parseFromString(html, 'text/html');
const fields = extract(doc).map(withIntent);
const byId = (id: string) => fields.find((f) => f.id === id);

describe('greenhouse extract (real form fixture)', () => {
  it('finds the standard identity fields', () => {
    expect(byId('first_name')?.intent).toBe('identity.first_name');
    expect(byId('email')?.intent).toBe('identity.email');
    expect(byId('phone')?.kind).toBe('tel');
    expect(byId('resume')?.kind).toBe('file');
  });

  it('detects the cities question as a multiselect and tags it locations', () => {
    const cities = byId('question_67885030[]');
    expect(cities?.kind).toBe('multiselect');
    expect(cities?.intent).toBe('locations');
    expect(cities?.required).toBe(true);
  });

  it('maps custom questions to intents by text', () => {
    expect(byId('question_67885025')?.intent).toBe('identity.linkedin');
    expect(byId('question_67885029')?.intent).toBe('answers.work_authorization');
    expect(byId('question_67885032')?.intent).toBe('answers.how_did_you_hear');
  });

  it('can locate a "[]" multi-select element to fill it (regression: bracketed ids)', async () => {
    const text = byId('question_67885025')!; // LinkedIn text field
    await fill(doc, text, { kind: 'text', value: 'https://linkedin.com/in/x' });
    expect((doc.getElementById('question_67885025') as HTMLInputElement).value).toBe('https://linkedin.com/in/x');
    // The cities field id literally contains "[]"; getElementById must still find it.
    expect(doc.getElementById('question_67885030[]')).not.toBeNull();
  });
});

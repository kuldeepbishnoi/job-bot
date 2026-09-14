import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extract, fill, validationErrors } from '@/ats/greenhouse';
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

  it('detects a single react-select (closest .select__control works on the real DOM)', () => {
    expect(byId('question_67885027')?.kind).toBe('select'); // "I certify…" dropdown
    expect(byId('country')?.kind).toBe('select');
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

// #regression (2026-09-15): Datadog failed 41 times across three days with zero successes and no
// record ever explained why — the submit was rejected and we reported only "no OTP prompt or
// confirmation". Greenhouse marks a rejected field with aria-invalid="true" and names the message
// element in aria-errormessage (verified in both real captures); nothing read it until now.
describe('greenhouse validation errors (why a submit went nowhere)', () => {
  const form = (inner: string) => new DOMParser().parseFromString(`<form id="application-form">${inner}</form>`, 'text/html');

  it('reads a rejected field as "<label>: <message>"', () => {
    const doc = form(`
      <label for="email">Email</label>
      <input id="email" aria-invalid="true" aria-errormessage="email-error">
      <div id="email-error">Please enter a valid email address</div>`);
    expect(validationErrors(doc)).toEqual(['Email: Please enter a valid email address']);
  });

  it('is empty on a clean form — aria-invalid="false" is the normal state, not an error', () => {
    const doc = form(`<label for="email">Email</label><input id="email" aria-invalid="false" aria-errormessage="email-error">`);
    expect(validationErrors(doc)).toEqual([]);
  });

  it('reports several rejected fields, and a form-level alert banner too', () => {
    const doc = form(`
      <label for="first_name">First Name</label>
      <input id="first_name" aria-invalid="true" aria-errormessage="first_name-error">
      <div id="first_name-error">This field is required</div>
      <label for="question_1">In what cities are you available to work?</label>
      <input id="question_1" aria-invalid="true" aria-errormessage="question_1-error">
      <div id="question_1-error">Please make a selection</div>
      <div role="alert">Please accept the terms</div>`);
    expect(validationErrors(doc)).toEqual([
      'First Name: This field is required',
      'In what cities are you available to work?: Please make a selection',
      'Please accept the terms',
    ]);
  });

  it('still names the field when the message element is missing', () => {
    const doc = form(`<label for="phone">Phone</label><input id="phone" aria-invalid="true">`);
    expect(validationErrors(doc)).toEqual(['Phone']);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extract, fill, optionsFor, submitButton, confirmed, entryFor } from '@/ats/ashby';
import { formFieldsFromSchema, parseApplicationUrl } from '@/sources/ashby';
import { withIntent } from '@/engine/matcher';
import { resolve } from '@/engine/resolver';
import { parseProfile } from '@/config/schema';
import type { Job } from '@/engine/types';

// fixtures/ashby-form-schema.json is the REAL ApiJobPosting response for a Notion posting
// (2026-09-14). The markup below transcribes Ashby's front-end components (class names + data
// attributes lifted from their bundle, see ats/ashby.ts) — not a live capture yet.
const schema = formFieldsFromSchema(JSON.parse(readFileSync('fixtures/ashby-form-schema.json', 'utf8')));
const p = (title: string) => schema.find((f) => f.title === title)!;

const entry = (f: { path: string; title: string; entryId: string }, inner: string) =>
  `<div class="ashby-application-form-field-entry"><div data-field-path="${f.path}" data-field-entry-id="${f.entryId}">
     <div class="ashby-application-form-question-title"><label for="${f.path}">${f.title}${schema.find((s) => s.path === f.path)?.required ? '<span>*</span>' : ''}</label></div>${inner}</div></div>`;

const html = `<div class="ashby-application-form-container">
  ${entry(p('Full Name'), `<div class="ashby-application-form-input-text"><input id="_systemfield_name" type="text"></div>`)}
  ${entry(p('Email'), `<div class="ashby-application-form-input-text"><input id="_systemfield_email" type="email"></div>`)}
  ${entry(p('Phone'), `<div class="ashby-application-form-input-text"><input type="tel"></div>`)}
  ${entry(p('Location'), `<div class="ashby-application-form-input-autocomplete"><input type="text" role="combobox"></div>`)}
  ${entry(p('Resume'), `<div class="ashby-application-form-input-file"><input type="file" style="display:none"><div class="ashby-application-form-input-file-dropzone"><button type="button">Upload File</button></div></div>`)}
  ${entry(p('LinkedIn Profile'), `<div class="ashby-application-form-input-text"><input type="text"></div>`)}
  ${entry(p('What pronouns would you like our team to use when addressing you?'), `<div class="ashby-application-form-input-dropdown"><div class="ashby-application-form-input-dropdown-select"><select><option disabled hidden value="">Select...</option>${p('What pronouns would you like our team to use when addressing you?').options.map((o) => `<option value="${o}">${o}</option>`).join('')}</select></div></div>`)}
  ${entry(p('Will you now or in the future require Notion to sponsor an immigration case in order to employ you?'), `<div class="ashby-application-form-input-yesno"><div><div class="ashby-application-form-input-yesno-option"><button type="button" data-option="yes" aria-pressed="false">Yes</button></div><div class="ashby-application-form-input-yesno-option"><button type="button" data-option="no" aria-pressed="false">No</button></div></div></div>`)}
  ${entry(p('How did you hear about this opportunity? (select all that apply)'), `<fieldset class="ashby-application-form-input-checkbox-group">${p('How did you hear about this opportunity? (select all that apply)').options.map((o, i) => `<div class="ashby-application-form-input-checkbox-group-option"><div class="ashby-application-form-input-checkbox-group-option-checkbox"><input type="checkbox" id="cb-${i}"></div><div class="ashby-application-form-input-checkbox-group-option-label"><label for="cb-${i}">${o}</label></div></div>`).join('')}</fieldset>`)}
  <div class="ashby-application-form-submit-button"><button type="button"><span>Submit Application</span></button></div>
</div>`;

const doc = new DOMParser().parseFromString(html, 'text/html');
const fields = extract(doc, schema).map(withIntent);
const byPath = (path: string) => fields.find((f) => f.id === path)!;
const byTitle = (title: string) => fields.find((f) => f.id === p(title).path)!;

const profile = parseProfile({
  identity: { first_name: 'Kuldeep', last_name: 'Bishnoi', email: 'k@x.com', phone: '+91 1', country: 'India', city: 'Bangalore', linkedin: 'https://linkedin.com/in/k' },
  resume: 'resume/cv.pdf',
  answers: { needs_sponsorship: false, how_did_you_hear: 'LinkedIn', gender: 'DECLINE' },
});
const job: Job = { id: 'j', title: 'SDE', team: '', department: '', url: 'https://jobs.ashbyhq.com/notion/j/application', locations: ['San Francisco'], seniority: [] };

describe('ashby form schema (real capture)', () => {
  it('reads path / title / type / required / options out of the GraphQL response', () => {
    expect(p('Full Name')).toMatchObject({ path: '_systemfield_name', type: 'String', required: true });
    expect(p('Resume')).toMatchObject({ path: '_systemfield_resume', type: 'File' });
    expect(p('Phone').type).toBe('Phone');
    expect(p('How did you hear about this opportunity? (select all that apply)').type).toBe('MultiValueSelect');
    expect(p('How did you hear about this opportunity? (select all that apply)').options).toContain('LinkedIn');
    expect(schema.every((f) => f.entryId)).toBe(true);
  });

  it('parses the application URL', () => {
    expect(parseApplicationUrl('https://jobs.ashbyhq.com/notion/1fc309c8-da20-4ff2-84c7-8b863ece2b0a/application')).toEqual({ org: 'notion', jobId: '1fc309c8-da20-4ff2-84c7-8b863ece2b0a' });
    expect(parseApplicationUrl('https://jobs.ashbyhq.com/notion')).toBeNull();
  });
});

describe('ashby extract + fill (transcribed components, real schema)', () => {
  it('tags system fields and derives kinds from the components', () => {
    expect(byPath('_systemfield_name')).toMatchObject({ kind: 'text', required: true, intent: 'identity.full_name' });
    expect(byPath('_systemfield_email').intent).toBe('identity.email');
    expect(byPath('_systemfield_resume')).toMatchObject({ kind: 'file', intent: 'resume' });
    expect(byPath('_systemfield_location').intent).toBe('identity.city');
    expect(byTitle('Phone')).toMatchObject({ kind: 'tel', intent: 'identity.phone' });
    expect(byTitle('LinkedIn Profile').intent).toBe('identity.linkedin');
    expect(byTitle('Will you now or in the future require Notion to sponsor an immigration case in order to employ you?')).toMatchObject({ kind: 'select', intent: 'answers.needs_sponsorship' });
    expect(byTitle('How did you hear about this opportunity? (select all that apply)')).toMatchObject({ kind: 'multiselect', intent: 'answers.how_did_you_hear', required: false });
  });

  it('offers Yes/No for boolean fields and the real option labels for selects/groups', () => {
    expect(optionsFor(doc, byTitle('Will you now or in the future require Notion to sponsor an immigration case in order to employ you?'))).toEqual(['Yes', 'No']);
    expect(optionsFor(doc, byTitle('What pronouns would you like our team to use when addressing you?'))).toContain('Prefer not to say');
    expect(optionsFor(doc, byTitle('How did you hear about this opportunity? (select all that apply)'))).toContain('Glassdoor');
  });

  it('fills text, yes/no, native select and checkbox groups', async () => {
    const name = byPath('_systemfield_name');
    await fill(doc, name, resolve(name, profile, job));
    expect(entryFor(doc, '_systemfield_name')!.querySelector('input')!.value).toBe('Kuldeep Bishnoi');

    const visa = byTitle('Will you now or in the future require Notion to sponsor an immigration case in order to employ you?');
    await fill(doc, visa, resolve(visa, profile, job, optionsFor(doc, visa)));
    // happy-dom does not run React; assert the click landed on the right option via a listener.
    let pressed = '';
    for (const b of Array.from(entryFor(doc, visa.id)!.querySelectorAll<HTMLElement>('[data-option]'))) b.addEventListener('click', () => (pressed = b.dataset['option'] ?? ''));
    await fill(doc, visa, { kind: 'choice', values: ['No'] });
    expect(pressed).toBe('no');

    const pron = byTitle('What pronouns would you like our team to use when addressing you?');
    const ans = resolve(pron, profile, job, optionsFor(doc, pron)); // no answer → unknown (optional)
    expect(ans.kind).toBe('unknown');
    await fill(doc, pron, { kind: 'choice', values: ['They/Them'] });
    expect(entryFor(doc, pron.id)!.querySelector('select')!.value).toBe('They/Them');

    const heard = byTitle('How did you hear about this opportunity? (select all that apply)');
    const heardAns = resolve(heard, profile, job, optionsFor(doc, heard));
    expect(heardAns).toEqual({ kind: 'choice', values: ['LinkedIn'] });
    await fill(doc, heard, heardAns);
    const boxes = Array.from(entryFor(doc, heard.id)!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(boxes.filter((b) => b.checked).length).toBe(1);
  });

  it('finds the submit button and knows the page is not yet confirmed', () => {
    expect(submitButton(doc)?.textContent).toContain('Submit Application');
    expect(confirmed(doc)).toBe(false);
  });

  it('returns the inner <button>, not its wrapper div (#regression: a click on the wrapper never reaches React onClick)', () => {
    const btn = submitButton(doc)!;
    expect(btn.tagName).toBe('BUTTON');
  });

  it('treats a lone required checkbox as a checkbox, not a multiselect (#regression: single-consent group)', async () => {
    const html2 = `<div class="ashby-application-form-container">
      <div data-field-path="consent"><div class="ashby-application-form-question-title"><label for="consent">I consent<span>*</span></label></div>
        <fieldset class="ashby-application-form-input-checkbox-group"><div class="ashby-application-form-input-checkbox-group-option"><div class="ashby-application-form-input-checkbox-group-option-checkbox"><input type="checkbox" id="c1"></div><div class="ashby-application-form-input-checkbox-group-option-label"><label for="c1">I consent</label></div></div></fieldset>
      </div></div>`;
    const doc2 = new DOMParser().parseFromString(html2, 'text/html');
    const consentField = extract(doc2, [{ path: 'consent', entryId: 'consent', title: 'I consent', type: 'Boolean', required: true, options: [] }])[0]!;
    expect(consentField.kind).toBe('checkbox');
    await fill(doc2, consentField, { kind: 'check', value: true });
    expect(entryFor(doc2, 'consent')!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
  });
});

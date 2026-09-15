import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extract, fill, optionsFor, submitButton, submittedByNavigation, controlsNamed } from '@/ats/lever';
import { withIntent } from '@/engine/matcher';
import { resolve } from '@/engine/resolver';
import { parseProfile } from '@/config/schema';
import { parseBoardRef, postingToJob, discoverLever, boardsToWalk, DEFAULT_LEVER_BOARDS } from '@/sources/lever';
import type { Job } from '@/engine/types';

// Real capture of jobs.lever.co/nium/<id>/apply (2026-09-14).
const html = readFileSync('fixtures/lever-apply.html', 'utf8')
  .replace(/<link\b[^>]*>/gi, '')
  .replace(/<script\b[\s\S]*?<\/script>/gi, '')
  .replace(/<style\b[\s\S]*?<\/style>/gi, '');
const doc = new DOMParser().parseFromString(html, 'text/html');
const fields = extract(doc).map(withIntent);
const byId = (id: string) => fields.find((f) => f.id === id);

const profile = parseProfile({
  identity: { first_name: 'Kuldeep', last_name: 'Bishnoi', email: 'k@x.com', phone: '+91 1', country: 'India', city: 'Bangalore', linkedin: 'https://linkedin.com/in/k' },
  resume: 'resume/cv.pdf',
  answers: { needs_sponsorship: false, current_company: 'Acme', notice_period: 30, expected_salary: 9000 },
});
const job: Job = { id: 'j', title: 'SDE', team: '', department: '', url: 'https://jobs.lever.co/nium/j/apply', locations: ['Kuala Lumpur'], seniority: [] };

describe('lever extract (real apply-page fixture)', () => {
  it('finds the standard fields by name and tags their intents', () => {
    expect(byId('name')).toMatchObject({ kind: 'text', required: true, intent: 'identity.full_name' });
    expect(byId('email')).toMatchObject({ kind: 'email', intent: 'identity.email' });
    expect(byId('phone')).toMatchObject({ kind: 'tel', intent: 'identity.phone' });
    expect(byId('location')).toMatchObject({ intent: 'identity.city' });
    expect(byId('org')).toMatchObject({ intent: 'answers.current_company' });
    expect(byId('resume')).toMatchObject({ kind: 'file', intent: 'resume', required: true });
    expect(byId('urls[LinkedIn]')?.intent).toBe('identity.linkedin');
  });

  it('reads custom cards: radio groups become selects with their option labels', () => {
    const visa = fields.find((f) => /visa sponsorship/i.test(f.label))!;
    expect(visa.kind).toBe('select');
    expect(visa.required).toBe(true);
    expect(visa.intent).toBe('answers.needs_sponsorship');
    expect(optionsFor(doc, visa)).toEqual(['YES', 'NO']);
    const notice = fields.find((f) => /notice period/i.test(f.label))!;
    expect(notice.intent).toBe('answers.notice_period');
    expect(optionsFor(doc, notice)).toContain('30 Days');
  });

  it('keeps the optional marketing-consent checkbox optional (never ticked by default)', () => {
    const consent = byId('consent[marketing]')!;
    expect(consent.kind).toBe('checkbox');
    expect(consent.required).toBe(false);
    expect(resolve(consent, profile, job, []).kind).toBe('unknown');
  });

  it('fills text, radio and textarea controls', async () => {
    await fill(doc, byId('name')!, resolve(byId('name')!, profile, job));
    expect((controlsNamed(doc, 'name')[0] as HTMLInputElement).value).toBe('Kuldeep Bishnoi');
    const visa = fields.find((f) => /visa sponsorship/i.test(f.label))!;
    const ans = resolve(visa, profile, job, optionsFor(doc, visa));
    expect(ans).toEqual({ kind: 'choice', values: ['NO'] });
    await fill(doc, visa, ans);
    const radios = controlsNamed(doc, visa.id) as HTMLInputElement[];
    expect(radios.find((r) => r.value === 'NO')?.checked).toBe(true);
    const salary = fields.find((f) => /salary/i.test(f.label))!;
    expect(salary.intent).toBe('answers.expected_salary');
    await fill(doc, salary, { kind: 'text', value: '9000' });
    expect((controlsNamed(doc, salary.id)[0] as HTMLTextAreaElement).value).toBe('9000');
  });

  it('ticks the REAL checkbox, not the hidden "unchecked" sentinel Lever puts before it (#regression)', async () => {
    const consent = byId('consent[marketing]')!;
    await fill(doc, consent, { kind: 'check', value: true });
    const named = controlsNamed(doc, 'consent[marketing]');
    expect(named).toHaveLength(1); // hidden sentinel excluded
    expect((named[0] as HTMLInputElement).type).toBe('checkbox');
    expect((named[0] as HTMLInputElement).checked).toBe(true);
  });

  it('locates the submit button and recognises the thanks page', () => {
    expect(submitButton(doc)?.id).toBe('btn-submit');
    expect(submittedByNavigation('https://jobs.lever.co/nium/b74e88a1-896b-4366-a0c2-cb159d803840/thanks')).toBe(true);
    expect(submittedByNavigation('https://jobs.lever.co/nium/b74e88a1-896b-4366-a0c2-cb159d803840/apply')).toBe(false);
  });
});

describe('lever discovery (real postings fixture)', () => {
  const postings = JSON.parse(readFileSync('fixtures/lever-postings.json', 'utf8'));

  it('normalises slugs and URLs to a site token', () => {
    expect(parseBoardRef('zoox')).toBe('zoox');
    expect(parseBoardRef('https://jobs.lever.co/zoox/abc/apply')).toBe('zoox');
    expect(parseBoardRef('https://example.com/careers')).toBeNull();
    expect(parseBoardRef('')).toBeNull();
  });

  it('maps a posting into a Job with the apply URL, locations and company', () => {
    const j = postingToJob('nium', postings[0]);
    expect(j.url).toMatch(/^https:\/\/jobs\.lever\.co\/nium\/.+\/apply$/);
    expect(j.locations).toEqual(['Kuala Lumpur']);
    expect(j.company).toBe('nium');
    expect(j.department).toBe('Compliance');
  });

  it('walks defaults plus the user list, skipping a broken site without sinking the run', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes('/nium?')) return { ok: true, json: async () => postings } as Response;
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    const logs: string[] = [];
    const jobs = await discoverLever(['nium', 'typo-co'], fetchImpl, (m) => logs.push(m));
    expect(jobs.length).toBe(postings.length);
    expect(logs[0]).toMatch(/typo-co.*404/);
    await expect(discoverLever(['typo-co'], fetchImpl, () => {})).rejects.toThrow(/every Lever site failed/);
  });

  it('boardsToWalk honours include_defaults', () => {
    expect(boardsToWalk({ boards: ['https://jobs.lever.co/acme'], include_defaults: false })).toEqual(['acme']);
    expect(boardsToWalk({ boards: ['acme'], include_defaults: true })).toEqual([...DEFAULT_LEVER_BOARDS, 'acme']);
  });
});

describe('lever site refuses to run with nothing configured, rather than silently applying to the curated list', () => {
  it('discover() throws a clear, actionable error when no boards are named and include_defaults is off (#regression)', async () => {
    const { lever: leverSite } = await import('@/sites/lever');
    const p = parseProfile({ identity: { first_name: 'K', last_name: 'B', email: 'k@x.com', phone: '1', country: 'India' }, resume: 'r.pdf' });
    expect(p.lever).toEqual({ boards: [], include_defaults: false }); // this pack applies — never a silent fan-out
    await expect(leverSite.discover(p)).rejects.toThrow(/no boards configured.*profile\.lever\.boards.*include_defaults/);
  });
});

// Real capture of jobs.lever.co/anchorage/09b2b0d1-fb52-431c-b617-2fb74b595b1d/apply (2026-09-15),
// the page the owner reported as "not filling". Its two custom cards are the whole point: the
// generated Nium fixture has no question that opens by describing a "remote/hybrid work culture",
// and no "permanent resident of <country>", so neither failure could have shown up there.
const anchorageDoc = new DOMParser().parseFromString(
  readFileSync('fixtures/lever-apply-anchorage.html', 'utf8')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ''),
  'text/html',
);

describe('lever: the Anchorage apply page answers every required question', () => {
  const anchorageProfile = parseProfile({
    identity: { first_name: 'Kuldeep', last_name: 'Bishnoi', email: 'k@x.com', phone: '+91 1', country: 'India', city: 'Gurugram', linkedin: 'https://linkedin.com/in/k' },
    resume: 'resume/cv.pdf',
    answers: { current_company: 'Blinkit', commute_ok: true, citizenship: 'India', permanent_resident_elsewhere: false },
  });
  const sgJob: Job = { id: 'a', title: 'APAC Regional Lead', team: '', department: '', url: 'https://jobs.lever.co/anchorage/a/apply', locations: ['Singapore'], seniority: [] };
  const anchorageFields = extract(anchorageDoc).map(withIntent);
  const answerFor = (re: RegExp) => {
    const f = anchorageFields.find((x) => re.test(x.label))!;
    return { field: f, answer: resolve(f, anchorageProfile, sgJob, optionsFor(anchorageDoc, f)) };
  };

  it('says yes to onboarding in person, from the profile rather than from the option list', () => {
    // The label opens "…has a remote/hybrid work culture…", which the commute_ok rule's not:['remote']
    // guard used to veto. With no intent it reached guessAnswer, which picks the first option
    // containing the word "no" — "No, I am not willing to onboard in-person", auto-submitted.
    const { field, answer } = answerFor(/onboard in-person/i);
    expect(field.required).toBe(true);
    expect(field.intent).toBe('answers.commute_ok');
    expect(answer).toEqual({ kind: 'choice', values: ['Yes, I am able to onboard in-person'] });
  });

  it('answers a permanent-residency question about a country that is not the applicant\'s', () => {
    const { answer } = answerFor(/permanent resident of Singapore/i);
    expect(answer).toEqual({ kind: 'choice', values: ['NO'] });
  });

  it('leaves the same question unanswered when it names the country the applicant lives in', () => {
    // "Are you a permanent resident of India?" is not what permanent_resident_elsewhere records,
    // and a flat No would deny the residency he actually holds.
    const f = { id: 'q', label: 'Are you a permanent resident of India?', kind: 'select' as const, required: false, intent: 'answers.permanent_resident_elsewhere' as const };
    expect(resolve(f, anchorageProfile, sgJob, ['Yes', 'No'])).toEqual({ kind: 'unknown' });
  });

  it('leaves nothing required unanswered', () => {
    const unanswered = anchorageFields
      .filter((f) => f.required)
      .filter((f) => resolve(f, anchorageProfile, sgJob, optionsFor(anchorageDoc, f)).kind === 'unknown')
      .map((f) => f.label);
    expect(unanswered).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import { resolve, workCountryIsHome } from '@/engine/resolver';
import { withIntent } from '@/engine/matcher';
import { parseProfile } from '@/config/schema';
import type { Field, Job } from '@/engine/types';

// "Authorized to work?" / "Need sponsorship?" describe the HOME country. The board packs list jobs
// worldwide; repeating "Yes / No" for a Paris or New York role states something false to that
// employer in the applicant's name — with auto_submit on, unreviewed.
const profile = parseProfile({
  identity: { first_name: 'K', last_name: 'B', email: 'k@x.com', phone: '+91 1', country: 'India', city: 'Gurugram' },
  resume: 'r.pdf',
  answers: { work_authorization: true, needs_sponsorship: false, citizenship: 'India' },
});
const job = (...locations: string[]): Job => ({ id: '1', title: 'SWE', team: '', department: '', url: '', locations, seniority: [] });
const q = (label: string): Field => withIntent({ id: 'q', label, kind: 'select', required: true });
const yesNo = ['Yes', 'No'];
const ans = (label: string, j: Job) => resolve(q(label), profile, j, yesNo);

describe('work authorization follows the country of the job', () => {
  it('home: the profile answer stands', () => {
    expect(ans('Are you legally authorized to work in the country where this role is located?', job('Bengaluru, Karnataka, India'))).toEqual({ kind: 'choice', values: ['Yes'] });
    expect(ans('Will you require visa sponsorship?', job('Gurgaon'))).toEqual({ kind: 'choice', values: ['No'] });
    expect(ans('Are you legally authorized to work in India?', job('Paris'))).toEqual({ kind: 'choice', values: ['Yes'] });
  });

  it('abroad: not authorized, needs sponsorship — the job location or the question names it', () => {
    expect(ans('Are you legally authorized to work in the country where this role is located?', job('Paris'))).toEqual({ kind: 'choice', values: ['No'] });
    expect(ans('Will you now or in the future require sponsorship?', job('New York, NY, United States'))).toEqual({ kind: 'choice', values: ['Yes'] });
    expect(ans('Are you authorized to work in the United States?', job())).toEqual({ kind: 'choice', values: ['No'] });
    expect(ans('Are you legally authorised to work in Canada?', job('Bengaluru'))).toEqual({ kind: 'choice', values: ['No'] });
  });

  it('cannot tell (no location, or only "Remote") → the profile answer, as before', () => {
    expect(workCountryIsHome('Are you authorized to work?', job(), profile)).toBeNull();
    expect(workCountryIsHome('Are you authorized to work?', job('Remote'), profile)).toBeNull();
    expect(workCountryIsHome('Are you authorized to work?', job('APAC (Remote)'), profile)).toBeNull();
    expect(ans('Are you legally authorized to work?', job('Remote'))).toEqual({ kind: 'choice', values: ['Yes'] });
  });

  it('"Remote - US" is a US job, and a city mixed with a home city is home', () => {
    expect(workCountryIsHome('authorized to work?', job('Remote - US'), profile)).toBe(false);
    expect(workCountryIsHome('authorized to work?', job('London', 'Hyderabad'), profile)).toBe(true);
  });

  it('answers.authorized_countries extends home', () => {
    const p2 = parseProfile({ ...profile, answers: { ...profile.answers, authorized_countries: ['Canada'] } });
    expect(workCountryIsHome('authorized to work in Canada?', job('Toronto'), p2)).toBe(true);
  });
});

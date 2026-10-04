import { describe, it, expect } from 'vitest';
import { matchIntent, withIntent } from '@/engine/matcher';
import { resolve, guessAnswer } from '@/engine/resolver';
import { parseProfile } from '@/config/schema';
import type { Job } from '@/engine/types';

// The required questions that parked or were answered wrong on 2026-10-04's board runs, verbatim.
// "N/A" typed into Preferred Name / Degree / "your motivation for Adyen" was the worst of it: with
// auto_submit on, a guess in a free-text box goes to the employer as the applicant's own words.
describe('2026-10-04 board questions map to the right intent', () => {
  const cases: [string, string | undefined][] = [
    ['Preferred Name', 'identity.preferred_name'],
    ['Preferred First Name', 'identity.preferred_name'],
    ['Degree', 'answers.education_level'],
    ['What is your motivation for Adyen and this role?', 'answers.cover_letter'],
    ['Please, provide a summary of your motivations for Adyen and this role.', 'answers.cover_letter'],
    ['Why do you believe you are a good fit for the role?', 'answers.cover_letter'],
    ['Areas and/or specific roles of interest', 'answers.roles_of_interest'],
    ['How did you first learn about Affirm as an employer?', 'answers.how_did_you_hear'],
    ['Are you subject to any employment agreements and/or post-employment restrictions with your current employer or a past employer?', 'answers.non_compete'],
    // Not "current company": a yes/no about relationships, left to the guess (No) — never "Blinkit".
    ['Do you have any close personal relationships (e.g. family members, domestic partners, friends, etc.) currently working at 1Password that might create a conflict of interest (or the perception of one)?', undefined],
    ['Current company', 'answers.current_company'],
    ['Acknowledge/Confirm', 'answers.acknowledge_true'],
    ['compensation expectation', 'answers.expected_salary'],
    ['Are you over the age of 18?', 'answers.over_18'],
    ['Are you 18 or older?', 'answers.over_18'],
    ['What aspects of the cryptocurrency industry appeal to you, and how do they align with your career goals?', 'answers.cover_letter'],
    ['What aspects of startup culture resonate with you, and how do you believe they align with your work style?', 'answers.cover_letter'],
    ['How did you hear about Alchemy?', 'answers.how_did_you_hear'],
    ['Acknowledged', 'answers.acknowledge_true'],
    ['What is your Current/Last drawn CTC(in LPA)?', 'answers.current_salary'],
    ['When could you start working?', 'answers.start_date'],
    ['What about Baseten and this role interests you?', 'answers.cover_letter'],
    ['Please tell us how you heard about this opportunity.', 'answers.how_did_you_hear'],
    ['What is it about this job that appeals to you?', 'answers.cover_letter'],
    ['Do you have a Bachelor\'s degree?', 'answers.degree_bachelors'],
  ];
  for (const [label, intent] of cases) it(label.slice(0, 60), () => expect(matchIntent(label)).toBe(intent));
});

describe('2026-10-04 answers', () => {
  const profile = parseProfile({
    identity: { first_name: 'Kuldeep', last_name: 'B', preferred_name: 'Kuldeep', email: 'k@x.com', phone: '+91 1', country: 'India', city: 'Gurugram' },
    resume: 'r.pdf',
    on_unknown: 'guess',
    answers: { expected_salary: 7000000, current_salary: 5100000, non_compete: false, education_level: "Bachelor's", how_did_you_hear: ['Company website', 'Amazon Career Site'], roles_of_interest: 'Backend engineering', cover_letter: 'I build Go services.' },
  });
  const job = (loc: string): Job => ({ id: '1', title: 'SWE', team: '', department: '', url: '', locations: [loc], seniority: [] });
  const ans = (label: string, kind: 'text' | 'select', loc: string, options: string[] = []) => resolve(withIntent({ id: 'q', label, kind, required: true }), profile, job(loc), options);

  it('free-text boxes get the profile, never a guessed "N/A"', () => {
    expect(ans('Preferred Name', 'text', 'Remote')).toEqual({ kind: 'text', value: 'Kuldeep' });
    expect(ans('Degree', 'text', 'Remote')).toEqual({ kind: 'text', value: "Bachelor's" });
    expect(ans('What is your motivation for Adyen and this role?', 'text', 'Amsterdam')).toEqual({ kind: 'text', value: 'I build Go services.' });
    expect(ans('Areas and/or specific roles of interest', 'text', 'Remote')).toEqual({ kind: 'text', value: 'Backend engineering' });
  });

  it('"how did you hear": Amazon gets its own option, a free-text box gets the generic answer', () => {
    expect(ans('How did you hear about this job?', 'select', 'Toronto', ['Advertisement', 'Amazon Career Site', 'Job Posting'])).toEqual({ kind: 'choice', values: ['Amazon Career Site'] });
    expect(ans('How did you hear about this job?', 'text', 'Remote')).toEqual({ kind: 'text', value: 'Company website' });
    expect(ans('How did you first learn about Affirm as an employer?', 'select', 'Remote', ['LinkedIn', 'Referral', 'Other'])).toEqual({ kind: 'choice', values: ['Other'] });
  });

  it('employment restrictions → the non-compete answer, not the employer name', () => {
    expect(ans('Are you subject to any employment agreements and/or post-employment restrictions with your current employer or a past employer?', 'select', 'London', ['Yes', 'No'])).toEqual({ kind: 'choice', values: ['No'] });
  });

  it('pay for a job abroad with no currency named is never typed in INR — it parks', () => {
    expect(ans('What are your salary expectations?', 'text', 'Amsterdam').kind).toBe('unknown');
    expect(guessAnswer(withIntent({ id: 'q', label: 'What are your salary expectations?', kind: 'text', required: true }), [], profile)).toBeNull();
    expect(ans('What are your salary expectations?', 'text', 'Bengaluru')).toEqual({ kind: 'text', value: '7000000' }); // home: as before
  });

  it('an "Acknowledge/Confirm" box Adyen requires is ticked; an arbitration acknowledgement never is', () => {
    const p2 = parseProfile({ ...profile, answers: { ...profile.answers, acknowledge_true: true } });
    const box = (label: string) => resolve(withIntent({ id: 'c', label, kind: 'checkbox', required: false }), p2, job('Amsterdam'), []);
    expect(box('Acknowledge/Confirm')).toEqual({ kind: 'check', value: true });
    expect(box('Please acknowledge the mutual arbitration agreement').kind).toBe('unknown');
  });

  it('an unlabelled referral-source list ("Please check all that apply:") is answered as how-did-you-hear', () => {
    const opts = ['Friend', 'Recruiter/current employee', 'LinkedIn', 'AngelList', 'Other'];
    expect(resolve(withIntent({ id: 'h', label: 'Please check all that apply:', kind: 'multiselect', required: true }), profile, job('Remote'), opts)).toEqual({ kind: 'choice', values: ['Other'] });
  });

  it('LinkedIn "compensation expectation" for an India job is the profile figure, not a park', () => {
    expect(ans('compensation expectation', 'text', 'India (Remote)')).toEqual({ kind: 'text', value: '7000000' });
  });

  it('"Are you an EU citizen?" is answered from answers.citizenship — Yes only for that country', () => {
    const p2 = parseProfile({ ...profile, answers: { ...profile.answers, citizenship: 'India' } });
    const q = (label: string) => resolve(withIntent({ id: 'c', label, kind: 'select', required: true }), p2, job('Amsterdam'), ['Yes', 'No']);
    expect(q('Are you an EU citizen (a citizen of European Union Member State)?')).toEqual({ kind: 'choice', values: ['No'] });
    expect(q('Are you a citizen of India?')).toEqual({ kind: 'choice', values: ['Yes'] });
  });

  it('a REQUIRED Website with no personal site gets the GitHub profile', () => {
    const p2 = parseProfile({ ...profile, answers: { ...profile.answers, github: 'https://github.com/k' } });
    expect(resolve(withIntent({ id: 'w', label: 'Website', kind: 'text', required: true }), p2, job('Remote'), [])).toEqual({ kind: 'text', value: 'https://github.com/k' });
  });
});

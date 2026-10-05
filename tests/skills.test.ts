import { describe, it, expect } from 'vitest';
import { skillYears, hasSkill } from '@/engine/skills';
import { resolve } from '@/engine/resolver';
import { withIntent } from '@/engine/matcher';
import { parseProfile } from '@/config/schema';

// 2026-10-05: every "years WITH <X>" question was answered with the career total — 4 years of
// Microsoft Exchange, RDF, OWL, SHACL, Spring Security, React… none on the résumé. Labels verbatim.
const skills = { go: 1.5, java: 1, kafka: 1, kubernetes: 1.5, sql: 2, python: 1, javascript: 1, typescript: 0, react: 0, ci_cd: 2, 'integration tests': 1 };

describe('skillYears', () => {
  const cases: [string, number | null][] = [
    ['How many years of work experience do you have with "Go Lang"?', 1.5],
    ['How many years of work experience do you have in Python/FastAPI?', 1],
    ['How many years of work experience do you have with Microsoft Exchange?', 0],
    ['How many years of work experience do you have with RDF (Resource Description Framework)?', 0],
    ['How many years of work experience do you have with Spring Security?', 0],
    ['How many years of experience do you have with React and Next.js?', 0], // "js" is not inside "next.js"
    ['How many years of work experience do you have with Java software development?', 1], // the skill beats the generic words
    ['How many years of work experience do you have with DevOps practices and CI/CD pipelines?', 2], // CI/CD is one skill
    ['How many years of work experience do you have in JavaScript & TypeScript ?', 1], // the best of the named skills
    ['How many years of work experience do you have with SQL query development and optimization?', 2],
    ['How many years of experience do you have in the Backend Engineering? (Please be specific and clear)', null],
    ['How many years of experience do you have with distributed systems or microservices architecture', null],
    ['What is your total years of experience ?', null],
    ['Do you have 5+ years of non-internship professional software development experience?', null],
    ['How many years of professional experience with Go?', 1.5],
    ['How many years of experience do you have managing software development projects?', 0],
    ['How many years of experience do you have in handling the team Technically?', 0],
  ];
  for (const [label, want] of cases) it(label.slice(0, 70), () => expect(skillYears(label, skills)).toBe(want));
});

describe('hasSkill (yes/no)', () => {
  it('yes only when every named technology is on the résumé', () => {
    expect(hasSkill('Do you have strong hands-on experience with SQL and relational databases?', skills)).toBe(true);
    expect(hasSkill('Have you used Go concurrency features (goroutines, channels, context cancellation) in production?', skills)).toBe(true);
    expect(hasSkill('Do you have experience with React?', skills)).toBe(false);
    expect(hasSkill('Do you have practical experience managing projects involving Node.js, React.js, PHP and AWS?', skills)).toBeNull();
    expect(hasSkill('Are you willing to go onsite?', skills)).toBeNull();
    expect(hasSkill('Have you written integration tests that run against real dependencies (e.g. a real database)?', skills)).toBe(true);
  });
});

describe('through the resolver', () => {
  const p = parseProfile({ identity: { first_name: 'K', last_name: 'B', email: 'k@x.com', phone: '1', country: 'India' }, resume: 'r', answers: { years_of_experience: 4.7 }, skills });
  const job = { id: '1', title: '', team: '', department: '', url: '', locations: ['Bengaluru'], seniority: [] };
  const ans = (label: string, options: string[] = []) => resolve(withIntent({ id: 'q', label, kind: options.length ? 'select' : 'text', required: true }), p, job, options);
  it('typed and laddered answers use the skill, the total stays for generic questions', () => {
    expect(ans('How many years of work experience do you have with Microsoft Exchange?')).toEqual({ kind: 'text', value: '0' });
    expect(ans('How many years of work experience do you have with "Go Lang"?')).toEqual({ kind: 'text', value: '1.5' });
    expect(ans('What is your total years of experience ?')).toEqual({ kind: 'text', value: '4.7' });
    expect(ans('Do you have strong hands-on experience with SQL and relational databases?', ['Yes', 'No'])).toEqual({ kind: 'choice', values: ['Yes'] });
  });
});

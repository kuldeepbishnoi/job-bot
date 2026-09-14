import { describe, it, expect } from 'vitest';
import {
  claimedYears,
  conflictingNames,
  exactYears,
  isYearsQuestion,
  mergeDiskApp,
  questionGroupsFromApps,
  questionGroupsFromReview,
  questionId,
  warningView,
  warningViews,
  yearsIssue,
  yearsIssues,
  type DiskApp,
  type QuestionGroup,
  type ReviewGroupLike,
  type RichApp,
} from '@/ui/app-view';

// The review inbox's rules, as data in / data out. Every one of them is a claim the page makes to
// the user ("this question blocked 14 jobs", "that answer outruns your résumé"), so it is pinned
// here rather than eyeballed in a rendered table.

const app = (over: Partial<RichApp> = {}): RichApp => ({
  company: 'Datadog',
  jobId: '1',
  title: 'Backend Engineer',
  url: 'https://careers.datadoghq.com/1',
  date: '2026-09-01',
  at: '2026-09-01T10:00:00.000Z',
  status: 'parked',
  ...over,
});

describe('question groups', () => {
  it('turns review.jsonl groups into one row per question, most-blocking first', () => {
    const groups: ReviewGroupLike[] = [
      {
        label: 'Do you have a valid work permit?',
        intent: 'answers.work_authorization',
        kind: 'select',
        options: ['Yes', 'No'],
        sources: ['guessed'],
        jobs: [
          { at: '2026-09-01T10:00:00Z', company: 'A', jobId: '1', title: 'One', url: 'u1', status: 'parked', label: 'x', value: 'Yes', source: 'guessed' },
        ],
      },
      {
        label: 'How many years of Kubernetes?',
        options: [],
        sources: ['unanswered'],
        jobs: [
          { at: '2026-09-01T09:00:00Z', company: 'A', jobId: '2', title: 'Two', url: 'u2', status: 'parked', label: 'y', value: '' },
          { at: '2026-09-02T09:00:00Z', company: 'A', jobId: '3', title: 'Three', url: 'u3', status: 'parked', label: 'y', value: '' },
        ],
      },
    ];
    const out = questionGroupsFromReview(groups);
    expect(out.map((g) => g.label)).toEqual(['How many years of Kubernetes?', 'Do you have a valid work permit?']);
    expect(out[0]!.jobs.map((j) => j.jobId)).toEqual(['3', '2']); // newest attempt first
    expect(out[0]!.id).toBe(questionId('HOW MANY YEARS OF KUBERNETES?'));
    expect(out[1]).toMatchObject({ intent: 'answers.work_authorization', kind: 'select', options: ['Yes', 'No'], value: 'Yes' });
  });

  it('recovers the same grouping from chrome.storage records when no folder is linked', () => {
    const apps: RichApp[] = [
      app({
        jobId: '1',
        fields: [
          { id: 'q1', label: 'Do you have experience with Rust?', value: 'Yes', source: 'guessed', options: ['Yes', 'No'], kind: 'select' },
          { id: 'q2', label: 'Notice period', value: '30', source: 'profile' },
        ],
      }),
      app({
        jobId: '2',
        at: '2026-09-02T10:00:00.000Z',
        fields: [
          { id: 'q1', label: 'Do you have experience with Rust?', value: '', source: 'unanswered' },
          { id: 'q3', label: 'Salary', value: '10', error: 'Enter a whole number' },
        ],
      }),
    ];
    const out = questionGroupsFromApps(apps);
    expect(out.map((g) => g.label)).toEqual(['Do you have experience with Rust?', 'Salary']);
    const rust = out[0]!;
    expect(rust.jobs).toHaveLength(2);
    expect(rust.sources).toEqual(['unanswered', 'guessed']); // newest record first
    expect(rust.options).toEqual(['Yes', 'No']); // options from whichever record captured them
    expect(out[1]!.jobs[0]!.error).toBe('Enter a whole number'); // a field error is a question to look at
    // answers that came straight from the profile are not questions needing a human
    expect(out.some((g) => g.label === 'Notice period')).toBe(false);
  });
});

describe('résumé consistency', () => {
  it('reads the exact figure from the profile', () => {
    expect(exactYears({ answers: { exact_years_of_experience: 6 } })).toBe(6);
    expect(exactYears({ answers: { exact_years_of_experience: '6' } })).toBe(6);
    expect(exactYears({ answers: {} })).toBeUndefined();
    expect(exactYears(null)).toBeUndefined();
  });

  it('reads the floor of whatever we answered', () => {
    expect(claimedYears('8')).toBe(8);
    expect(claimedYears('8+ years')).toBe(8);
    expect(claimedYears('5 to less than 8 years')).toBe(5);
    expect(claimedYears('6.5')).toBe(6.5);
    expect(claimedYears('MAX')).toBeNull();
  });

  it('knows which questions are about years of experience', () => {
    expect(isYearsQuestion({ label: 'How many years of experience do you have with Go?' })).toBe(true);
    expect(isYearsQuestion({ label: 'Years working with Kubernetes' })).toBe(true);
    expect(isYearsQuestion({ label: 'Anything', intent: 'answers.years_of_experience' })).toBe(true);
    expect(isYearsQuestion({ label: 'What is your notice period in days?' })).toBe(false);
  });

  it('flags an answer that outruns the résumé, and MAX whenever a real figure exists', () => {
    const q = { label: 'Years of experience with Java', intent: 'answers.years_of_experience' };
    expect(yearsIssue({ ...q, value: '10' }, 6)).toMatchObject({ kind: 'exceeds', claimed: 10, exact: 6 });
    expect(yearsIssue({ ...q, value: '7' }, 6)).toBeNull(); // one year of rounding up is honest
    expect(yearsIssue({ ...q, value: '5' }, 6)).toBeNull();
    expect(yearsIssue({ ...q, value: '8+ years' }, 6)).toMatchObject({ kind: 'exceeds', claimed: 8 });
    expect(yearsIssue({ ...q, value: 'MAX' }, 6)).toMatchObject({ kind: 'max', claimed: null, exact: 6 });
    expect(yearsIssue({ ...q, value: 'MAX' }, undefined)).toBeNull(); // nothing to compare against
    expect(yearsIssue({ label: 'Notice period (days)', value: '90' }, 6)).toBeNull();
    expect(yearsIssue({ ...q, value: '' }, 6)).toBeNull();
  });

  it('reports one issue per distinct answer in a group', () => {
    const group: QuestionGroup = {
      id: 'q:years',
      label: 'Years of experience',
      intent: 'answers.years_of_experience',
      options: [],
      sources: ['guessed'],
      jobs: [
        { jobId: '1', title: 'a', company: 'c', url: 'u', status: 'applied', at: '2026-09-01T00:00:00Z', value: '10' },
        { jobId: '2', title: 'b', company: 'c', url: 'u', status: 'applied', at: '2026-09-01T00:00:00Z', value: '10' },
        { jobId: '3', title: 'c', company: 'c', url: 'u', status: 'applied', at: '2026-09-01T00:00:00Z', value: 'MAX' },
        { jobId: '4', title: 'd', company: 'c', url: 'u', status: 'applied', at: '2026-09-01T00:00:00Z', value: '6' },
      ],
    };
    expect(yearsIssues(group, 6).map((i) => i.value)).toEqual(['10', 'MAX']);
    expect(yearsIssues(group, undefined)).toEqual([]);
  });
});

describe('joining the on-disk record', () => {
  const stored = app({ jobId: '77', at: '2026-09-01T10:00:00.000Z', fields: [{ id: 'a', label: 'A', value: '1' }] });
  const disk: DiskApp[] = [
    {
      ...app({ jobId: '77', at: '2026-09-01T10:00:00.000Z' }),
      description: 'Build things',
      resume: 'kuldeep.pdf',
      log: ['opened', 'filled'],
      files: ['captures/2026-09-01_77_parked.jpg'],
      fields: [
        { id: 'a', label: 'A', value: '1', source: 'profile' },
        { id: 'b', label: 'B', value: '', source: 'unanswered' },
      ],
    },
    { ...app({ jobId: '77', at: '2026-09-03T10:00:00.000Z' }), description: 'A later attempt' },
  ];

  it('matches on jobId + at and takes the richer field list', () => {
    const { app: merged, matched } = mergeDiskApp(stored, disk);
    expect(matched).toBe('exact');
    expect(merged.description).toBe('Build things');
    expect(merged.resume).toBe('kuldeep.pdf');
    expect(merged.fields).toHaveLength(2);
    expect(merged.files).toEqual(['captures/2026-09-01_77_parked.jpg']);
  });

  it('falls back to the newest attempt at the same job, and says so', () => {
    const other = app({ jobId: '77', at: '2026-09-09T10:00:00.000Z' });
    const { app: merged, matched } = mergeDiskApp(other, disk);
    expect(matched).toBe('job');
    expect(merged.description).toBe('A later attempt');
  });

  it('leaves the record alone when the job is not on disk', () => {
    const { app: merged, matched } = mergeDiskApp(app({ jobId: 'nope' }), disk);
    expect(matched).toBe('none');
    expect(merged).toEqual(app({ jobId: 'nope' }));
  });

  it('keeps the transient capture, which only ever lives in memory', () => {
    const withShot = { ...stored, capture: { screenshot: 'data:image/png;base64,x' } };
    expect(mergeDiskApp(withShot, disk).app.capture?.screenshot).toBe('data:image/png;base64,x');
  });
});

describe('run warnings', () => {
  it('says what the blocker is, and that we deliberately cannot fix it for you', () => {
    const v = warningView({ code: 'conflicting-extension', detail: 'AutoApplyMax is also running on this page — disable it at chrome://extensions', at: 5 });
    expect(v).toMatchObject({ tone: 'err', blocking: true });
    expect(v.title).toMatch(/AutoApplyMax/);
    expect(v.body).toMatch(/management/); // the permission we refuse to ask for
    expect(v.action?.url).toBe('chrome://extensions/');
    expect(conflictingNames('AutoApplyMax and LinkedIn AutoApplier are also running on this page — disable them')).toBe(
      'AutoApplyMax and LinkedIn AutoApplier',
    );
    expect(conflictingNames('something we did not parse')).toBe('another auto-apply extension');
  });

  it('links the login for a signed-out session and keeps pace quiet', () => {
    expect(warningView({ code: 'not-logged-in', detail: 'signed-out page', at: 1 }).action?.url).toMatch(/linkedin\.com\/login/);
    const pace = warningView({ code: 'pace', detail: 'backing off 5 min', at: 1 });
    expect(pace).toMatchObject({ tone: 'warn', blocking: false });
    expect(pace.action).toBeUndefined();
  });

  it('keeps one per code, blockers first, newest of each', () => {
    const views = warningViews([
      { code: 'pace', detail: 'first', at: 1 },
      { code: 'conflicting-extension', detail: 'X is also running on this page', at: 2 },
      { code: 'pace', detail: 'second', at: 3 },
    ]);
    expect(views.map((v) => v.code)).toEqual(['conflicting-extension', 'pace']);
    expect(views[1]!.detail).toBe('second');
  });
});

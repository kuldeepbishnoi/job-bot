import { describe, expect, it } from 'vitest';
import type { Run } from '@/engine/records';
import type { Application } from '@/engine/types';
import { EMPTY_COUNTS } from '@/engine/records';
import {
  CAUSE_RULES,
  appFlags,
  appTime,
  appsForRun,
  causeFromText,
  facets,
  filterApps,
  keyOf,
  needsReview,
  newestFirst,
  parkedQuestion,
  parseField,
  parseFields,
  reviewCause,
  reviewGroups,
  runNdjson,
  siteIdOf,
  type RichApp,
  type RichField,
  offTargetApplications,
} from '@/ui/app-view';

// These rules decide what a human sees in the Review inbox, so they are tested against the exact
// note strings the content scripts emit (greenhouse/amazon/linkedin .content.ts, app/runner.ts).

const app = (over: Partial<RichApp> = {}): RichApp => ({
  company: 'Datadog',
  jobId: '123456',
  title: 'Senior Engineer',
  url: 'https://careers.datadoghq.com/detail/123456/',
  date: '2026-09-10',
  status: 'applied',
  ...over,
});

describe('record basics', () => {
  it('keys a record by job id and the persisted timestamp, falling back to the date', () => {
    expect(keyOf(app({ at: '2026-09-10T09:00:00.000Z' }))).toBe('123456@2026-09-10T09:00:00.000Z');
    expect(keyOf(app())).toBe('123456@2026-09-10');
  });

  it('sorts newest first using `at` when present', () => {
    const a = app({ jobId: 'a', at: '2026-09-10T09:00:00.000Z' });
    const b = app({ jobId: 'b', at: '2026-09-10T11:00:00.000Z' });
    expect(newestFirst([a, b]).map((x) => x.jobId)).toEqual(['b', 'a']);
    expect(appTime(app({ date: 'not-a-date', at: undefined }))).toBe(0);
  });

  it('derives the site from the job url, then the company', () => {
    expect(siteIdOf(app())).toBe('datadog');
    expect(siteIdOf(app({ url: 'https://www.linkedin.com/jobs/view/9' }))).toBe('linkedin');
    expect(siteIdOf(app({ url: 'https://www.instahyre.com/job/1' }))).toBe('instahyre');
    expect(siteIdOf(app({ url: 'nonsense', company: 'Acme Corp' }))).toBe('acme-corp');
    expect(siteIdOf(app({ siteId: 'explicit' }))).toBe('explicit');
  });
});

describe('provenance', () => {
  const f = (over: Partial<RichField>): RichField => ({ id: 'q1', label: 'Q', value: '', ...over });

  it('reads the LEGACY suffix encoding and strips it from the displayed answer', () => {
    expect(parseField(f({ value: 'Yes (guessed)' }))).toMatchObject({ value: 'Yes', source: 'guessed' });
    expect(parseField(f({ value: 'Yes (guessed, preflight)' }))).toMatchObject({ value: 'Yes', source: 'guessed' });
    expect(parseField(f({ value: 'x (pre-filled)' }))).toMatchObject({ value: 'x', source: 'prefilled' });
    expect(parseField(f({ value: 'Kuldeep' })).source).toBeUndefined();
  });

  it('prefers an explicit source over the suffix, and treats a blank answer as unanswered', () => {
    expect(parseField(f({ value: 'Yes (guessed)', source: 'override' })).source).toBe('override');
    expect(parseField(f({ value: 'Yes (guessed)', source: 'override' })).value).toBe('Yes (guessed)');
    expect(parseField(f({ value: '   ' })).source).toBe('unanswered');
  });

  it('carries the enriched metadata through untouched', () => {
    const parsed = parseField(
      f({ value: 'No', source: 'profile', intent: 'answers.needs_sponsorship', options: ['Yes', 'No'], kind: 'select', required: true, error: 'required' }),
    );
    expect(parsed).toMatchObject({ intent: 'answers.needs_sponsorship', kind: 'select', required: true, error: 'required' });
    expect(parsed.options).toEqual(['Yes', 'No']);
  });

  it('counts flags per application', () => {
    const a = app({
      fields: [
        { id: '1', label: 'a', value: 'Yes (guessed)' },
        { id: '2', label: 'b', value: '' },
        { id: '3', label: 'c', value: 'ok' },
      ] as RichField[],
      capture: { screenshot: 'data:image/png;base64,xx' },
    });
    expect(appFlags(a)).toEqual({ guessed: 1, unanswered: 1, errors: 0, captures: true });
    expect(appFlags(app())).toEqual({ guessed: 0, unanswered: 0, errors: 0, captures: false });
    expect(parseFields(app())).toEqual([]);
  });
});

describe('filtering', () => {
  const rows: RichApp[] = [
    app({ jobId: '1', at: '2026-09-10T09:00:00.000Z', status: 'applied', account: 'a@x.com' }),
    app({ jobId: '2', at: '2026-09-11T09:00:00.000Z', status: 'parked', note: 'No answer for required: "Visa?"', account: 'b@x.com' }),
    app({ jobId: '3', at: '2026-09-12T09:00:00.000Z', status: 'failed', url: 'https://www.linkedin.com/jobs/view/3', company: 'Stripe' }),
  ];

  it('filters by site, status, account, date range and free text', () => {
    expect(filterApps(rows, { status: 'parked' }).map((a) => a.jobId)).toEqual(['2']);
    expect(filterApps(rows, { site: 'linkedin' }).map((a) => a.jobId)).toEqual(['3']);
    expect(filterApps(rows, { account: 'a@x.com' }).map((a) => a.jobId)).toEqual(['1']);
    expect(filterApps(rows, { from: '2026-09-11' }).map((a) => a.jobId)).toEqual(['2', '3']);
    expect(filterApps(rows, { from: '2026-09-11', to: '2026-09-11' }).map((a) => a.jobId)).toEqual(['2']);
    expect(filterApps(rows, { q: 'stripe' }).map((a) => a.jobId)).toEqual(['3']);
    expect(filterApps(rows, { q: 'visa' }).map((a) => a.jobId)).toEqual(['2']); // matches the note
    expect(filterApps(rows, {}).length).toBe(3);
  });

  it('filters by flag', () => {
    const guessed = app({ jobId: '9', fields: [{ id: 'x', label: 'x', value: 'Yes (guessed)' }] as RichField[] });
    expect(filterApps([...rows, guessed], { flag: 'guessed' }).map((a) => a.jobId)).toEqual(['9']);
    expect(filterApps([...rows, guessed], { flag: 'captures' })).toEqual([]);
  });

  it('builds its own facets from the data', () => {
    expect(facets(rows)).toEqual({ sites: ['datadog', 'linkedin'], accounts: ['a@x.com', 'b@x.com'] });
  });
});

describe('review causes', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['No answer for required: "In what cities are you available to work?"', 'unknown_question'],
    ['Could not fill required "Visa status": option not found', 'unknown_question'],
    ['Filled + code entered; awaiting your submit', 'auto_submit'],
    ['Filled through Review; auto_submit is off — click "Submit application" yourself (run halted)', 'auto_submit'],
    ['dry run: filled, not submitted', 'auto_submit'],
    ['OTP not found (is Gmail open?)', 'otp'],
    ['no verification code arrived for a@x.com', 'otp'],
    ['Amazon application limit reached (limit page after submit)', 'limit'],
    ['LinkedIn paused Easy Apply (pace) — backed off, not attempted', 'limit'],
    ['captcha shown — log in by hand', 'login'],
    ['already applied', 'duplicate'],
    ['stopped by you', 'stopped'],
    ['Form 2 did not advance after Continue — review mode', 'error'],
    ['', 'other'],
  ];

  it.each(cases)('%s → %s', (note, cause) => {
    expect(causeFromText(note)).toBe(cause);
  });

  it('has unique rule ids', () => {
    expect(new Set(CAUSE_RULES.map((r) => r.id)).size).toBe(CAUSE_RULES.length);
  });

  it('puts applied-but-weak records under their own cause', () => {
    expect(reviewCause(app({ fields: [{ id: 'x', label: 'x', value: 'Yes (guessed)' }] as RichField[] }))).toBe('guessed');
    expect(reviewCause(app({ fields: [{ id: 'x', label: 'x', value: '' }] as RichField[] }))).toBe('unanswered');
    expect(reviewCause(app())).toBe('other');
    expect(needsReview(app())).toBe(false);
    expect(needsReview(app({ status: 'parked' }))).toBe(true);
  });

  it('pulls the blocking question out of a park note', () => {
    expect(parkedQuestion('No answer for required: "Visa?"')).toBe('Visa?');
    expect(parkedQuestion('nothing quoted')).toBeNull();
    expect(parkedQuestion(undefined)).toBeNull();
  });
});

describe('review grouping', () => {
  const parked = (jobId: string, note: string): RichApp => app({ jobId, status: 'parked', note, at: `2026-09-1${jobId}T09:00:00.000Z` });

  it('groups by cause, biggest first, and names a question that blocked several jobs', () => {
    const rows = [
      parked('1', 'No answer for required: "Visa?"'),
      parked('2', 'No answer for required: "Visa?"'),
      parked('3', 'OTP not found (is Gmail open?)'),
    ];
    const groups = reviewGroups(rows);
    expect(groups.map((g) => g.id)).toEqual(['unknown_question', 'otp']);
    expect(groups[0]?.items.length).toBe(2);
    expect(groups[0]?.repeatedQuestions).toEqual([{ label: 'Visa?', count: 2 }]);
    expect(groups[1]?.repeatedQuestions).toEqual([]);
  });

  it('hides dismissed keys unless asked, without dropping them from the data', () => {
    const rows = [parked('1', 'OTP not found'), parked('2', 'OTP not found')];
    const dismissed = [keyOf(rows[0] as RichApp)];
    expect(reviewGroups(rows, { dismissed })[0]?.items.length).toBe(1);
    expect(reviewGroups(rows, { dismissed, showDismissed: true })[0]?.items.length).toBe(2);
  });

  it('leaves out records that need nothing', () => {
    expect(reviewGroups([app()])).toEqual([]);
  });
});

describe('runs ↔ applications', () => {
  const run = (over: Partial<Run> = {}): Run => ({
    runId: 'datadog-abc',
    siteId: 'datadog',
    kind: 'worker',
    trigger: 'manual',
    account: 'a@x.com',
    startedAt: Date.parse('2026-09-10T09:00:00.000Z'),
    heartbeatAt: Date.parse('2026-09-10T09:30:00.000Z'),
    endedAt: Date.parse('2026-09-10T09:30:00.000Z'),
    phase: 'done',
    counts: EMPTY_COUNTS,
    autoSubmit: false,
    onUnknown: 'park',
    ...over,
  });

  it('uses runId when the records carry one', () => {
    const rows = [
      app({ jobId: '1', runId: 'datadog-abc', at: '2020-01-01T00:00:00.000Z' }), // outside the window on purpose
      app({ jobId: '2', runId: 'other', at: '2026-09-10T09:10:00.000Z' }),
    ];
    const got = appsForRun(rows, run());
    expect(got.exact).toBe(true);
    expect(got.items.map((a) => a.jobId)).toEqual(['1']);
  });

  it('falls back to the run window + site, and says the join is inexact', () => {
    const rows = [
      app({ jobId: 'in', at: '2026-09-10T09:10:00.000Z' }),
      app({ jobId: 'late', at: '2026-09-10T10:30:00.000Z' }),
      app({ jobId: 'other-site', at: '2026-09-10T09:10:00.000Z', url: 'https://www.linkedin.com/jobs/view/1' }),
      app({ jobId: 'claimed', at: '2026-09-10T09:11:00.000Z', runId: 'someone-else' }),
    ];
    const got = appsForRun(rows, run());
    expect(got.exact).toBe(false);
    expect(got.items.map((a) => a.jobId)).toEqual(['in']);
  });

  it('gives the window slack at both ends', () => {
    const just = app({ jobId: 'just-after', at: '2026-09-10T09:31:00.000Z' });
    expect(appsForRun([just], run()).items.map((a) => a.jobId)).toEqual(['just-after']);
    expect(appsForRun([just], run(), { slackMs: 0 }).items).toEqual([]);
  });

  it('exports NDJSON: one object per line, typed', () => {
    const text = runNdjson(run(), [app()], [{ ts: 1, level: 'info', origin: 'sw', scope: 'apply', msg: 'hi' }]);
    const lines = text.trim().split('\n');
    expect(lines.length).toBe(3);
    expect(lines.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual(['run', 'application', 'event']);
  });
});

describe('applications that should never have been sent', () => {
  const want = { titles_any: ['software engineer', 'sde', 'backend'], titles_none: ['manager', 'director'], locations: [], seniority: [] };
  const app = (title: string, status = 'applied'): Application =>
    ({ company: 'instahyre', jobId: title, title, url: 'u', date: '2026-09-14', status } as Application);

  it('finds the roles the profile filter would have excluded', () => {
    const out = offTargetApplications(
      [app('Software Engineer'), app('Customer Support Executive'), app('Product Manager'), app('SDE II (Backend) · Navi')],
      want,
    );
    expect(out.map((a) => a.title)).toEqual(['Customer Support Executive', 'Product Manager']);
  });

  it('reads the role from "Role · Employer", not the employer', () => {
    // "Manager" in the EMPLOYER name must not condemn a legitimate engineering role.
    expect(offTargetApplications([app('Backend Engineer · Manager Tech Pvt Ltd')], want)).toEqual([]);
  });

  it('only counts applications actually sent', () => {
    expect(offTargetApplications([app('Product Manager', 'parked'), app('Product Manager', 'failed')], want)).toEqual([]);
  });

  it('says nothing is off-target when the user set no filter', () => {
    expect(offTargetApplications([app('Product Manager')], { titles_any: [], titles_none: [], locations: [], seniority: [] })).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import { reviewInbox, causeOf, bySite, guessedCount, daysOf } from '@/platform/data/stats';
import type { Application } from '@/engine/types';

const app = (o: Partial<Application> & Pick<Application, 'jobId' | 'status'>): Application => ({
  company: 'amazon', title: 'SDE', url: 'u', date: '2026-09-02', ...o,
});

describe('review inbox', () => {
  it('folds job-specific detail out of the note to make a cause', () => {
    expect(causeOf({ status: 'parked', note: 'Could not fill required "Which cities?": no answer' })).toBe('Could not fill required "…"');
    expect(causeOf({ status: 'parked', note: 'Could not fill required "Salary": no answer' })).toBe('Could not fill required "…"');
    expect(causeOf({ status: 'failed', note: 'waitFor: timeout' })).toBe('waitFor');
    expect(causeOf({ status: 'failed', note: 'Easy Apply modal never opened — pane: no button' })).toBe('Easy Apply modal never opened');
    expect(causeOf({ status: 'failed', note: 'already applied (card badge)' })).toBe('already applied');
    expect(causeOf({ status: 'failed', note: 'job 10524143 vanished' })).toBe('job # vanished');
    expect(causeOf({ status: 'parked' })).toBe('parked (no note)');
  });

  it('groups parked + failed by cause, biggest first, items newest first; ignores applied', () => {
    const groups = reviewInbox([
      app({ jobId: '1', status: 'applied' }),
      app({ jobId: '2', status: 'parked', note: 'Could not fill required "A": x', at: '2026-09-02T10:00:00Z' }),
      app({ jobId: '3', status: 'parked', note: 'Could not fill required "B": y', at: '2026-09-02T11:00:00Z' }),
      app({ jobId: '4', status: 'failed', note: 'waitFor: timeout', at: '2026-09-02T09:00:00Z' }),
    ]);
    expect(groups.map((g) => [g.cause, g.items.map((i) => i.jobId)])).toEqual([
      ['Could not fill required "…"', ['3', '2']],
      ['waitFor', ['4']],
    ]);
  });
});

describe('per-site day counts', () => {
  it('counts outcomes per company for one day only', () => {
    const apps = [
      app({ jobId: '1', status: 'applied' }),
      app({ jobId: '2', status: 'applied', company: 'linkedin' }),
      app({ jobId: '3', status: 'parked', company: 'linkedin' }),
      app({ jobId: '4', status: 'failed', date: '2026-09-01' }),
    ];
    expect(bySite(apps, '2026-09-02')).toEqual({ amazon: { applied: 1, parked: 0, failed: 0 }, linkedin: { applied: 1, parked: 1, failed: 0 } });
    expect(bySite(apps, '2026-09-01')).toEqual({ amazon: { applied: 0, parked: 0, failed: 1 } });
    expect(daysOf(apps)).toEqual(['2026-09-02', '2026-09-01']);
  });

  it('counts guessed fields across attempts', () => {
    expect(guessedCount([
      app({ jobId: '1', status: 'applied', fields: [{ id: 'a', label: 'A', value: 'No (guessed)' }, { id: 'b', label: 'B', value: 'Yes' }] }),
      app({ jobId: '2', status: 'applied', fields: [{ id: 'c', label: 'C', value: 'Decline (guessed, preflight)' }] }),
      app({ jobId: '3', status: 'parked' }),
    ])).toBe(2);
  });
});

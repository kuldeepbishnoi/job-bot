import { describe, it, expect } from 'vitest';
import { computeStats, appliedJobIds } from '@/engine/stats';
import type { Application } from '@/engine/types';

const app = (over: Partial<Application>): Application => ({
  company: 'datadog',
  jobId: 'j',
  title: 'Engineer',
  url: 'https://x',
  date: '2026-07-11',
  status: 'applied',
  ...over,
});

describe('computeStats', () => {
  const today = '2026-07-11';
  const yesterday = '2026-07-10';
  const weekAgo = '2026-07-05'; // inclusive lower bound of the 7-day window

  it('counts applied by day, week, and all-time', () => {
    const all: Application[] = [
      app({ jobId: '1', date: today }),
      app({ jobId: '2', date: today }),
      app({ jobId: '3', date: yesterday }),
      app({ jobId: '4', date: weekAgo }), // on the boundary — counts this week
      app({ jobId: '5', date: '2026-07-01' }), // older than the window
    ];
    const s = computeStats(all, today, yesterday, weekAgo);
    expect(s.today).toBe(2);
    expect(s.yesterday).toBe(1);
    expect(s.thisWeek).toBe(4);
    expect(s.total).toBe(5);
  });

  it('separates attempts (all records) from applied, and surfaces parked + failed', () => {
    const all: Application[] = [
      app({ jobId: '1' }),
      app({ jobId: '2', status: 'parked', note: 'unknown required' }),
      app({ jobId: '3', status: 'failed', note: 'boom' }),
      app({ jobId: '4', status: 'failed' }),
    ];
    const s = computeStats(all, today, yesterday, weekAgo);
    expect(s.total).toBe(1); // only 'applied'
    expect(s.attempts).toBe(4); // every record
    expect(s.needsReview).toBe(1);
    expect(s.failed).toBe(2);
  });
});

describe('appliedJobIds', () => {
  it('collects jobIds only for applied records', () => {
    const all: Application[] = [
      app({ jobId: 'a' }),
      app({ jobId: 'b', status: 'parked' }),
      app({ jobId: 'c' }),
    ];
    expect(appliedJobIds(all)).toEqual(new Set(['a', 'c']));
  });
});

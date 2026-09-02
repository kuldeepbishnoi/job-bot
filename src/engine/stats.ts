import type { Application } from './types';

// Pure stats computation. No storage, no clock — dates are passed in.
export interface Stats {
  today: number;
  yesterday: number;
  thisWeek: number; // applied within the last 7 days (inclusive of today)
  total: number; // applied all-time
  attempts: number; // every recorded attempt: applied + parked + failed
  needsReview: number;
  failed: number;
}

// ISO yyyy-mm-dd strings sort lexicographically, so `date >= weekAgoIso` is a valid range check.
export function computeStats(
  all: readonly Application[],
  todayIso: string,
  yesterdayIso: string,
  weekAgoIso: string,
): Stats {
  const applied = all.filter((a) => a.status === 'applied');
  return {
    today: applied.filter((a) => a.date === todayIso).length,
    yesterday: applied.filter((a) => a.date === yesterdayIso).length,
    thisWeek: applied.filter((a) => a.date >= weekAgoIso).length,
    total: applied.length,
    attempts: all.length,
    needsReview: all.filter((a) => a.status === 'parked').length,
    failed: all.filter((a) => a.status === 'failed').length,
  };
}

export function appliedJobIds(all: readonly Application[]): Set<string> {
  return new Set(all.filter((a) => a.status === 'applied').map((a) => a.jobId));
}

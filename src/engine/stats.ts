import type { Application } from './types';

// Pure stats computation. No storage, no clock — dates are passed in.
export interface Stats {
  today: number;
  yesterday: number;
  total: number;
  needsReview: number;
  failed: number;
}

export function computeStats(all: readonly Application[], todayIso: string, yesterdayIso: string): Stats {
  const applied = all.filter((a) => a.status === 'applied');
  return {
    today: applied.filter((a) => a.date === todayIso).length,
    yesterday: applied.filter((a) => a.date === yesterdayIso).length,
    total: applied.length,
    needsReview: all.filter((a) => a.status === 'parked').length,
    failed: all.filter((a) => a.status === 'failed').length,
  };
}

export function appliedJobIds(all: readonly Application[]): Set<string> {
  return new Set(all.filter((a) => a.status === 'applied').map((a) => a.jobId));
}

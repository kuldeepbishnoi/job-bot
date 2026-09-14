import type { Job } from './types';
import type { Want } from '../config/schema';
import { matchOptions } from './resolver';

// Filter the full listing down to jobs the applicant actually wants.
export function selectJobs(jobs: readonly Job[], want: Want): Job[] {
  return jobs.filter((j) => {
    const title = j.title.toLowerCase();
    if (want.titles_any.length && !want.titles_any.some((t) => title.includes(t.toLowerCase()))) return false;
    if (want.titles_none.some((t) => title.includes(t.toLowerCase()))) return false;
    if (want.seniority.length && !want.seniority.some((s) => j.seniority.some((js) => js.toLowerCase().includes(s.toLowerCase())))) return false;
    if (want.locations.length) {
      const remoteOk = want.locations.some((l) => l.toLowerCase() === 'remote') && j.locations.some((l) => /remote/i.test(l));
      if (!remoteOk && matchOptions(j.locations, want.locations).length === 0) return false;
    }
    return true;
  });
}

/** Title-only slice of the same filter, for sites where the search URL already fixes location
 *  (LinkedIn): the card must contain one of titles_any (if set) and none of titles_none. */
export function titleWanted(title: string, want: Want): boolean {
  const t = title.toLowerCase();
  if (want.titles_any.length && !want.titles_any.some((x) => t.includes(x.toLowerCase()))) return false;
  return !want.titles_none.some((x) => t.includes(x.toLowerCase()));
}

/** Round-robin the queue across employers, keeping each employer's own order.
 *
 *  Multi-company packs discover board by board, alphabetically, and a capped run then takes the
 *  head of that list: with 133 Greenhouse boards and `max_per_run: 15`, all fifteen applications
 *  went to the first company in the alphabet. Fifteen applications to one employer in one day is
 *  not what "apply across 133 companies" means, and it is what a recruiter there would notice.
 *
 *  Pure and order-stable: the first N jobs now cover as many distinct employers as N allows.
 */
export function spreadAcrossEmployers(jobs: readonly Job[]): Job[] {
  const byEmployer = new Map<string, Job[]>();
  for (const j of jobs) {
    const key = j.company ?? '';
    const list = byEmployer.get(key);
    if (list) list.push(j);
    else byEmployer.set(key, [j]);
  }
  // One employer (or a single-company site, where `company` is unset): nothing to interleave.
  if (byEmployer.size <= 1) return [...jobs];

  const queues = [...byEmployer.values()];
  const out: Job[] = [];
  for (let round = 0; out.length < jobs.length; round++) {
    for (const q of queues) {
      const j = q[round];
      if (j) out.push(j);
    }
  }
  return out;
}

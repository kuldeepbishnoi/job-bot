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

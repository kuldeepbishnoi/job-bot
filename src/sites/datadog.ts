import type { Job } from '../engine/types';
import type { Profile } from '../config/schema';
import { discoverDatadogJobs } from '../sources/typesense';

// A Site = where jobs come from + which ATS fills the form.
// `discover` receives the profile because some sites (Amazon) search with user-chosen filters;
// sites that index everything (Datadog) ignore it.
export interface Site {
  readonly id: string;
  readonly label: string;
  readonly ats: 'greenhouse' | 'amazon';
  discover(profile: Profile): Promise<Job[]>;
}

export const datadog: Site = {
  id: 'datadog',
  label: 'Datadog',
  ats: 'greenhouse',
  discover: () => discoverDatadogJobs(),
};

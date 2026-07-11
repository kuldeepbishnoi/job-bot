import type { Job } from '../engine/types';
import { discoverDatadogJobs } from '../sources/typesense';

// A Site = where jobs come from + which ATS fills the form.
export interface Site {
  readonly id: string;
  readonly label: string;
  readonly ats: 'greenhouse';
  discover(): Promise<Job[]>;
}

export const datadog: Site = {
  id: 'datadog',
  label: 'Datadog',
  ats: 'greenhouse',
  discover: () => discoverDatadogJobs(),
};

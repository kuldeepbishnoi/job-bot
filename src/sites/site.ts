import type { Job } from '../engine/types';
import type { Profile } from '../config/schema';

// A Site = where jobs come from + which ATS fills the form.
export interface Site {
  readonly id: string;
  readonly label: string;
  readonly ats: 'greenhouse' | 'amazon';
  /** The profile is passed because some sites (Amazon) search with user-chosen filters;
   *  sites that index everything (Datadog) ignore it. */
  discover(profile: Profile): Promise<Job[]>;
  /** Some ATSes navigate away the instant a submit succeeds, killing the content script before
   *  it can answer. A site that does so says which landing URLs count as "submitted". */
  submittedUrl?(url: string): boolean;
}

import type { Job } from '../engine/types';
import type { Profile } from '../config/schema';

// A Site = where jobs come from + which ATS fills the form.
export interface Site {
  readonly id: string;
  readonly label: string;
  readonly ats: 'greenhouse' | 'amazon' | 'lever' | 'ashby';
  /** The profile is passed because some sites (Amazon) search with user-chosen filters;
   *  sites that index everything (Datadog) ignore it. */
  discover(profile: Profile): Promise<Job[]>;
  /** Some ATSes navigate away the instant a submit succeeds, killing the content script before
   *  it can answer. A site that does so says which landing URLs count as "submitted". */
  submittedUrl?(url: string): boolean;
  /** Account rotation (one Chrome profile, N logins): where to log the current account out and
   *  where the user logs the next one in. The bot never types credentials — it pauses. */
  readonly logoutUrl?: string;
  readonly loginUrl?: string;
  /** True when the apply URL bounced to a sign-in page — the session is gone, so every job in the
   *  queue would bounce the same way. The stepper pauses instead of failing them one by one. */
  isLoginPage?(url: string): boolean;
}

/** The note a job gets when its apply page redirected to sign-in. The stepper matches on it. */
export const NOT_LOGGED_IN = 'not logged in';

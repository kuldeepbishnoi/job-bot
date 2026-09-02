import type { Site } from './datadog';
import { discoverAmazonJobs, DEFAULT_SEARCH_URL } from '../sources/amazon-jobs';

// Amazon = amazon.jobs search API (discovery) + the in-house apply app at
// /applicant/jobs/<id>/apply (ATS 'amazon', see ats/amazon.ts). Runs in the user's real,
// logged-in Chrome tab like every other site — the session cookie is what makes apply work.
export const amazon: Site = {
  id: 'amazon',
  label: 'Amazon',
  ats: 'amazon',
  discover: (profile) => discoverAmazonJobs(profile.amazon.search_url ?? DEFAULT_SEARCH_URL),
};

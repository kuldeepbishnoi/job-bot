import type { Site } from './site';
import { discoverAmazonJobs } from '../sources/amazon-jobs';
import { submittedByNavigation } from '../ats/amazon';

// Amazon = amazon.jobs search API (discovery) + the in-house apply app at
// /applicant/jobs/<id>/apply (ATS 'amazon', see ats/amazon.ts). Runs in the user's real,
// logged-in Chrome tab like every other site — the session cookie is what makes apply work.
export const amazon: Site = {
  id: 'amazon',
  label: 'Amazon',
  ats: 'amazon',
  discover: (profile) => {
    if (!profile.amazon) throw new Error('profile.yaml needs amazon.search_url (paste your amazon.jobs search page URL)');
    return discoverAmazonJobs(profile.amazon.search_url);
  },
  submittedUrl: submittedByNavigation,
};

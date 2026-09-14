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
  // profile.amazon.search_url defaults to every open software-development role worldwide
  // (config/schema.ts#AmazonSchema) — this always has something to walk; narrow it in profile.yaml.
  discover: (profile) => discoverAmazonJobs(profile.amazon.search_url),
  submittedUrl: submittedByNavigation,
  logoutUrl: 'https://account.amazon.jobs/logout',
  loginUrl: 'https://www.amazon.jobs/applicant/login',
};

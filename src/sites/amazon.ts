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
  // Logged out, /applicant/jobs/<id>/apply redirects to passport.amazon.jobs (or the applicant
  // login page), where no apply content script runs — the job used to fail on a frame timeout and
  // the next one reopened the same login page, every ~20 s, for the whole queue.
  isLoginPage: (url) => /^https:\/\/(passport|account)\.amazon\.jobs\//i.test(url) || /amazon\.jobs\/[a-z-]*\/?applicant\/login/i.test(url),
};

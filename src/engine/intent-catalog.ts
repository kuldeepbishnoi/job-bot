// What the Profile › Answers page shows for each `answers.*` intent: a label, the value's shape,
// a group, help text — and for self-ID questions the canonical tokens the user can pick. Pure.
// Partial on purpose: a peer keeps adding intents; `intentMeta()` gives an unknown one a sane
// fallback (humanized key, shape inferred from the value already in the profile).
import { AnswerToken } from './answer-tokens';
import type { Intent } from './types';

export type AnswerShape = 'boolean' | 'text' | 'number' | 'string[]' | 'token' | 'derived';
export type IntentGroup = 'Eligibility' | 'Screening' | 'Compensation' | 'Availability' | 'Self-identification' | 'Education' | 'Consent' | 'Other';

export interface IntentMeta {
  label: string;
  shape: AnswerShape;
  group: IntentGroup;
  help?: string;
  tokens?: string[];
}

const DECLINE_ONLY = [AnswerToken.DECLINE];

export const INTENT_CATALOG: Partial<Record<Intent, IntentMeta>> = {
  // Eligibility
  'answers.work_authorization': { label: 'Authorized to work', shape: 'boolean', group: 'Eligibility', help: '"Are you legally authorized to work in <country>?"' },
  'answers.needs_sponsorship': { label: 'Needs visa sponsorship', shape: 'boolean', group: 'Eligibility', help: '"Will you now or in the future require sponsorship?"' },
  'answers.willing_to_relocate': { label: 'Willing to relocate', shape: 'boolean', group: 'Eligibility' },
  'answers.previously_applied': { label: 'Previously applied here', shape: 'boolean', group: 'Eligibility' },
  'answers.previous_employment': { label: 'Previously employed here', shape: 'boolean', group: 'Eligibility' },
  'answers.non_compete': { label: 'Under a non-compete', shape: 'boolean', group: 'Eligibility' },
  'answers.government_employee': { label: 'Government employee', shape: 'text', group: 'Eligibility', help: 'false/"never", or "former" / "current".' },
  'answers.lived_abroad': { label: 'Lived abroad 12+ months', shape: 'boolean', group: 'Eligibility' },
  'answers.countries_lived': { label: 'Countries lived in', shape: 'string[]', group: 'Eligibility', help: 'Exact country names; the follow-up to "lived abroad".' },
  'answers.sanctioned_country': { label: 'Ties to a sanctioned country', shape: 'boolean', group: 'Eligibility' },
  'answers.citizenship': { label: 'Country of citizenship', shape: 'text', group: 'Eligibility' },
  'answers.permanent_resident_elsewhere': { label: 'Permanent resident elsewhere', shape: 'boolean', group: 'Eligibility', help: '"Since obtaining citizenship, did you become a permanent resident of another country?"' },
  'answers.over_18': { label: '18 or older', shape: 'boolean', group: 'Eligibility' },
  'answers.background_check': { label: 'Consents to a background check', shape: 'boolean', group: 'Eligibility' },
  'answers.drivers_license': { label: "Holds a driver's license", shape: 'boolean', group: 'Eligibility' },
  'answers.security_clearance': { label: 'Holds a security clearance', shape: 'boolean', group: 'Eligibility' },
  'answers.commute_ok': { label: 'OK to commute', shape: 'boolean', group: 'Eligibility', help: 'LinkedIn: "comfortable commuting to this job\'s location?"' },
  'answers.remote_ok': { label: 'OK with remote / hybrid', shape: 'boolean', group: 'Eligibility' },

  // Screening
  'answers.years_of_experience': { label: 'Years of experience', shape: 'number', group: 'Screening', help: 'Picks the "N to less than M years" bucket containing it; MAX = always the top bucket.' },
  'answers.skills_experience': { label: 'Has the asked-for experience', shape: 'boolean', group: 'Screening', help: 'Answers EVERY "Do you have experience with …?" the same way. Omit to park those.' },
  'answers.relevant_experience': { label: 'Has relevant experience', shape: 'boolean', group: 'Screening' },
  'answers.languages': { label: 'Languages spoken', shape: 'string[]', group: 'Screening' },
  'answers.language_proficiency': { label: 'English proficiency', shape: 'text', group: 'Screening', help: 'Option text: Native | Professional | Conversational…' },
  'answers.how_did_you_hear': { label: 'How did you hear about us', shape: 'text', group: 'Screening', help: 'Single choice or free text; matched against the dropdown by substring.' },
  'answers.how_did_you_hear_detail': { label: 'How did you hear (detail)', shape: 'text', group: 'Screening' },
  'answers.cover_letter': { label: 'Cover letter / why us', shape: 'text', group: 'Screening', help: 'Free-text prompts get this verbatim.' },

  // Compensation
  'answers.expected_salary': { label: 'Expected salary / CTC', shape: 'number', group: 'Compensation', help: 'Numeric boxes want a number; text boxes get it as typed.' },
  'answers.current_salary': { label: 'Current salary / CTC', shape: 'number', group: 'Compensation' },

  // Availability
  'answers.notice_period': { label: 'Notice period (days)', shape: 'number', group: 'Availability' },
  'answers.start_date': { label: 'Earliest start date', shape: 'text', group: 'Availability' },

  // Education
  'answers.degree_bachelors': { label: "Has a Bachelor's degree", shape: 'boolean', group: 'Education' },
  'answers.degree_masters': { label: "Has a Master's degree", shape: 'boolean', group: 'Education' },
  'answers.education_level': { label: 'Highest education level', shape: 'text', group: 'Education' },
  'answers.school_name': { label: 'School', shape: 'text', group: 'Education', help: "Amazon's school picker is a live search — typed, first hit chosen." },
  'answers.area_of_study': { label: 'Area of study', shape: 'text', group: 'Education' },
  'answers.currently_student': { label: 'Currently a student', shape: 'boolean', group: 'Education' },
  'answers.graduation': { label: 'Graduation', shape: 'text', group: 'Education', help: 'e.g. "More than 3 years ago".' },

  // Consent
  'answers.acknowledge_true': { label: 'Answers are true', shape: 'boolean', group: 'Consent' },
  'answers.privacy_consent': { label: 'Privacy policy consent', shape: 'boolean', group: 'Consent' },

  // Self-identification — tokens map to each company's exact wording (answer-tokens.ts).
  'answers.gender': { label: 'Gender', shape: 'token', group: 'Self-identification', tokens: DECLINE_ONLY, help: 'A token, or the exact option text.' },
  'answers.hispanic_latino': { label: 'Hispanic / Latino', shape: 'token', group: 'Self-identification', tokens: DECLINE_ONLY },
  'answers.veteran_status': { label: 'Veteran status', shape: 'token', group: 'Self-identification', tokens: [AnswerToken.NOT_A_VETERAN, AnswerToken.DECLINE] },
  'answers.disability': { label: 'Disability', shape: 'token', group: 'Self-identification', tokens: [AnswerToken.NO_DISABILITY, AnswerToken.DECLINE] },
  'answers.indigenous': { label: 'Indigenous (Canada)', shape: 'token', group: 'Self-identification', tokens: DECLINE_ONLY },
  'answers.visible_minority': { label: 'Visible minority (Canada)', shape: 'token', group: 'Self-identification', tokens: DECLINE_ONLY },
  'answers.racial_identity': { label: 'Racial identity', shape: 'token', group: 'Self-identification', tokens: DECLINE_ONLY },
  'answers.ex_military': { label: 'Ex-military (Canada)', shape: 'token', group: 'Self-identification', tokens: DECLINE_ONLY },
  'answers.reserve_forces': { label: 'Reserve forces (Canada)', shape: 'token', group: 'Self-identification', tokens: DECLINE_ONLY },
  'answers.military_spouse': { label: 'Military spouse (Canada)', shape: 'token', group: 'Self-identification', tokens: DECLINE_ONLY },
};

const PREFIX = 'answers.';

/** Catalog entry, or a fallback for an intent the catalog hasn't met yet. */
export function intentMeta(intent: string, sample?: unknown): IntentMeta {
  const known = INTENT_CATALOG[intent as Intent];
  if (known) return known;
  return { label: humanize(answerKey(intent)), shape: shapeOf(sample), group: 'Other' };
}

/** Every `answers.*` intent the catalog covers, plus the keys of `extra` (e.g. the user's own
 *  `profile.answers`, so a key the catalog doesn't know still gets a row). Catalog order first. */
export function answersKeys(extra?: Readonly<Record<string, unknown>>): string[] {
  const keys = Object.keys(INTENT_CATALOG).filter((k) => k.startsWith(PREFIX));
  for (const k of Object.keys(extra ?? {})) {
    const intent = intentOf(k);
    if (!keys.includes(intent)) keys.push(intent);
  }
  return keys;
}

/** `answers.gender` → `gender` (the profile.yaml key). */
export function answerKey(intent: string): string {
  return intent.startsWith(PREFIX) ? intent.slice(PREFIX.length) : intent;
}

/** `gender` → `answers.gender`. */
export function intentOf(key: string): string {
  return key.startsWith(PREFIX) ? key : PREFIX + key;
}

function humanize(key: string): string {
  const s = key.replace(/[_.]+/g, ' ').trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : key;
}

function shapeOf(sample: unknown): AnswerShape {
  if (typeof sample === 'boolean') return 'boolean';
  if (typeof sample === 'number') return 'number';
  if (Array.isArray(sample)) return 'string[]';
  return 'text';
}

import type { Field, Intent } from './types';

// Map a raw question label -> canonical intent, by keyword rules.
// Intent-based (not exact-text) so the same rules answer Datadog, Netflix, Amazon…
// Order matters: first rule whose keywords all appear wins.

export function normalize(label: string): string {
  return label
    .toLowerCase()
    .replace(/\*/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Rule {
  readonly intent: Intent;
  readonly all?: readonly string[]; // every phrase must be present
  readonly any?: readonly string[]; // at least one must be present
  readonly not?: readonly string[]; // none may be present
  readonly word?: readonly string[]; // at least one must appear as a whole word ("city", not "capacity")
}

// Identity fields are matched by DOM id in the adapter; these rules cover custom questions.
// Specific phrasings come first; the generic "do you have experience …" catch-all is last.
const RULES: readonly Rule[] = [
  // Contact-step fields (LinkedIn Easy Apply labels them; Greenhouse tags them by DOM id).
  { intent: 'identity.phone_country', any: ['phone country code', 'country code'] },
  { intent: 'identity.phone', any: ['phone number', 'mobile number', 'mobile phone', 'phone'], not: ['country code'] },
  { intent: 'identity.email', any: ['email address', 'email'], not: ['consent', 'receive', 'agree', 'subscribe'] },
  { intent: 'identity.first_name', any: ['first name', 'given name'] },
  { intent: 'identity.last_name', any: ['last name', 'surname', 'family name'] },
  { intent: 'identity.linkedin', all: ['linkedin'] },
  { intent: 'identity.website', any: ['website', 'portfolio', 'personal site'] },
  { intent: 'answers.needs_sponsorship', any: ['sponsorship', 'require sponsorship', 'need sponsorship', 'visa sponsorship'] },
  { intent: 'answers.work_authorization', any: ['legally authorised', 'legally authorized', 'right to work', 'authorized to work', 'authorised to work', 'eligible to work'] },
  // LinkedIn Easy Apply screening questions — before the generic location / years rules.
  { intent: 'answers.commute_ok', any: ['comfortable commuting', 'commute to', 'commuting to'] },
  { intent: 'answers.remote_ok', any: ['remote setting', 'working remotely', 'hybrid setting', 'work from home', 'comfortable working remote'] },
  { intent: 'answers.expected_salary', any: ['expected salary', 'expected ctc', 'salary expectation', 'desired salary', 'expected compensation', 'expected annual', 'salary you are looking', 'expected pay'] },
  { intent: 'answers.current_salary', any: ['current salary', 'current ctc', 'current compensation', 'present ctc', 'current annual'] },
  { intent: 'answers.notice_period', any: ['notice period', 'days of notice', 'serving notice'] },
  { intent: 'answers.start_date', any: ['when can you start', 'how soon can you start', 'earliest start', 'start date', 'available to start', 'date of joining', 'join immediately'] },
  { intent: 'answers.background_check', any: ['background check', 'background verification'] },
  { intent: 'answers.over_18', any: ['18 years', 'at least 18', 'over 18', 'legal age'] },
  { intent: 'answers.language_proficiency', any: ['level of proficiency', 'proficiency in', 'proficient in english', 'english proficiency', 'level of english'] },
  { intent: 'answers.drivers_license', any: ['driver s license', 'drivers license', 'driving license', 'driving licence', 'driver s licence'] },
  { intent: 'answers.security_clearance', any: ['security clearance', 'clearance'] },
  { intent: 'identity.city', any: ['current city', 'current location', 'city you live', 'where are you located', 'where do you live', 'your city'] },
  { intent: 'identity.city', word: ['city'], not: ['which cities', 'what cities', 'cities are you', 'authorised', 'authorized'] },
  { intent: 'locations', any: ['which cities', 'what cities', 'cities are you available', 'preferred location', 'work location', 'available to work'], not: ['authorised', 'authorized'] },
  { intent: 'answers.languages', any: ['languages you speak', 'languages do you speak', 'fluent'] },
  { intent: 'answers.how_did_you_hear', all: ['how did you hear'] },
  { intent: 'answers.how_did_you_hear_detail', any: ['please specify'] },
  { intent: 'answers.education_level', any: ['education level', 'highest degree', 'level of education'], not: ['bachelor', 'master s', 'masters'] },
  { intent: 'answers.school_name', any: ['school name', 'name of institution', 'university name', 'your school'] },
  { intent: 'answers.area_of_study', any: ['area of study', 'areas of study', 'area s of study', 'field of study', 'major'] },
  { intent: 'answers.currently_student', any: ['currently a student', 'currently enrolled'] },
  { intent: 'answers.graduation', any: ['when did you graduate', 'graduation date', 'year of graduation'] },
  { intent: 'answers.relevant_experience', any: ['relevant non internship professional experience', 'relevant professional experience'] },
  { intent: 'answers.acknowledge_true', any: ['information provided in this application is true', 'certify that the information', 'true and correct', 'i acknowledge the above'] },
  { intent: 'answers.privacy_consent', any: ['candidate privacy', 'privacy policy', 'privacy notice', 'processed in accordance'] },
  { intent: 'answers.gender', all: ['gender'] },
  { intent: 'answers.hispanic_latino', any: ['hispanic', 'latino'] },
  // Canada Employment Equity Act self-ID (Amazon) — before the US veteran/disability rules.
  { intent: 'answers.indigenous', any: ['indigenous', 'aboriginal'] },
  { intent: 'answers.visible_minority', any: ['visible minority', 'person of colour', 'person of color'] },
  { intent: 'answers.racial_identity', any: ['racial or ethnic', 'race ethnicity', 'ethnicity', 'racial'] },
  { intent: 'answers.reserve_forces', any: ['reserve forces', 'reservist'] },
  { intent: 'answers.military_spouse', any: ['military spouse'] },
  // Before ex_military: Amazon's government-employee question lists "a member of the armed forces".
  { intent: 'answers.government_employee', any: ['government employee', 'employee of any government', 'employed by a government'] },
  { intent: 'answers.ex_military', any: ['ex military', 'armed forces', 'military status', 'served in the military'] },
  { intent: 'answers.veteran_status', any: ['veteran', 'protected veteran'] },
  { intent: 'answers.disability', any: ['disability', 'disabled'] },
  // Work eligibility / compliance.
  { intent: 'answers.previously_applied', any: ['previously applied'] },
  { intent: 'answers.previous_employment', any: ['previously been employed', 'previously employed', 'previously worked'] },
  { intent: 'answers.non_compete', any: ['non competition', 'non compete', 'noncompete'] },
  // The follow-up list must be matched before the yes/no it depends on.
  { intent: 'answers.countries_lived', any: ['countries outside', 'which countries have you lived', 'countries you have lived'] },
  { intent: 'answers.lived_abroad', any: ['physically located outside', 'lived outside', 'lived or were physically located'] },
  { intent: 'answers.permanent_resident_elsewhere', any: ['become a permanent resident', 'permanent resident in any other', 'permanent resident, asylee or refugee'] },
  // Only the yes/no "are you located in any sanctioned country" — not its "which one?" follow-up.
  { intent: 'answers.sanctioned_country', any: ['sanctioned countr', 'sanctioned region'], not: ['which sanctioned'] },
  // Only the country picker — not the "since obtaining your citizenship, did you…" yes/no follow-ups.
  { intent: 'answers.citizenship', any: ['do you have citizenship', 'country of citizenship', 'citizenship country'] },
  { intent: 'answers.willing_to_relocate', any: ['willing to relocate', 'open to relocat'] },
  // Free-text "why us" prompts (LinkedIn) — after the compliance rules so their "please provide
  // additional information" follow-ups (Amazon) are never answered with the cover-letter paragraph.
  { intent: 'answers.cover_letter', any: ['cover letter', 'why do you want', 'why are you interested', 'why should we', 'tell us about yourself', 'tell us why', 'describe your'] },
  // Screening questions.
  { intent: 'answers.years_of_experience', any: ['years of experience', 'best describes your total', 'how many years', 'years of professional', 'years of non internship', 'years experience', 'years of', 'year of', 'years in'] },
  { intent: 'answers.degree_bachelors', any: ['bachelor'] },
  { intent: 'answers.degree_masters', any: ['master s degree', 'masters degree', 'master degree', 'graduate degree'] },
  { intent: 'answers.skills_experience', any: ['do you have experience', 'have you experience', 'do you have knowledge', 'do you have a working knowledge', 'are you proficient', 'do you have hands on', 'have you worked with', 'do you have exposure'] },
];

function has(text: string, phrase: string): boolean {
  return text.includes(normalize(phrase));
}
function hasWord(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${normalize(phrase)} `);
}

/** Best-effort intent for a question label. undefined = unknown -> park/skip. */
export function matchIntent(label: string): Intent | undefined {
  const t = normalize(label);
  for (const r of RULES) {
    if (r.all && !r.all.every((p) => has(t, p))) continue;
    if (r.any && !r.any.some((p) => has(t, p))) continue;
    if (r.word && !r.word.some((p) => hasWord(t, p))) continue;
    if (r.not && r.not.some((p) => has(t, p))) continue;
    return r.intent;
  }
  return undefined;
}

/** Attach an intent to a field (identity ids already tagged by the adapter). */
export function withIntent(field: Field): Field {
  if (field.intent) return field;
  return { ...field, intent: matchIntent(field.label) };
}

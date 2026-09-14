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
  { intent: 'identity.phone', any: ['phone number', 'mobile number', 'mobile phone', 'phone'], not: ['country code', 'screen', 'interview', 'call you', 'call with', 'available for a phone', 'attend a phone'] },
  { intent: 'identity.email', any: ['email address', 'email'], not: ['consent', 'receive', 'agree', 'subscribe'] },
  { intent: 'identity.full_name', any: ['full name', 'full legal name'], not: ['first name', 'last name', 'company', 'employer', 'referr'] },
  { intent: 'identity.first_name', any: ['first name', 'given name'] },
  { intent: 'identity.last_name', any: ['last name', 'surname', 'family name'] },
  { intent: 'identity.linkedin', all: ['linkedin'] },
  { intent: 'identity.website', any: ['website', 'portfolio', 'personal site'] },
  // 'work visa' alone also matches "Do you currently HOLD a valid work visa?" (a status question,
  // opposite polarity from "will you NEED sponsorship") — require the requirement phrasing.
  { intent: 'answers.needs_sponsorship', any: ['sponsorship', 'require sponsorship', 'need sponsorship', 'visa sponsorship', 'to sponsor', 'immigration case', 'require a work visa', 'need a work visa'] },
  { intent: 'answers.work_authorization', any: ['legally authorised', 'legally authorized', 'right to work', 'authorized to work', 'authorised to work', 'eligible to work'] },
  // LinkedIn Easy Apply screening questions — before the generic location / years rules.
  { intent: 'answers.top_choice', any: ['top choice'] },
  { intent: 'answers.shifts_ok', any: ['night shift', 'rotational shift', 'shift timing', 'us shift', 'uk shift', 'work in shifts', 'evening shift', 'in shifts'] },
  { intent: 'answers.commute_ok', any: ['comfortable commuting', 'commute to', 'commuting to', 'work from office', 'work from the office', 'from office', 'in office', 'in the office', 'on site', 'onsite', 'wfo'], not: ['remote'] },
  { intent: 'answers.remote_ok', any: ['remote setting', 'working remotely', 'hybrid setting', 'work from home', 'comfortable working remote', 'remote work', 'remotely'] },
  // Salary: the specific components first ("current fixed salary" must not become current_salary).
  { intent: 'answers.expected_salary', any: ['expected salary', 'expected ctc', 'salary expectation', 'desired salary', 'expected compensation', 'expected annual', 'salary you are looking', 'expected pay', 'expected package', 'salary expectations', 'expectation in', 'expected fixed', 'expected variable', 'expected total', 'expected gross'] },
  // Longer phrasings (Lever: "Expected Monthly Fixed (Base) Salary in …") — anything with "expected" is never a current_* answer.
  { intent: 'answers.expected_salary', all: ['expected'], any: ['salary', 'ctc', 'compensation', 'pay', 'package'] },
  { intent: 'answers.current_variable_salary', any: ['variable salary', 'variable pay', 'variable component', 'current variable', 'variable ctc'], not: ['expected'] },
  { intent: 'answers.current_fixed_salary', any: ['fixed salary', 'fixed ctc', 'fixed pay', 'fixed component', 'current fixed', 'base salary', 'fixed compensation'], not: ['expected'] },
  { intent: 'answers.total_ctc', any: ['total ctc', 'fixed variable', 'total compensation', 'total salary', 'overall ctc', 'current total', 'gross salary', 'gross ctc', 'annual package', 'current package'], not: ['expected'] },
  { intent: 'answers.current_salary', any: ['current salary', 'current ctc', 'current compensation', 'present ctc', 'current annual', 'present salary', 'currently drawing', 'current pay', 'in hand salary', 'cost to company', 'how much do you earn', 'how much are you earning', 'your salary', 'salary you are drawing', 'current remuneration', 'current emoluments'], not: ['expected'] },
  { intent: 'answers.notice_serving', any: ['serving notice', 'serving your notice', 'on notice period', 'currently serving', 'serving the notice'] },
  { intent: 'answers.immediate_joiner', any: ['immediate joiner', 'join immediately', 'can you join within', 'join us within', 'join within', 'immediately available', 'available immediately'] },
  // NEVER a bare 'notice': "Do you agree to our privacy notice?" was answered with "30".
  { intent: 'answers.notice_period', any: ['notice period', 'days of notice', 'joining time', 'time to join', 'notice to serve', 'notice required'], not: ['privacy', 'policy', 'agree'] },
  { intent: 'answers.start_date', any: ['when can you start', 'how soon can you start', 'earliest start', 'start date', 'available to start', 'date of joining', 'earliest joining'] },
  { intent: 'answers.current_company', any: ['current company', 'current employer', 'current organization', 'current organisation', 'present company', 'present employer', 'last company', 'last employer', 'currently working at', 'currently employed at'] },
  { intent: 'answers.current_title', any: ['current designation', 'current title', 'current role', 'current job title', 'current position', 'present designation', 'present role'] },
  { intent: 'answers.github', any: ['github', 'git hub'] },
  { intent: 'answers.reason_for_change', any: ['reason for change', 'reason for job change', 'why are you looking', 'reason for leaving', 'looking for a change', 'why do you want to leave', 'reason to change', 'why are you leaving'] },
  { intent: 'answers.in_city', any: ['located in', 'based in', 'based out of', 'residing in', 'staying in', 'living in', 'reside in', 'currently in', 'located at'], not: ['relocat', 'willing', 'open to', 'comfortable', 'work from', 'sanction', 'countr'] },
  { intent: 'answers.background_check', any: ['background check', 'background verification'] },
  { intent: 'answers.over_18', any: ['18 years', 'at least 18', 'over 18', 'legal age'] },
  { intent: 'answers.language_proficiency', any: ['level of proficiency', 'proficiency in', 'proficient in english', 'english proficiency', 'level of english'] },
  { intent: 'answers.drivers_license', any: ['driver s license', 'drivers license', 'driving license', 'driving licence', 'driver s licence'] },
  { intent: 'answers.security_clearance', any: ['security clearance', 'clearance'] },
  { intent: 'identity.city', any: ['current city', 'current location', 'city you live', 'where are you located', 'where do you live', 'your city'] },
  // Plural / "where would you work" phrasing is the LOCATIONS question (a multi-choice of cities),
  // never "what city do you live in" — it must be tested BEFORE the bare-word city rule.
  { intent: 'locations', any: ['which cities', 'what cities', 'cities are you available', 'city or cities', 'cities would you', 'cities do you', 'preferred location', 'work location', 'available to work', 'prefer to work', 'willing to work in', 'open to working in', 'locations are you'], not: ['authorised', 'authorized'] },
  { intent: 'identity.city', word: ['city'], not: ['which cities', 'what cities', 'cities are you', 'authorised', 'authorized', 'prefer', 'cities'] },
  { intent: 'answers.languages', any: ['languages you speak', 'languages do you speak', 'fluent'] },
  { intent: 'answers.how_did_you_hear', all: ['how did you hear'] },
  { intent: 'answers.how_did_you_hear_detail', any: ['please specify'] },
  { intent: 'answers.education_level', any: ['education level', 'highest degree', 'level of education', 'highest qualification', 'educational qualification', 'highest education'], not: ['bachelor', 'master s', 'masters'] },
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
  { intent: 'answers.cover_letter', any: ['cover letter', 'why do you want', 'why are you interested', 'why should we', 'tell us about yourself', 'tell us why', 'describe your', 'include a message', 'message with your application', 'message to the hiring', 'message for the recruiter', 'anything else you', 'additional information', 'brief summary', 'about yourself', 'summary of your'] },
  // Screening questions.
  { intent: 'answers.exact_years_of_experience', any: ['exact years', 'exact number of years', 'precisely how many years', 'exactly how many years'] },
  { intent: 'answers.years_of_experience', any: ['years of experience', 'best describes your total', 'how many years', 'years of professional', 'years of non internship', 'years experience', 'years of', 'year of', 'years in', 'total experience', 'overall experience', 'experience in years', 'exp in years', 'total exp', 'yrs of', 'yrs experience', 'no of years', 'number of years', 'how many experience', 'how much experience', 'how many year'] },
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

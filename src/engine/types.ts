// Core domain types. Pure data — no chrome, no DOM, no network.

/** A job discovered from a site's listing. */
export interface Job {
  readonly id: string; // stable ATS id (Greenhouse gh_jid, Amazon id_icims)
  readonly title: string;
  readonly team: string;
  readonly department: string;
  readonly url: string;
  readonly locations: readonly string[]; // parsed from the listing, e.g. ["New York", "San Francisco"]
  readonly seniority: readonly string[]; // e.g. ["Individual Contributor"]
}

/** A single input rendered in an application form. */
export type FieldKind = 'text' | 'email' | 'tel' | 'file' | 'select' | 'multiselect' | 'checkbox';

export interface Field {
  readonly id: string; // DOM id, e.g. "first_name" or "question_67885030[]"
  readonly label: string; // human label, e.g. "In what cities are you available to work?"
  readonly kind: FieldKind;
  readonly required: boolean;
  /** Canonical intent this field maps to (identity.first_name, answers.work_authorization, …). */
  readonly intent?: Intent;
}

/** Canonical intents. Question text -> intent -> answer. Reused across every company. */
export type Intent =
  | 'identity.first_name'
  | 'identity.last_name'
  | 'identity.preferred_name'
  | 'identity.email'
  | 'identity.phone'
  | 'identity.country'
  | 'identity.linkedin'
  | 'identity.website'
  | 'resume'
  | 'answers.work_authorization'
  | 'answers.needs_sponsorship'
  | 'answers.how_did_you_hear'
  | 'answers.languages'
  | 'answers.acknowledge_true'
  | 'answers.privacy_consent'
  | 'answers.gender'
  | 'answers.hispanic_latino'
  | 'answers.veteran_status'
  | 'answers.disability'
  // Screening questions (Amazon "job-specific questions" and the like).
  | 'answers.years_of_experience' // "Which option best describes your total … experience?" (number)
  | 'answers.skills_experience' // "Do you have experience with/in …?" (yes/no)
  | 'answers.degree_bachelors' // "Do you have a Bachelor's degree …?" (yes/no)
  | 'answers.degree_masters' // "Do you have a Master's degree …?" (yes/no)
  | 'answers.willing_to_relocate'
  // Work-eligibility / compliance questions.
  | 'answers.previously_applied'
  | 'answers.previous_employment'
  | 'answers.non_compete'
  | 'answers.government_employee'
  | 'answers.lived_abroad'
  | 'answers.sanctioned_country'
  | 'answers.citizenship'
  | 'answers.countries_lived' // "countries outside X you have lived in for 12+ months" (multi)
  | 'answers.permanent_resident_elsewhere' // "since obtaining citizenship, did you become a permanent resident elsewhere?"
  // Self-identification questions beyond the US EEO set (Canada's Employment Equity Act wording).
  | 'answers.indigenous'
  | 'answers.visible_minority'
  | 'answers.racial_identity'
  | 'answers.ex_military'
  | 'answers.reserve_forces'
  | 'answers.military_spouse'
  | 'locations'; // "which cities/locations" — resolved from job + want.locations

/** What we decided to put in a field. */
export type Answer =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'choice'; readonly values: readonly string[] } // 1 for select, N for multiselect
  | { readonly kind: 'check'; readonly value: boolean } // check/uncheck a checkbox
  | { readonly kind: 'file' }
  | { readonly kind: 'unknown' }; // no confident answer -> park/skip per policy

export type ApplyStatus = 'applied' | 'parked' | 'failed';

/** One field we actually filled, with the exact value we put in — for the on-disk record. */
export interface AppliedField {
  readonly id: string;
  readonly label: string;
  readonly value: string; // display value (text, joined choices, "checked", or resume filename)
}

export interface Application {
  readonly company: string;
  readonly jobId: string;
  readonly title: string;
  readonly url: string;
  readonly date: string; // ISO yyyy-mm-dd
  readonly status: ApplyStatus;
  readonly note?: string; // parked/failed reason
  readonly fields?: readonly AppliedField[]; // exactly what we filled
  readonly screenshot?: string; // transient PNG dataURL — written to disk, NOT kept in storage
  readonly at?: string; // ISO timestamp, stamped by the repository when persisted
  readonly account?: string; // which login made it (multi-account setups) — stamped by the repository
}

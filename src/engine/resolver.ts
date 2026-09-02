import type { Answer, Field, Intent, Job } from './types';
import type { AnswerValue, Profile } from '../config/schema';
import { isAnswerToken, optionForToken } from './answer-tokens';
import { pickYearsOption } from './years';

// A boolean answer means "pick the yes/no option". These are the labels we accept as yes/no —
// matched as whole words, so "no" never hits "North Korea", "Not applicable" or "I choose not to".
const YES = ['yes', 'i agree', 'i acknowledge', 'i understand', 'true', 'authorized', 'authorised'];
const NO = ['no', 'i do not', "i don't", 'false', 'not authorized'];
// Whole-phrase match on letter boundaries: "no" matches "No, I was NEVER…" but not "North Korea"/"not".
const hasWord = (text: string, phrase: string): boolean =>
  (' ' + text.toLowerCase().replace(/[^a-z']+/g, ' ') + ' ').includes(' ' + phrase + ' ');

// Decide what goes in each field. Pure: (field, profile, job, options) -> Answer.
// options = the actual choices a select offers (needed to pick the right city/label).

const IDENTITY: Partial<Record<Intent, (p: Profile) => string>> = {
  'identity.first_name': (p) => p.identity.first_name,
  'identity.last_name': (p) => p.identity.last_name,
  'identity.preferred_name': (p) => p.identity.preferred_name || p.identity.first_name,
  'identity.email': (p) => p.identity.email,
  'identity.phone': (p) => p.identity.phone,
  'identity.country': (p) => p.identity.country,
  'identity.linkedin': (p) => p.identity.linkedin,
  'identity.website': (p) => p.identity.website,
};

export function resolve(field: Field, profile: Profile, job: Job, options: readonly string[] = []): Answer {
  // Only fill file inputs when we know they want the resume — otherwise (cover letter,
  // transcripts, portfolio uploads) leave them alone. Any file field without resume intent
  // was previously getting the resume attached, which is wrong.
  if (field.kind === 'file') return field.intent === 'resume' ? { kind: 'file' } : { kind: 'unknown' };

  // 1. verbatim override wins.
  const override = profile.overrides[field.label.trim()];
  if (override !== undefined) return toAnswer(override, field, options);

  // 2. checkboxes: an explicit boolean override aside, a REQUIRED checkbox is a submit gate
  // (consent/acknowledgement) — checking it is the only way to proceed. Optional ones we skip.
  if (field.kind === 'checkbox') return field.required ? { kind: 'check', value: true } : { kind: 'unknown' };

  const intent = field.intent;
  if (!intent) return { kind: 'unknown' };

  // 2. identity text fields.
  const id = IDENTITY[intent];
  if (id) return { kind: 'text', value: id(profile) };

  // 3. locations are DERIVED, never typed: options ∩ (job locations ∪ want.locations).
  if (intent === 'locations') return resolveLocations(options, profile, job);

  // 4. intent answer from profile.answers (e.g. answers.work_authorization).
  const key = intent.replace(/^answers\./, '');
  const val = profile.answers[key];
  if (val === undefined) return { kind: 'unknown' };
  return toAnswer(val, field, options);
}

function toAnswer(val: AnswerValue, field: Field, options: readonly string[]): Answer {
  // years_of_experience: MAX — always the top bucket / always "Yes" to "N+ years" (owner's rule).
  if (val === 'MAX' && field.intent === 'answers.years_of_experience') val = Number.POSITIVE_INFINITY;

  // Canonical token (DECLINE, NOT_A_VETERAN…) -> the option that matches this form's wording.
  if (isAnswerToken(val)) {
    const opt = optionForToken(val, options);
    return opt ? { kind: 'choice', values: [opt] } : { kind: 'unknown' };
  }

  // Boolean answer -> the yes/no option (or literal "Yes"/"No" for a text field).
  if (typeof val === 'boolean') {
    if (field.kind === 'checkbox') return { kind: 'check', value: val };
    if (field.kind === 'text') return { kind: 'text', value: val ? 'Yes' : 'No' };
    const synonyms = val ? YES : NO;
    const picked = options.filter((o) => synonyms.some((s) => hasWord(o, s)));
    return picked.length ? { kind: 'choice', values: picked.slice(0, 1) } : { kind: 'choice', values: [val ? 'Yes' : 'No'] };
  }

  // Numeric answer (years_of_experience: 6) -> the range option that contains it, or the number
  // itself for a free-text field.
  if (typeof val === 'number') {
    if (field.kind === 'select' || field.kind === 'multiselect') {
      const opt = pickYearsOption(options, val);
      if (opt) return { kind: 'choice', values: [opt] };
      // "Do you have 5+ years of …?" with Yes/No: compare against the threshold in the label.
      const threshold = /(\d+(?:\.\d+)?)\s*\+?\s*(?:or more\s+)?years?/i.exec(field.label)?.[1];
      const yes = options.find((o) => YES.some((s) => hasWord(o, s)));
      const no = options.find((o) => NO.some((s) => hasWord(o, s)));
      if (threshold && yes && no) return { kind: 'choice', values: [val >= Number(threshold) ? yes : no] };
      return { kind: 'unknown' };
    }
    return { kind: 'text', value: String(val) };
  }

  if (field.kind === 'text' || field.kind === 'email' || field.kind === 'tel') {
    return { kind: 'text', value: Array.isArray(val) ? (val[0] ?? '') : val };
  }

  // select / multiselect: map desired value(s) onto real option labels.
  const wanted = Array.isArray(val) ? val : [val];
  const picked = matchOptions(options, wanted);
  if (picked.length === 0) return options.length ? { kind: 'unknown' } : { kind: 'choice', values: wanted };
  return { kind: 'choice', values: field.kind === 'select' ? picked.slice(0, 1) : picked };
}

/** cities question: pick every offered option the applicant would accept. */
function resolveLocations(options: readonly string[], profile: Profile, job: Job): Answer {
  const acceptable = [...job.locations, ...profile.want.locations];
  const picked = matchOptions(options, acceptable);
  // If the form gave no options yet (or none match), fall back to the job's own location.
  if (picked.length) return { kind: 'choice', values: picked };
  const jobOpts = matchOptions(options, job.locations);
  return jobOpts.length ? { kind: 'choice', values: jobOpts } : { kind: 'unknown' };
}

/** The "obvious" choice for a required question nobody has an answer for (on_unknown: guess) —
 *  the owner's rule is "never stuck", so this always returns something for a select/text:
 *    1. a decline / prefer-not option, if offered;
 *    2. the applicant's own country (identity.country) when the options are a country list;
 *    3. "No" / "None" / "Not applicable" — the answer that opens no follow-up questions;
 *    4. last resort: the first real option (select) or "N/A" (free text).
 *  Callers mark the record "(guessed)" so a bad guess is visible after the fact. */
export function guessAnswer(field: Field, options: readonly string[], profile?: Profile): Answer | null {
  if (field.kind === 'checkbox') return { kind: 'check', value: true };
  if (field.kind === 'text' || field.kind === 'email' || field.kind === 'tel') return { kind: 'text', value: 'N/A' };
  if (field.kind !== 'select' && field.kind !== 'multiselect') return null;
  const decline = optionForToken('DECLINE', options);
  if (decline) return { kind: 'choice', values: [decline] };
  const country = profile?.identity.country?.trim().toLowerCase();
  const own = country ? options.find((o) => o.trim().toLowerCase() === country) : undefined;
  if (own) return { kind: 'choice', values: [own] };
  const no = options.find((o) => NO.some((s) => hasWord(o, s)) || /^(none|not applicable|n\/a)\b/i.test(o.trim()));
  if (no) return { kind: 'choice', values: [no] };
  const first = options.find((o) => o.trim() !== '' && !/^select/i.test(o.trim()));
  return first ? { kind: 'choice', values: [first] } : null;
}

/** Per wanted value, an exact option wins outright ("India" must not become "British Indian Ocean
 *  Territory"); otherwise fuzzy: the option matches if either contains the other. Option order kept. */
export function matchOptions(options: readonly string[], wanted: readonly string[]): string[] {
  const hits = new Set<string>();
  for (const x of wanted.map((s) => s.toLowerCase().trim()).filter(Boolean)) {
    const exact = options.filter((opt) => opt.toLowerCase().trim() === x);
    const found = exact.length ? exact : options.filter((opt) => opt.toLowerCase().includes(x) || x.includes(opt.toLowerCase()));
    for (const f of found) hits.add(f);
  }
  return options.filter((opt) => hits.has(opt));
}

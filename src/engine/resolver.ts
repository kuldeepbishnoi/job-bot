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

/** Does this option text answer `want`? Exact first, then WHOLE-WORD containment either way.
 *  Never a bare substring: "Yes, I know Kubernetes well".includes("no") is true (inside "know"),
 *  which made the adapter tick Yes for a No answer. Used by every ATS adapter that picks an option. */
export function optionAnswers(option: string, want: string): boolean {
  const o = option.toLowerCase().trim();
  const w = want.toLowerCase().trim();
  if (!w) return false;
  if (o === w) return true;
  return hasWord(o, w) || hasWord(w, o);
}

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
  'identity.city': (p) => p.identity.city,
};

// `years_of_experience: MAX` on a free-text "how many years…" box (LinkedIn) — there is no top
// bucket to pick, so type the threshold the question names ("5+ years" → 5) or this many.
const MAX_YEARS_TEXT = 10;

export function resolve(field: Field, profile: Profile, job: Job, options: readonly string[] = []): Answer {
  // Only fill file inputs when we know they want the resume — otherwise (cover letter,
  // transcripts, portfolio uploads) leave them alone. Any file field without resume intent
  // was previously getting the resume attached, which is wrong.
  if (field.kind === 'file') return field.intent === 'resume' ? { kind: 'file' } : { kind: 'unknown' };

  // 1. verbatim override wins.
  const override = profile.overrides[field.label.trim()];
  if (override !== undefined) return toAnswer(override, field, options);

  const intent = field.intent;

  // 2. checkboxes: an intent with a boolean answer decides (LinkedIn's "Mark job as a top choice"
  // is an opt-in extra — off unless the profile says otherwise); else a REQUIRED checkbox is a
  // submit gate (consent/acknowledgement) — checking it is the only way to proceed. Optional
  // ones we leave alone.
  if (field.kind === 'checkbox') {
    const key = intent?.replace(/^answers\./, '');
    const v = key ? profile.answers[key] : undefined;
    if (typeof v === 'boolean') return { kind: 'check', value: v };
    if (intent === 'answers.top_choice') return { kind: 'check', value: false };
    return field.required ? { kind: 'check', value: true } : { kind: 'unknown' };
  }

  if (!intent) return { kind: 'unknown' };

  // 3. derived answers: salary components in the unit the label names, notice period as days,
  // "are you located in <city>" from identity.city.
  const derived = resolveDerived(intent, field, profile, options);
  if (derived) return derived;

  // 2. identity fields — typed, or picked when the form offers them as a list (LinkedIn's email
  // dropdown); a typeahead (no options yet) gets the text to type.
  const id = IDENTITY[intent];
  if (id) {
    const v = id(profile);
    if (field.kind !== 'select' && field.kind !== 'multiselect') return { kind: 'text', value: v };
    if (!v) return { kind: 'unknown' };
    const picked = matchOptions(options, [v]);
    if (picked.length) return { kind: 'choice', values: picked.slice(0, 1) };
    return options.length ? { kind: 'unknown' } : { kind: 'choice', values: [v] };
  }

  // 3. locations are DERIVED, never typed: options ∩ (job locations ∪ want.locations).
  if (intent === 'locations') return resolveLocations(options, profile, job);
  if (intent === 'identity.phone_country') {
    const opt = pickPhoneCountry(options, profile.identity.country, profile.identity.phone);
    return opt ? { kind: 'choice', values: [opt] } : { kind: 'unknown' };
  }

  // 4. intent answer from profile.answers (e.g. answers.work_authorization).
  const key = intent.replace(/^answers\./, '');
  const val = profile.answers[key];
  if (val === undefined) return { kind: 'unknown' };
  return toAnswer(val, field, options);
}

const num = (v: AnswerValue | undefined): number | undefined => (typeof v === 'number' ? v : typeof v === 'string' && /^\s*[\d,.]+\s*$/.test(v) ? Number(v.replace(/,/g, '')) : undefined);

/** Salary answers: profile numbers are ANNUAL in the applicant's currency (INR for the Indian
 *  market); each component derives from the others when unset, so one `current_salary` answers
 *  fixed / variable / total. `undefined` = the profile has no salary at all (→ unknown → review). */
export function salaryFor(intent: Intent, answers: Readonly<Record<string, AnswerValue>>): number | undefined {
  const fixed = num(answers['current_fixed_salary']);
  const variable = num(answers['current_variable_salary']);
  const current = num(answers['current_salary']);
  const total = num(answers['total_ctc']);
  switch (intent) {
    case 'answers.expected_salary':
      return num(answers['expected_salary']);
    case 'answers.current_fixed_salary':
      return fixed ?? current ?? (total !== undefined ? total - (variable ?? 0) : undefined);
    case 'answers.current_variable_salary':
      return variable ?? (fixed !== undefined || current !== undefined || total !== undefined ? 0 : undefined);
    case 'answers.total_ctc':
      return total ?? (fixed !== undefined ? fixed + (variable ?? 0) : current !== undefined ? current + (variable ?? 0) : undefined);
    case 'answers.current_salary':
      return current ?? total ?? (fixed !== undefined ? fixed + (variable ?? 0) : undefined);
    default:
      return undefined;
  }
}

/** The unit a salary question asks for, read off its label: lakhs per annum ("LPA", "in lakhs"),
 *  per month, thousands, else the annual figure as is. */
export function salaryInUnit(annual: number, label: string): number {
  const t = label.toLowerCase();
  const monthly = /\b(per month|monthly|a month|pm|lpm)\b/.test(t);
  const base = monthly ? annual / 12 : annual;
  if (/\b(lpa|lakhs?|lacs?|lpm)\b/.test(t)) return Math.round((base / 100_000) * 10) / 10;
  if (/\b(in thousands|thousands|k)\b/.test(t)) return Math.round(base / 1000);
  return Math.round(base);
}

/** "30 days" / "1 month" / "2 weeks" / "Immediate" / "15-30 days" / "More than 60 days" → days. */
export function noticeDays(label: string): { min: number; max: number } | null {
  const t = label.toLowerCase().replace(/[–—]/g, '-');
  if (/immediate|immediately|right away|currently not working|not working|no notice|0 days|serving/.test(t) && !/\d/.test(t)) return { min: 0, max: 0 };
  const unit = /\bmonths?\b/.test(t) ? 30 : /\bweeks?\b/.test(t) ? 7 : 1;
  const nums = (t.match(/\d+(?:\.\d+)?/g) ?? []).map((n) => Number(n) * unit);
  if (!nums.length) return null;
  if (nums.length >= 2) return { min: Math.min(nums[0]!, nums[1]!), max: Math.max(nums[0]!, nums[1]!) };
  const n = nums[0]!;
  if (/less than|under|below|up to|within|or less|max/.test(t)) return { min: 0, max: n };
  if (/more than|above|over|\+|or more|greater/.test(t)) return { min: n, max: Number.POSITIVE_INFINITY };
  return { min: n, max: n };
}

/** The notice-period option whose range contains `days`, else the nearest one above it (a
 *  longer notice is an honest answer; a shorter one is not), else the longest offered. */
export function pickNoticeOption(options: readonly string[], days: number): string | null {
  const parsed = options.map((o) => ({ o, r: noticeDays(o) })).filter((x): x is { o: string; r: { min: number; max: number } } => x.r !== null);
  if (!parsed.length) return null;
  const hit = parsed.find((x) => days >= x.r.min && days <= x.r.max);
  if (hit) return hit.o;
  const above = parsed.filter((x) => x.r.min > days).sort((a, b) => a.r.min - b.r.min)[0];
  return above?.o ?? parsed.reduce((a, b) => (b.r.min > a.r.min ? b : a)).o;
}

const YESNO = (options: readonly string[]): { yes: string; no: string } | null => {
  const yes = options.find((o) => YES.some((s) => hasWord(o, s)));
  const no = options.find((o) => NO.some((s) => hasWord(o, s)));
  return yes && no ? { yes, no } : null;
};

/** Answers computed from the profile rather than read verbatim. Null = not a derived intent. */
function resolveDerived(intent: Intent, field: Field, profile: Profile, options: readonly string[]): Answer | null {
  const a = profile.answers;
  const choice = field.kind === 'select' || field.kind === 'multiselect';
  const yn = YESNO(options);
  switch (intent) {
    case 'answers.expected_salary':
    case 'answers.current_salary':
    case 'answers.current_fixed_salary':
    case 'answers.current_variable_salary':
    case 'answers.total_ctc': {
      const annual = salaryFor(intent, a);
      if (annual === undefined) return { kind: 'unknown' };
      const v = salaryInUnit(annual, field.label);
      if (!choice) return { kind: 'text', value: String(v) };
      // Range options ("10-15 LPA", "10,00,000 - 15,00,000"): parse in the option's own unit.
      const plain = options.map((o) => o.replace(/(\d),(?=\d)/g, '$1'));
      const inLakhs = plain.some((o) => /\b(lpa|lakhs?|lacs?)\b/i.test(o));
      const picked = pickYearsOption(plain, inLakhs ? salaryInUnit(annual, 'lpa') : salaryInUnit(annual, field.label));
      const idx = picked ? plain.indexOf(picked) : -1;
      return idx >= 0 ? { kind: 'choice', values: [options[idx]!] } : { kind: 'unknown' };
    }
    case 'answers.notice_period': {
      const raw = a['notice_period'];
      const days = typeof raw === 'number' ? raw : typeof raw === 'string' ? (noticeDays(raw)?.min ?? undefined) : undefined;
      if (days === undefined) return { kind: 'unknown' };
      if (choice) {
        if (yn) return { kind: 'choice', values: [days > 0 ? yn.yes : yn.no] }; // "Do you have a notice period?"
        const opt = pickNoticeOption(options, days);
        return opt ? { kind: 'choice', values: [opt] } : options.length ? { kind: 'unknown' } : { kind: 'choice', values: [String(days)] };
      }
      const t = field.label.toLowerCase();
      if (/\bmonths?\b/.test(t)) return { kind: 'text', value: String(Math.max(0, Math.round(days / 30))) };
      if (/\bweeks?\b/.test(t)) return { kind: 'text', value: String(Math.max(0, Math.round(days / 7))) };
      return { kind: 'text', value: String(days) };
    }
    case 'answers.immediate_joiner': {
      const explicit = a['immediate_joiner'];
      const notice = a['notice_period'];
      const val = typeof explicit === 'boolean' ? explicit : typeof notice === 'number' ? notice <= 15 : undefined;
      if (val === undefined) return { kind: 'unknown' };
      return toAnswer(val, field, options);
    }
    case 'answers.years_of_experience': {
      // A free-text "how many years of experience in X?" box gets the honest figure when the
      // profile has one: MAX means "the top bucket of a ladder" (the owner's rule), not "type 10".
      // Typing more years than the résumé shows contradicts the document the recruiter reads.
      const exact = num(a['exact_years_of_experience']);
      if (choice || exact === undefined || a['years_of_experience'] !== 'MAX') return null;
      return { kind: 'text', value: String(exact) };
    }
    case 'answers.exact_years_of_experience': {
      // "How many exact years…" must match the résumé, so MAX never applies here. Fall back to a
      // numeric years_of_experience; a MAX ladder answer is not a number and leaves this unknown.
      const exact = num(a['exact_years_of_experience']) ?? num(a['years_of_experience']);
      if (exact === undefined) return { kind: 'unknown' };
      if (!choice) return { kind: 'text', value: Number.isInteger(exact) ? String(exact) : String(exact) };
      const opt = pickYearsOption(options, exact);
      if (opt) return { kind: 'choice', values: [opt] };
      return yn ? { kind: 'choice', values: [exact > 0 ? yn.yes : yn.no] } : { kind: 'unknown' };
    }
    case 'answers.in_city': {
      const city = profile.identity.city.trim().toLowerCase();
      if (!city) return { kind: 'unknown' };
      const here = field.label.toLowerCase().includes(city);
      if (!choice) return { kind: 'text', value: here ? 'Yes' : profile.identity.city };
      return toAnswer(here, field, options);
    }
    default:
      return null;
  }
}

function toAnswer(val: AnswerValue, field: Field, options: readonly string[]): Answer {
  // years_of_experience: MAX — always the top bucket / always "Yes" to "N+ years" (owner's rule).
  if (val === 'MAX' && field.intent === 'answers.years_of_experience') {
    if (field.kind === 'select' || field.kind === 'multiselect') val = Number.POSITIVE_INFINITY;
    else val = Number(/(\d+(?:\.\d+)?)\s*\+?\s*(?:or more\s+)?years?/i.exec(field.label)?.[1] ?? MAX_YEARS_TEXT);
  }

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
    if (picked.length) return { kind: 'choice', values: picked.slice(0, 1) };
    // A two-option question where only ONE side names itself ("Yes, I know Kubernetes well" /
    // "Not at this time"): the other option is the answer. Without this the adapter's word-boundary
    // matcher finds nothing and the job parks — and a substring match would tick the opposite box
    // ("Yes, I know…" contains "no", inside "know"), which is how a No became a Yes.
    const real = options.filter((o) => o.trim() !== '' && !/^select/i.test(o.trim()));
    if (real.length === 2) {
      const yes = real.filter((o) => YES.some((x) => hasWord(o, x)));
      const no = real.filter((o) => NO.some((x) => hasWord(o, x)));
      if (yes.length === 1 && no.length === 0) return { kind: 'choice', values: [val ? yes[0]! : real.find((o) => o !== yes[0])!] };
      if (no.length === 1 && yes.length === 0) return { kind: 'choice', values: [val ? real.find((o) => o !== no[0])! : no[0]!] };
    }
    // No option says yes or no: a literal "Yes"/"No" would be typed into a free-text box, but on a
    // real option list it means we do not know which option answers the question.
    return options.length ? { kind: 'unknown' } : { kind: 'choice', values: [val ? 'Yes' : 'No'] };
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
      // "Do you have experience …?" shaped as yes/no with no threshold: any experience at all = Yes.
      if (yes && no && field.intent === 'answers.years_of_experience') return { kind: 'choice', values: [val > 0 ? yes : no] };
      return { kind: 'unknown' };
    }
    return { kind: 'text', value: String(val) };
  }

  if (field.kind === 'text' || field.kind === 'email' || field.kind === 'tel') {
    // An empty profile value (`github: ""`) is "no answer", not "type nothing": a required box
    // would fail validation forever. Fall through to unknown → guess/park per policy.
    const text = Array.isArray(val) ? (val[0] ?? '') : String(val);
    return text.trim() ? { kind: 'text', value: text } : { kind: 'unknown' };
  }

  // select / multiselect: map desired value(s) onto real option labels.
  const wanted = Array.isArray(val) ? val : [val];
  const picked = matchOptions(options, wanted);
  // No options yet (a live-search picker) → pass the text through; the adapter types it.
  if (picked.length === 0) return options.length ? { kind: 'unknown' } : { kind: 'choice', values: wanted };
  return { kind: 'choice', values: field.kind === 'select' ? picked.slice(0, 1) : picked };
}

/** "Phone country code" select: the option that names the applicant's country ("India (+91)"),
 *  never a fuzzy superstring ("British Indian Ocean Territory"); else the phone's own dial code. */
export function pickPhoneCountry(options: readonly string[], country: string, phone: string): string | null {
  const c = country.trim().toLowerCase();
  if (c) {
    const starts = options.find((o) => o.trim().toLowerCase().startsWith(c) && !/^[a-z]/.test(o.trim().toLowerCase().slice(c.length)));
    if (starts) return starts;
  }
  const code = /^\+(\d{1,3})\b/.exec(phone.trim())?.[1];
  if (code) {
    const byCode = options.find((o) => new RegExp(`\\+${code}(?!\\d)`).test(o));
    if (byCode) return byCode;
  }
  return null;
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
const AGREEABLE = /comfortable|willing|okay|ok with|open to|agree|able to|can you|available|ready to|flexible|fine with|interested|would you/i;

export function guessAnswer(field: Field, options: readonly string[], profile?: Profile): Answer | null {
  // A required lone checkbox gates submit → tick it; an optional one is an opt-in extra → leave it off.
  if (field.kind === 'checkbox') return { kind: 'check', value: field.required };
  if (field.kind === 'text' || field.kind === 'email' || field.kind === 'tel') return { kind: 'text', value: 'N/A' };
  if (field.kind !== 'select' && field.kind !== 'multiselect') return null;
  const decline = optionForToken('DECLINE', options);
  if (decline) return { kind: 'choice', values: [decline] };
  const country = profile?.identity.country?.trim().toLowerCase();
  const own = country ? options.find((o) => o.trim().toLowerCase() === country) : undefined;
  if (own) return { kind: 'choice', values: [own] };
  // "Are you comfortable / willing / okay with …?" — an applicant says Yes; anything else, No.
  const yn = YESNO(options);
  if (yn && AGREEABLE.test(field.label)) return { kind: 'choice', values: [yn.yes] };
  const no = options.find((o) => NO.some((s) => hasWord(o, s)) || /^(none|not applicable|n\/a)\b/i.test(o.trim()));
  if (no) return { kind: 'choice', values: [no] };
  // Last resort: only for a list with no claim to overstate. Picking options[0] on a ladder
  // ("Native or bilingual", "10+ years", "Expert") asserts the STRONGEST claim to an employer —
  // a lie the owner would never have typed. Two or fewer real options is a binary we can't skew;
  // anything longer parks and lands in the review file for a human answer.
  const real = options.filter((o) => o.trim() !== '' && !/^select/i.test(o.trim()));
  if (real.length > 2) return null;
  return real[0] ? { kind: 'choice', values: [real[0]] } : null;
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

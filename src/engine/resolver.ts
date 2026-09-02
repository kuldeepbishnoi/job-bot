import type { Answer, Field, Intent, Job } from './types';
import type { AnswerValue, Profile } from '../config/schema';
import { isAnswerToken, optionForToken } from './answer-tokens';

// A boolean answer means "pick the yes/no option". These are the labels we accept as yes/no.
const YES = ['yes', 'i agree', 'i acknowledge', 'i understand', 'true', 'authorized', 'authorised'];
const NO = ['no', 'i do not', "i don't", 'false', 'not authorized'];

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
    const picked = options.filter((o) => synonyms.some((s) => o.toLowerCase().includes(s)));
    return picked.length ? { kind: 'choice', values: picked.slice(0, 1) } : { kind: 'choice', values: [val ? 'Yes' : 'No'] };
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

/** Fuzzy: an option matches a wanted value if either contains the other (token-wise). */
export function matchOptions(options: readonly string[], wanted: readonly string[]): string[] {
  const w = wanted.map((s) => s.toLowerCase().trim()).filter(Boolean);
  return options.filter((opt) => {
    const o = opt.toLowerCase();
    return w.some((x) => o.includes(x) || x.includes(o));
  });
}

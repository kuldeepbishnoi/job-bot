import type { Field } from './types';
import type { Profile } from '../config/schema';

// Shape a resolved TEXT answer so the form accepts it, without inventing a claim. Pure: the LinkedIn
// content script was doing this inline, where it could not be tested — and it was clamping
// `Math.min(99, 7000000)`, telling employers the applicant expects 99 when the profile says 70 lakh.
//
// `null` = "this cannot be made to fit honestly" → the caller parks the job and records why.

const SALARY_INTENTS = new Set([
  'answers.expected_salary',
  'answers.current_salary',
  'answers.current_fixed_salary',
  'answers.current_variable_salary',
  'answers.total_ctc',
]);
const YEARS_INTENTS = new Set(['answers.years_of_experience', 'answers.exact_years_of_experience']);

/** The ceiling a numeric box names in its own validation message ("between 0 and 99"). */
export function maxFromHint(hint: string): number | null {
  const m = /between\s+[\d.]+\s+and\s+([\d.]+)/i.exec(hint) ?? /(?:no more than|at most|maximum(?: of)?)\s+([\d.]+)/i.exec(hint);
  return m ? Number(m[1]) : null;
}

/** The minimum / maximum character count a text box names ("Minimum 20 characters"). */
export function lengthLimits(hint: string): { min: number; max: number } {
  return {
    min: Number(/minimum (?:of )?(\d+) char/i.exec(hint)?.[1] ?? /at least (\d+) char/i.exec(hint)?.[1] ?? 0),
    max: Number(/maximum (?:of )?(\d+) char/i.exec(hint)?.[1] ?? /at most (\d+) char/i.exec(hint)?.[1] ?? /no more than (\d+) char/i.exec(hint)?.[1] ?? 0),
  };
}

/** A number the box will accept, or null when the honest value cannot fit.
 *  - years are FLOORED (4.7 years is "4", never "5" — the résumé says 4 years 8 months)
 *  - a salary that exceeds the box's ceiling is RESCALED to the unit the box must mean (lakhs,
 *    thousands) and only used if it then fits; it is never clamped to the ceiling. */
export function fitNumber(value: string, field: Field, profile: Profile, hint: string): string | null {
  const decimal = /decimal/i.test(hint);
  const intent = field.intent ?? '';
  let n = Number.parseFloat(value.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) {
    const exact = profile.answers['exact_years_of_experience'];
    const years = profile.answers['years_of_experience'];
    if (/^yes$/i.test(value.trim())) n = 1;
    else if (/^no$/i.test(value.trim())) n = 0;
    else if (intent === 'answers.exact_years_of_experience' && typeof exact === 'number') n = exact;
    else if (YEARS_INTENTS.has(intent) || /year|experience/i.test(field.label)) n = typeof years === 'number' ? years : typeof exact === 'number' ? exact : 10;
    else if (intent === 'answers.notice_period') n = 30;
    else if (SALARY_INTENTS.has(intent) || /salary|ctc|compensation/i.test(field.label)) return null; // never invent pay
    else n = 1; // a positive whole number satisfies every LinkedIn numeric rule
  }
  if (!decimal) n = Math.max(0, YEARS_INTENTS.has(intent) ? Math.floor(n) : Math.round(n));
  const max = maxFromHint(hint);
  if (max !== null && n > max) {
    if (SALARY_INTENTS.has(intent)) {
      const scaled = [n / 100_000, n / 1000].find((v) => v > 0 && v <= max);
      if (scaled === undefined) return null;
      n = Math.round(scaled * 10) / 10;
    } else {
      n = max;
    }
  }
  if (decimal && n <= 0) n = 1;
  return decimal ? n.toFixed(1) : String(n);
}

/** Pad or trim free text to the length the box demands, building from the profile's own words.
 *  Never invents a claim: the filler is the cover letter, or a neutral sentence. */
export function fitText(value: string, profile: Profile, hint: string): string {
  const { min, max } = lengthLimits(hint);
  let v = value;
  if (min && v.trim().length < min) {
    const cover = typeof profile.answers['cover_letter'] === 'string' ? profile.answers['cover_letter'] : '';
    const fallback = `${profile.identity.first_name} ${profile.identity.last_name} — ${cover || 'I am interested in this role and my background matches the requirements listed; happy to discuss further.'}`;
    v = (/^(n\/?a|none|-|\.)$/i.test(v.trim()) || !v.trim() ? fallback : `${v}. ${fallback}`).trim();
    while (v.length < min) v += ' Thank you for considering my application.';
  }
  if (max && v.length > max) v = v.slice(0, max).replace(/\s+\S*$/, '').trim() || v.slice(0, max);
  return v;
}

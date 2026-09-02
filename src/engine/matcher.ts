import type { Field, Intent } from './types';

// Map a raw question label -> canonical intent, by keyword rules.
// Intent-based (not exact-text) so the same rules answer Datadog, Netflix, Alibaba…
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
}

// Identity fields are matched by DOM id in the adapter; these rules cover custom questions.
const RULES: readonly Rule[] = [
  { intent: 'identity.linkedin', all: ['linkedin'] },
  { intent: 'identity.website', any: ['website', 'portfolio', 'personal site'] },
  { intent: 'answers.needs_sponsorship', any: ['sponsorship', 'require sponsorship', 'need sponsorship', 'visa sponsorship'] },
  { intent: 'answers.work_authorization', any: ['legally authorised', 'legally authorized', 'right to work', 'authorized to work', 'authorised to work', 'eligible to work'] },
  { intent: 'locations', any: ['which cities', 'what cities', 'cities are you available', 'preferred location', 'work location', 'available to work'], not: ['authorised', 'authorized'] },
  { intent: 'answers.languages', any: ['languages you speak', 'languages do you speak', 'fluent'] },
  { intent: 'answers.how_did_you_hear', all: ['how did you hear'] },
  { intent: 'answers.acknowledge_true', any: ['information provided in this application is true', 'certify that the information', 'true and correct'] },
  { intent: 'answers.privacy_consent', any: ['candidate privacy', 'privacy policy', 'privacy notice', 'processed in accordance'] },
  { intent: 'answers.gender', all: ['gender'] },
  { intent: 'answers.hispanic_latino', any: ['hispanic', 'latino'] },
  { intent: 'answers.veteran_status', any: ['veteran', 'protected veteran'] },
  { intent: 'answers.disability', any: ['disability', 'disabled'] },
];

function has(text: string, phrase: string): boolean {
  return text.includes(normalize(phrase));
}

/** Best-effort intent for a question label. undefined = unknown -> park/skip. */
export function matchIntent(label: string): Intent | undefined {
  const t = normalize(label);
  for (const r of RULES) {
    if (r.all && !r.all.every((p) => has(t, p))) continue;
    if (r.any && !r.any.some((p) => has(t, p))) continue;
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

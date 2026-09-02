import { z } from 'zod';

// Validate profile.yaml at the boundary. Fail fast with clear messages.
export const IdentitySchema = z.object({
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  preferred_name: z.string().default(''),
  email: z.string().email(),
  phone: z.string().min(1),
  country: z.string().min(1),
  linkedin: z.string().default(''),
  website: z.string().default(''),
});

export const WantSchema = z.object({
  titles_any: z.array(z.string()).default([]),
  titles_none: z.array(z.string()).default([]),
  locations: z.array(z.string()).default([]),
  seniority: z.array(z.string()).default([]),
});

// Answers are typed by the shape of the question, not all strings:
//   boolean  -> yes/no questions (work_authorization, needs_sponsorship, consents)
//   string   -> single choice or free text (how_did_you_hear)
//   string[] -> multi-select (languages, locations)
//   number   -> "how many years …" range dropdowns (years_of_experience)
export const AnswerValue = z.union([z.string(), z.boolean(), z.number(), z.array(z.string())]);
export type AnswerValue = z.infer<typeof AnswerValue>;
export const AnswersSchema = z.record(AnswerValue);

// Per-site knobs. Only what a site genuinely needs from the user; everything else is derived.
export const AmazonSchema = z.object({
  // Paste the amazon.jobs search page URL with your filters applied (category, country,
  // experience…). Discovery turns it into the JSON API query. Yours, not ours — no default.
  search_url: z.string().url(),
  // Amazon asks once whether it may use AI to recommend jobs / refer you to recruiters.
  ai_consent: z.boolean().default(false),
});

export const ProfileSchema = z.object({
  identity: IdentitySchema,
  resume: z.string().min(1),
  want: WantSchema.default({}),
  answers: AnswersSchema.default({}),
  // Exact-question-text → answer, for rare one-offs the intent rules don't cover.
  overrides: z.record(AnswerValue).default({}),
  // park = stop and ask; skip = leave it (submit may fail); guess = pick the safe obvious option
  // (decline-to-answer if offered, else "No") and keep going — never stuck, guesses are recorded.
  on_unknown: z.enum(['park', 'skip', 'guess']).default('park'),
  auto_submit: z.boolean().default(false),
  // Cap the queue per run (e.g. 15 to test hands-free submission on a small batch). Omit = all.
  max_per_run: z.number().int().positive().optional(),
  // Present only when the user runs that site (validated then; absent = the site is off-limits).
  amazon: AmazonSchema.optional(),
});

export type Identity = z.infer<typeof IdentitySchema>;
export type Want = z.infer<typeof WantSchema>;
export type AmazonConfig = z.infer<typeof AmazonSchema>;
export type Profile = z.infer<typeof ProfileSchema>;

export function parseProfile(raw: unknown): Profile {
  const r = ProfileSchema.safeParse(raw);
  if (!r.success) {
    throw new Error(`profile.yaml is invalid:\n${r.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  return r.data;
}

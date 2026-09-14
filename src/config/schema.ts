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
  // Current city, for the "City" typeahead / "current location" questions (LinkedIn Easy Apply).
  city: z.string().default(''),
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
  // experience…) to narrow it to what you actually want. Discovery turns it into the JSON API
  // query. Defaults to every open software-development role worldwide, sorted most-recent-first,
  // so the pack works with zero configuration — narrow it (country[], industry_experience…) once
  // you know what you want; `want` in profile.yaml still filters titles/locations on top either way.
  search_url: z.string().url().default('https://www.amazon.jobs/en/search?category[]=software-development&sort=recent'),
  // Amazon asks once whether it may use AI to recommend jobs / refer you to recruiters.
  ai_consent: z.boolean().default(false),
});

// LinkedIn Easy Apply runs in-page in the user's logged-in tab (no worker window, no OTP).
export const LinkedinSchema = z.object({
  // Search pages WITH your filters applied (keywords, location, date posted…). The bot forces the
  // Easy Apply filter (f_AL=true) and walks every page of each URL in order. Defaults to a broad
  // "Software Engineer" search with no location filter so the pack works with zero configuration —
  // narrow it (keywords, location, date posted) once you know what you want; `want.titles_any` /
  // `want.titles_none` still filter which cards get opened either way (see filter_titles below).
  search_urls: z.array(z.string().url()).min(1).default(['https://www.linkedin.com/jobs/search/?keywords=Software%20Engineer']),
  // Only open cards whose title passes want.titles_any / titles_none (default). false = every
  // Easy Apply card the search returns.
  filter_titles: z.boolean().default(true),
  // Safety cap per run on top of profile.max_per_run. LinkedIn's own daily limit ends a run earlier.
  max_per_run: z.number().int().positive().default(100),
});

// Multi-company packs (Greenhouse boards, Lever, Ashby): a list of company job boards to walk.
// Each entry is the board's slug ("discord") or any URL on that board — parseBoardRef() in the
// matching src/sources/*.ts normalises both. These packs APPLY, not just discover — so the default
// is "run exactly what you listed", never a silent fan-out.
//
// include_defaults defaults to FALSE deliberately. With `auto_submit: true` — a normal setting
// here — turning it on means one click applies to companies the user never named (133 in
// DEFAULT_GREENHOUSE_BOARDS alone, plus 12 Lever and 56 Ashby), and an application cannot be
// withdrawn. Opting in has to be a decision, not the consequence of leaving a key out of
// profile.yaml. With it false and no boards, the pack refuses to run rather than pick a target the
// user never chose. Everything here is meant to be edited from the dashboard.
export const BoardListSchema = z.object({
  boards: z.array(z.string().min(1)).default([]),
  include_defaults: z.boolean().default(false),
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
  // Cap the applications one run may make. This is the blast radius, not a tuning knob: with
  // `auto_submit: true` it is the number of real, unwithdrawable applications a single click can
  // send. It DEFAULTS to 50 rather than "unlimited when unset", because the multi-company packs
  // (Greenhouse boards, Lever, Ashby) can discover thousands of jobs and, unlike LinkedIn, those
  // ATSes enforce no daily cap of their own — deleting this line must not mean "apply to
  // everything discovered". Set `max_per_run: 0` to genuinely lift the limit.
  max_per_run: z.number().int().nonnegative().default(50),
  // Careers/search URLs the apply-jobs skill walks; hosts map to site packs (unknown → build one).
  careers: z.array(z.string().url()).default([]),
  // Multi-account: every login you apply from (one Chrome profile each, all sharing this folder).
  // The popup's "Account" field says which one THIS extension instance is; the shared
  // applications/registry.jsonl makes every instance skip jobs any account already applied to.
  accounts: z.array(z.string().email()).default([]),
  // Optional safety cap per account per day, counted PER SITE (10 Amazon applications, not 10
  // across every site — see store.ts#appliedTodayCount). The real signal is the ATS's own limit
  // page (Amazon: summary?result=application_limit_reach), which rotates accounts by itself, and
  // LinkedIn/Instahyre enforce their own caps, so this is an Amazon-shaped knob in practice.
  per_account_limit: z.number().int().positive().optional(),
  // Present only when the user runs that site (validated then; absent = the site is off-limits).
  // Present with sensible defaults even when the block is absent — see AmazonSchema.search_url.
  amazon: AmazonSchema.default({}),
  // Present with sensible defaults even when the block is absent — see LinkedinSchema.search_urls.
  linkedin: LinkedinSchema.default({}),
  // Always present (defaults exist), so these packs run out of the box.
  greenhouse: BoardListSchema.default({}),
  lever: BoardListSchema.default({}),
  ashby: BoardListSchema.default({}),
});

export type Identity = z.infer<typeof IdentitySchema>;
export type Want = z.infer<typeof WantSchema>;
export type AmazonConfig = z.infer<typeof AmazonSchema>;
export type LinkedinConfig = z.infer<typeof LinkedinSchema>;
export type BoardList = z.infer<typeof BoardListSchema>;
export type Profile = z.infer<typeof ProfileSchema>;

export function parseProfile(raw: unknown): Profile {
  const r = ProfileSchema.safeParse(raw);
  if (!r.success) {
    throw new Error(`profile.yaml is invalid:\n${r.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  return r.data;
}

// Pure view logic for the Applications / Review / Runs pages: filtering, provenance parsing,
// review grouping, run↔application joining, export. No chrome, no DOM, no signals — so every rule
// here is unit-tested (tests/app-view.test.ts) instead of being eyeballed in a rendered table.

import type { Application, AppliedField } from '@/engine/types';
import type { LogEvent, Run } from '@/engine/records';

/* ---- the record shape we render against ------------------------------------------------- */

/** Where an answer came from. A peer session is adding this to `AppliedField`; until it lands we
 *  recover it from the legacy encoding (a suffix in the value, e.g. "Yes (guessed)"). */
export type FieldSource = 'profile' | 'override' | 'derived' | 'prefilled' | 'coerced' | 'guessed' | 'unanswered';

/** The enrichment the peer is adding to AppliedField. Declared structurally so this file compiles
 *  against today's narrower type and lights up automatically when the richer record lands. */
export interface FieldExtras {
  readonly source?: FieldSource;
  readonly intent?: string;
  readonly options?: readonly string[];
  readonly kind?: string;
  readonly required?: boolean;
  readonly error?: string;
}
export type RichField = AppliedField & FieldExtras;

/** Same idea for the Application record. */
export interface AppExtras {
  readonly log?: readonly string[];
  readonly resume?: string;
  readonly location?: string;
  readonly description?: string;
  readonly capture?: { readonly screenshot?: string; readonly html?: string; readonly label?: string };
  readonly runId?: string;
  readonly siteId?: string;
}
export type RichApp = Application & AppExtras;

/** Mirrors `appKey` in ui/store — duplicated (not imported) because store.ts pulls in chrome + IDB
 *  and this module must stay importable from a plain unit test. Keep the two in step. */
export const keyOf = (a: RichApp): string => `${a.jobId}@${a.at ?? a.date}`;

/** Epoch ms for sorting. `at` is an ISO timestamp; old records only have the yyyy-mm-dd `date`. */
export function appTime(a: RichApp): number {
  const t = Date.parse(a.at ?? a.date);
  return Number.isNaN(t) ? 0 : t;
}

export function newestFirst(apps: readonly RichApp[]): RichApp[] {
  return [...apps].sort((x, y) => appTime(y) - appTime(x));
}

export const dayOf = (a: RichApp): string => (a.at ?? a.date).slice(0, 10);

/* ---- which site a record belongs to ------------------------------------------------------ */

const HOST_SITE: readonly (readonly [RegExp, string])[] = [
  [/instahyre\.com$/i, 'instahyre'],
  [/linkedin\.com$/i, 'linkedin'],
  [/amazon\.jobs$/i, 'amazon'],
  [/datadoghq\.com$/i, 'datadog'],
];

/** Records predate `siteId`; the job URL still says where they came from. Company is the last resort. */
export function siteIdOf(a: RichApp): string {
  if (a.siteId) return a.siteId;
  let host = '';
  try {
    host = new URL(a.url).hostname;
  } catch {
    host = '';
  }
  for (const [re, id] of HOST_SITE) if (re.test(host)) return id;
  return a.company.trim().toLowerCase().replace(/\s+/g, '-') || 'unknown';
}

/* ---- provenance ------------------------------------------------------------------------- */

// The legacy encoding: the content scripts appended the provenance to the display value.
const LEGACY: readonly (readonly [RegExp, FieldSource])[] = [
  [/\s*\(guessed[^)]*\)\s*$/i, 'guessed'],
  [/\s*\(pre-?filled\)\s*$/i, 'prefilled'],
  [/\s*\(coerced[^)]*\)\s*$/i, 'coerced'],
  [/\s*\((?:unanswered|no answer)\)\s*$/i, 'unanswered'],
];

export interface ParsedField {
  readonly id: string;
  readonly label: string;
  /** Value with any legacy provenance suffix stripped, so the table shows the answer alone. */
  readonly value: string;
  readonly source?: FieldSource;
  /** The exact suffix text when it carried detail ("guessed, preflight"), for the badge title. */
  readonly sourceNote?: string;
  readonly intent?: string;
  readonly options?: readonly string[];
  readonly kind?: string;
  readonly required?: boolean;
  readonly error?: string;
}

/** One field → what the table renders. Prefers the explicit `source`; falls back to the suffix. */
export function parseField(f: RichField): ParsedField {
  const base = {
    id: f.id,
    label: f.label,
    ...(f.intent ? { intent: f.intent } : {}),
    ...(f.options ? { options: f.options } : {}),
    ...(f.kind ? { kind: f.kind } : {}),
    ...(f.required === undefined ? {} : { required: f.required }),
    ...(f.error ? { error: f.error } : {}),
  };
  const raw = f.value ?? '';
  if (f.source) return { ...base, value: raw, source: f.source };

  for (const [re, source] of LEGACY) {
    const m = re.exec(raw);
    if (m) return { ...base, value: raw.slice(0, m.index), source, sourceNote: m[0].trim().replace(/^\(|\)$/g, '') };
  }
  // An empty value on a question we were asked = we never answered it.
  if (raw.trim() === '') return { ...base, value: '', source: 'unanswered' };
  return { ...base, value: raw };
}

export function parseFields(a: RichApp): ParsedField[] {
  return ((a.fields ?? []) as readonly RichField[]).map(parseField);
}

export interface AppFlags {
  readonly guessed: number;
  readonly unanswered: number;
  readonly errors: number;
  readonly captures: boolean;
}

export function appFlags(a: RichApp): AppFlags {
  let guessed = 0;
  let unanswered = 0;
  let errors = 0;
  for (const f of parseFields(a)) {
    if (f.source === 'guessed') guessed += 1;
    if (f.source === 'unanswered') unanswered += 1;
    if (f.error) errors += 1;
  }
  return { guessed, unanswered, errors, captures: !!(a.capture?.screenshot ?? a.capture?.html ?? a.screenshot) };
}

/* ---- filtering (Applications page; every field lives in the URL query) -------------------- */

export interface AppFilter {
  readonly site?: string;
  readonly status?: string;
  readonly account?: string;
  readonly from?: string; // yyyy-mm-dd inclusive
  readonly to?: string; // yyyy-mm-dd inclusive
  readonly q?: string;
  readonly flag?: 'guessed' | 'unanswered' | 'errors' | 'captures' | '';
}

function haystack(a: RichApp): string {
  const parts = [a.title, a.company, a.jobId, a.url, a.note ?? '', a.account ?? '', a.location ?? '', a.date];
  for (const f of (a.fields ?? []) as readonly RichField[]) parts.push(f.label, f.value);
  return parts.join('  ').toLowerCase();
}

export function filterApps(apps: readonly RichApp[], f: AppFilter): RichApp[] {
  const q = (f.q ?? '').trim().toLowerCase();
  return apps.filter((a) => {
    if (f.site && siteIdOf(a) !== f.site) return false;
    if (f.status && a.status !== f.status) return false;
    if (f.account && (a.account ?? '') !== f.account) return false;
    const day = dayOf(a);
    if (f.from && day < f.from) return false;
    if (f.to && day > f.to) return false;
    if (f.flag) {
      const flags = appFlags(a);
      if (f.flag === 'captures' ? !flags.captures : flags[f.flag] === 0) return false;
    }
    if (q && !haystack(a).includes(q)) return false;
    return true;
  });
}

/** Distinct values for the filter selects — built from the data so a new site needs no UI change. */
export function facets(apps: readonly RichApp[]): { sites: string[]; accounts: string[] } {
  const sites = new Set<string>();
  const accounts = new Set<string>();
  for (const a of apps) {
    sites.add(siteIdOf(a));
    if (a.account) accounts.add(a.account);
  }
  return { sites: [...sites].sort(), accounts: [...accounts].sort() };
}

/* ---- review: why is this record in my inbox? --------------------------------------------- */

export interface CauseRule {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly re: RegExp;
}

/** One table, in priority order — the first match wins. Exported so the rules are testable rather
 *  than buried in a chain of ifs. Notes come from the content scripts (see greenhouse/amazon/
 *  linkedin .content.ts) and app/runner.ts. */
export const CAUSE_RULES: readonly CauseRule[] = [
  {
    id: 'duplicate',
    label: 'Already applied',
    hint: 'The ATS says this account already has an application for the job.',
    re: /already applied|duplicate/i,
  },
  {
    id: 'unknown_question',
    label: 'Unknown question',
    hint: 'A required question had no answer in the profile. Add one and the next run sails past it.',
    re: /no answer for|could not fill required|unknown question|no confident answer/i,
  },
  {
    id: 'auto_submit',
    label: 'Waiting for your click',
    hint: 'auto_submit is off (or a dry run): the form is filled and parked for you to submit.',
    re: /awaiting your (?:submit|click)|auto_submit is off|dry run|not submitted/i,
  },
  {
    id: 'otp',
    label: 'Email code',
    hint: 'The emailed verification code never arrived or was rejected.',
    re: /\botp\b|verification code|code page|email(?:ed)? code/i,
  },
  {
    id: 'limit',
    label: 'Rate limited',
    hint: 'The site stopped us: a daily cap or an Easy Apply pace pause.',
    re: /limit reach|daily limit|too many|paused easy apply|\bpace\b|throttl/i,
  },
  {
    id: 'login',
    label: 'Login / captcha',
    hint: 'The session was not logged in, or the site asked a human to prove it.',
    re: /log in|login|logged in|sign in|captcha/i,
  },
  {
    id: 'stopped',
    label: 'Stopped',
    hint: 'The run was stopped before this job finished.',
    re: /stopped|cancell?ed|aborted/i,
  },
  {
    id: 'error',
    label: 'Error',
    hint: 'The page did something we could not handle.',
    re: /failed|error|timed out|stalled|exception|did not advance|did not appear|never reached|rejected/i,
  },
];

export const CAUSE_EXTRA: readonly CauseRule[] = [
  { id: 'unanswered', label: 'Left blank', hint: 'Submitted with questions we had no answer for.', re: /(?!)/ },
  { id: 'guessed', label: 'Guessed answers', hint: 'We picked an option without a profile rule. Worth a look.', re: /(?!)/ },
  { id: 'other', label: 'Other', hint: 'No rule matched the note.', re: /(?!)/ },
];

export function causeFromText(text: string): string {
  for (const r of CAUSE_RULES) if (r.re.test(text)) return r.id;
  return 'other';
}

export function causeMeta(id: string): CauseRule {
  return (
    CAUSE_RULES.find((r) => r.id === id) ??
    CAUSE_EXTRA.find((r) => r.id === id) ?? { id, label: id, hint: '', re: /(?!)/ }
  );
}

/** Why this record wants attention. Parked/failed explain themselves in the note; an *applied*
 *  record is here only because an answer was weak. */
export function reviewCause(a: RichApp): string {
  if (a.status === 'parked' || a.status === 'failed') return causeFromText(a.note ?? '');
  const flags = appFlags(a);
  if (flags.unanswered > 0) return 'unanswered';
  if (flags.guessed > 0) return 'guessed';
  return 'other';
}

export function needsReview(a: RichApp): boolean {
  if (a.status === 'parked' || a.status === 'failed') return true;
  const flags = appFlags(a);
  return flags.guessed > 0 || flags.unanswered > 0 || flags.errors > 0;
}

/** The question a park note names, e.g. `No answer for required: "Do you have a visa?"`. */
export function parkedQuestion(note: string | undefined): string | null {
  const m = /"([^"]{2,200})"/.exec(note ?? '');
  return m?.[1] ?? null;
}

export interface CauseGroup {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly items: readonly RichApp[];
  /** Labels that blocked more than one job — the single most useful thing on the page. */
  readonly repeatedQuestions: readonly { readonly label: string; readonly count: number }[];
}

export interface ReviewOptions {
  readonly dismissed?: readonly string[];
  readonly showDismissed?: boolean;
}

/** The Review inbox: everything that needs a human, bucketed by cause, biggest bucket first. */
export function reviewGroups(apps: readonly RichApp[], opts: ReviewOptions = {}): CauseGroup[] {
  const dismissed = new Set(opts.dismissed ?? []);
  const rows = newestFirst(apps).filter((a) => needsReview(a) && (opts.showDismissed || !dismissed.has(keyOf(a))));

  const buckets = new Map<string, RichApp[]>();
  for (const a of rows) {
    const id = reviewCause(a);
    const list = buckets.get(id);
    if (list) list.push(a);
    else buckets.set(id, [a]);
  }

  const groups: CauseGroup[] = [];
  for (const [id, items] of buckets) {
    const counts = new Map<string, number>();
    for (const a of items) {
      const q = parkedQuestion(a.note) ?? parseFields(a).find((f) => f.source === 'unanswered')?.label;
      if (q) counts.set(q, (counts.get(q) ?? 0) + 1);
    }
    const meta = causeMeta(id);
    groups.push({
      id,
      label: meta.label,
      hint: meta.hint,
      items,
      repeatedQuestions: [...counts]
        .filter(([, n]) => n > 1)
        .sort((a, b) => b[1] - a[1])
        .map(([label, count]) => ({ label, count })),
    });
  }
  return groups.sort((a, b) => b.items.length - a.items.length);
}

/** Where "Fix in Profile" should land: an intent has a rule editor, a bare label needs an override. */
export function fixHref(f: ParsedField): { path: string; query: Record<string, string> } {
  return f.intent
    ? { path: '/profile/answers', query: { intent: f.intent } }
    : { path: '/profile/overrides', query: { label: f.label } };
}

/* ---- runs ↔ applications ------------------------------------------------------------------ */

/** Slack around a run's window: a record is stamped when it is *written*, a beat after the attempt. */
export const RUN_WINDOW_SLACK_MS = 2 * 60_000;

/** Which applications belong to a run. Records written since `runId` landed say so outright; older
 *  ones are matched by "same site, inside the run's window" — stated as a fallback in the UI so a
 *  borrowed row is never passed off as certain. */
export function appsForRun(
  apps: readonly RichApp[],
  run: Run,
  opts: { slackMs?: number } = {},
): { readonly items: RichApp[]; readonly exact: boolean } {
  const exact = apps.filter((a) => a.runId === run.runId);
  if (exact.length > 0) return { items: newestFirst(exact), exact: true };

  const slack = opts.slackMs ?? RUN_WINDOW_SLACK_MS;
  const from = run.startedAt - slack;
  const to = (run.endedAt ?? run.heartbeatAt) + slack;
  const items = apps.filter((a) => {
    if (a.runId && a.runId !== run.runId) return false; // claimed by another run
    if (siteIdOf(a) !== run.siteId) return false;
    const t = appTime(a);
    return t >= from && t <= to;
  });
  return { items: newestFirst(items), exact: false };
}

export function runDurationMs(run: Run, now: number): number {
  return Math.max(0, (run.endedAt ?? Math.min(now, run.heartbeatAt + 60_000)) - run.startedAt);
}

/* ---- export ------------------------------------------------------------------------------- */

/** NDJSON: one JSON object per line — greppable, streamable, and diffable, unlike a pretty array. */
export function runNdjson(run: Run, apps: readonly RichApp[], events: readonly LogEvent[]): string {
  const lines = [
    JSON.stringify({ type: 'run', ...run }),
    ...apps.map((a) => JSON.stringify({ type: 'application', ...a })),
    ...events.map((e) => JSON.stringify({ type: 'event', ...e })),
  ];
  return `${lines.join('\n')}\n`;
}

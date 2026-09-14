import { IdentitySchema, ProfileSchema, type Profile } from '@/config/schema';

// Pure editing model for the Profile form. The editor never holds a `Profile` (a half-typed form
// is not a valid Profile); it holds a plain `Draft` and asks ProfileSchema what is wrong with it.
// Everything here is pure data in / pure data out, so it unit-tests without a DOM or chrome.

export type Draft = Record<string, unknown>;

/** Validation issues keyed exactly like zod paths joined with "." — `identity.email`, `accounts.0`. */
export type Errors = Readonly<Record<string, string>>;

/** Mirrors intent-catalog's AnswerShape without importing it, so this stays dependency-free. */
export type DraftShape = 'boolean' | 'text' | 'number' | 'string[]' | 'token' | 'derived';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A draft that renders as an empty form. Deliberately INVALID (name/email/resume are required) —
 *  Save stays disabled until the user has actually filled the minimum in. */
export function emptyDraft(): Draft {
  return {
    identity: { first_name: '', last_name: '', preferred_name: '', email: '', phone: '', country: '', linkedin: '', website: '', city: '' },
    resume: '',
    want: { titles_any: [], titles_none: [], locations: [], seniority: [] },
    answers: {},
    overrides: {},
    on_unknown: 'park',
    auto_submit: false,
    careers: [],
    accounts: [],
  };
}

/** Deep copy of a stored profile, filled out so every control has something to bind to. */
export function toDraft(profile: Profile | null): Draft {
  if (!profile) return emptyDraft();
  const copy = JSON.parse(JSON.stringify(profile)) as Draft;
  return { ...emptyDraft(), ...copy, identity: { ...(emptyDraft()['identity'] as Draft), ...(copy['identity'] as Draft | undefined) } };
}

/** The single validation seam: the same schema the runner parses with, no UI-side rules. */
export function validateDraft(draft: Draft): { profile: Profile | null; errors: Errors } {
  const r = ProfileSchema.safeParse(draft);
  if (r.success) return { profile: r.data, errors: {} };
  const errors: Record<string, string> = {};
  for (const issue of r.error.issues) {
    const key = issue.path.join('.');
    if (errors[key] === undefined) errors[key] = issue.message; // first issue per path wins
  }
  return { profile: null, errors };
}

// ---- dotted paths ----------------------------------------------------------------------------
// Only for FIXED keys (identity.email, want.locations.0). Record keys the user types — answers.*
// and overrides — go through the named helpers below, because a question label contains dots.

export function getAt(draft: Draft, path: string): unknown {
  let node: unknown = draft;
  for (const seg of path.split('.')) {
    if (Array.isArray(node)) node = node[Number(seg)];
    else if (isRecord(node)) node = node[seg];
    else return undefined;
  }
  return node;
}

/** Immutable set. A numeric segment creates/edits an array, anything else an object. */
export function setAt(draft: Draft, path: string, value: unknown): Draft {
  return setSegments(draft, path.split('.'), value) as Draft;
}

function setSegments(node: unknown, segs: readonly string[], value: unknown): unknown {
  const head = segs[0];
  if (head === undefined) return value;
  const rest = segs.slice(1);
  if (/^\d+$/.test(head)) {
    const arr = Array.isArray(node) ? [...(node as unknown[])] : [];
    arr[Number(head)] = setSegments(arr[Number(head)], rest, value);
    return arr;
  }
  const obj: Record<string, unknown> = isRecord(node) ? { ...node } : {};
  obj[head] = setSegments(obj[head], rest, value);
  return obj;
}

/** Immutable delete (array elements are spliced out, not left as holes). */
export function removeAt(draft: Draft, path: string): Draft {
  return removeSegments(draft, path.split('.')) as Draft;
}

function removeSegments(node: unknown, segs: readonly string[]): unknown {
  const head = segs[0];
  if (head === undefined) return node;
  const rest = segs.slice(1);
  if (/^\d+$/.test(head)) {
    if (!Array.isArray(node)) return node;
    const arr = [...(node as unknown[])];
    if (rest.length === 0) arr.splice(Number(head), 1);
    else arr[Number(head)] = removeSegments(arr[Number(head)], rest);
    return arr;
  }
  if (!isRecord(node)) return node;
  const obj = { ...node };
  if (rest.length === 0) delete obj[head];
  else obj[head] = removeSegments(obj[head], rest);
  return obj;
}

// ---- records the user keys themselves --------------------------------------------------------

const record = (draft: Draft, key: 'answers' | 'overrides'): Record<string, unknown> =>
  isRecord(draft[key]) ? (draft[key] as Record<string, unknown>) : {};

/** `undefined` removes the answer — which is what "not set" means to the engine: park/skip/guess. */
export function setAnswer(draft: Draft, key: string, value: unknown): Draft {
  const next = { ...record(draft, 'answers') };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return { ...draft, answers: next };
}

export function answersOf(draft: Draft): Record<string, unknown> {
  return record(draft, 'answers');
}

export function overridesOf(draft: Draft): Record<string, unknown> {
  return record(draft, 'overrides');
}

/** Overrides are keyed by the EXACT question label, so they are rewritten wholesale (a rename is a
 *  delete + insert) and insertion order is preserved — the table must not reshuffle as you type. */
export function setOverrides(draft: Draft, rows: readonly { key: string; value: unknown }[]): Draft {
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (k) out[k] = r.value;
  }
  return { ...draft, overrides: out };
}

// ---- answer values ---------------------------------------------------------------------------

/** Turn what a control produced into the value the schema/engine expects for that question shape.
 *  `undefined` = leave the answer out entirely (the honest way to say "I haven't decided"). */
export function coerceAnswer(shape: DraftShape, raw: unknown): unknown {
  switch (shape) {
    case 'boolean':
      return typeof raw === 'boolean' ? raw : undefined;
    case 'number': {
      if (raw === 'MAX') return 'MAX'; // resolver.ts: only meaningful for answers.years_of_experience
      const s = String(raw ?? '').trim();
      if (!s) return undefined;
      const n = Number(s);
      return Number.isFinite(n) ? n : s; // free-text boxes accept "3 years"; the schema allows a string
    }
    case 'string[]': {
      const list = Array.isArray(raw) ? raw.map((v) => String(v).trim()).filter(Boolean) : splitChips(String(raw ?? ''));
      return list.length ? list : undefined;
    }
    case 'derived':
      return undefined; // locations are resolved from the job + want.locations, never typed
    default: {
      const s = String(raw ?? '').trim();
      return s ? s : undefined;
    }
  }
}

/** "MAX" is honoured by the resolver for years_of_experience ONLY (see engine/resolver.ts) — the
 *  checkbox must not appear anywhere else, or we would promise something the engine ignores. */
export function supportsMax(intentKey: string): boolean {
  return bareAnswerKey(intentKey) === 'years_of_experience';
}

/** Catalog keys may arrive as `answers.foo` (Intent) or `foo` (profile.answers key). Normalize. */
export function bareAnswerKey(key: string): string {
  return key.replace(/^answers\./, '');
}

export function answerToText(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

// ---- chips -----------------------------------------------------------------------------------

/** Comma / newline separated text → list. Pasting "a, b, c" into a chip input should just work. */
export function splitChips(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function addChips(list: readonly string[], text: string): string[] {
  const out = [...list];
  for (const v of splitChips(text)) if (!out.includes(v)) out.push(v);
  return out;
}

export function removeChip(list: readonly string[], index: number): string[] {
  const out = [...list];
  out.splice(index, 1);
  return out;
}

// ---- résumé ----------------------------------------------------------------------------------

export type ResumeKind = 'stored' | 'legacy-path' | 'unset' | 'missing';

/** `profile.resume` is either an IDB résumé id or a legacy path inside the picked folder
 *  ("resume/kuldeep.pdf"). Anything else that isn't a known id is a dangling reference — say so
 *  rather than silently showing nothing. */
export function resumeKind(value: unknown, storedIds: readonly string[]): ResumeKind {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) return 'unset';
  if (storedIds.includes(v)) return 'stored';
  if (v.includes('/') || /\.(pdf|docx?|rtf|txt)$/i.test(v)) return 'legacy-path';
  return 'missing';
}

// ---- misc ------------------------------------------------------------------------------------

/** Deep value equality over plain JSON data — the dirty check. Key order must not count as a
 *  change, so keys are sorted before comparing. */
export function sameData(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

export function isDirty(draft: Draft, baseline: Draft): boolean {
  return !sameData(draft, baseline);
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (isRecord(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export interface FieldSpec {
  readonly key: string;
  readonly label: string;
  readonly type: 'text' | 'email' | 'tel' | 'url';
  readonly required: boolean;
  readonly help?: string;
}

const IDENTITY_LABELS: Record<string, { label: string; type: FieldSpec['type']; help?: string }> = {
  first_name: { label: 'First name', type: 'text' },
  last_name: { label: 'Last name', type: 'text' },
  preferred_name: { label: 'Preferred name', type: 'text', help: 'Blank = first name is used.' },
  email: { label: 'Email', type: 'email' },
  phone: { label: 'Phone', type: 'tel', help: 'With country code, e.g. +91 9416375330.' },
  country: { label: 'Country', type: 'text' },
  city: { label: 'City', type: 'text', help: "LinkedIn's City typeahead and 'current location' questions." },
  linkedin: { label: 'LinkedIn URL', type: 'url' },
  website: { label: 'Website / GitHub', type: 'url' },
};

/** The identity form is GENERATED from the schema, so adding a field to IdentitySchema adds an
 *  input here — no second list to keep in sync. Required-ness is asked of zod, not hardcoded. */
export function identityFields(): FieldSpec[] {
  return Object.entries(IdentitySchema.shape).map(([key, schema]) => {
    const meta = IDENTITY_LABELS[key] ?? { label: humanize(key), type: 'text' as const };
    return {
      key,
      label: meta.label,
      type: meta.type,
      required: !schema.safeParse(undefined).success,
      ...(meta.help ? { help: meta.help } : {}),
    };
  });
}

export function humanize(key: string): string {
  const s = bareAnswerKey(key).replace(/[._]/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** One search box over the answers editor: matches the key, the label and the help text. */
export function matchesSearch(needle: string, ...haystack: readonly (string | undefined)[]): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  return haystack.some((h) => (h ?? '').toLowerCase().includes(q));
}

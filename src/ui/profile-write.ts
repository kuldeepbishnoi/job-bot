import { isNode, isScalar, parseDocument } from 'yaml';
import type { AnswerValue, Profile } from '@/config/schema';
import { intentMeta, type AnswerShape } from '@/engine/intent-catalog';
import { loadStoredProfile, saveProfile } from '@/platform/data/profile-store';
import { getProfileDir } from '@/platform/fs-config';

// Writing ONE answer back into the user's profile, from wherever the console showed the problem —
// the review inbox, a field row in the drawer. The point of the console is that a wrong answer is
// fixed where you find it, so nobody ever opens profile.yaml in an editor again.
//
// There are two places a profile can live and BOTH are kept in step:
//   (a) `profile_v1` in chrome.storage — what the dashboard edits and what a UI-started run uses;
//   (b) `<profile>/profile.yaml` on disk — the hand-maintained file, still the source of truth for
//       a folder-based run (and for the user reading it).
//
// (b) is the delicate one. That file is FULL of comments explaining what each key does, and key
// order is meaningful to the human reading it. `parse()` + `stringify()` would round-trip the data
// and throw every comment away, so we never do that: we edit the YAML *document* — parseDocument →
// doc.setIn(path, value) → String(doc) — which rewrites exactly the one node and leaves every
// comment, blank line and key position untouched. tests/ui-profile-write.test.ts pins that.

/** Which map in profile.yaml an answer belongs in. */
export type AnswerSink = 'answers' | 'overrides';

export interface AnswerTarget {
  readonly sink: AnswerSink;
  /** The map key: the bare intent key (`needs_sponsorship`) or the EXACT question label. */
  readonly key: string;
  /** Path for `doc.setIn` / the stored profile — always `[sink, key]`. */
  readonly path: readonly [AnswerSink, string];
  /** How the location is written out for the user: `answers.needs_sponsorship`. */
  readonly display: string;
  /** Why this sink and not the other — shown next to the control. */
  readonly why: string;
}

const PREFIX = 'answers.';

/**
 * Where a fix should be written. An intent the matcher recognised gets a RULE (`answers.<key>`)
 * that answers every company's phrasing of the same question; a question nothing matched can only
 * be keyed by its exact text (`overrides["…"]`, matched against `label.trim()` in resolver.ts).
 */
export function answerTarget(input: { readonly intent?: string; readonly label: string }): AnswerTarget {
  const intent = (input.intent ?? '').trim();
  if (intent.startsWith(PREFIX)) {
    const key = intent.slice(PREFIX.length);
    return {
      sink: 'answers',
      key,
      path: ['answers', key],
      display: `answers.${key}`,
      why: 'the matcher recognised this question, so the answer is a rule — every site that asks it gets this answer',
    };
  }
  const key = input.label.trim();
  return {
    sink: 'overrides',
    key,
    path: ['overrides', key],
    display: `overrides["${key}"]`,
    why:
      intent && !intent.startsWith(PREFIX)
        ? `this question maps to ${intent}, which is not a profile answer — keying the fix by its exact text instead`
        : 'no intent matched this question, so the fix is keyed by its exact wording (this site only)',
  };
}

/** The shape of control a question wants, from what the record actually says about it. */
export function fieldShape(input: {
  readonly intent?: string;
  readonly kind?: string;
  readonly options?: readonly string[];
  readonly sample?: unknown;
}): AnswerShape {
  const intent = (input.intent ?? '').trim();
  if (intent.startsWith(PREFIX)) return intentMeta(intent, input.sample).shape;
  const kind = (input.kind ?? '').trim();
  if (kind === 'checkbox') return 'boolean';
  if (kind === 'multiselect') return 'string[]';
  if (kind.endsWith('#')) return 'number'; // "text#" = a numeric box
  if (typeof input.sample === 'boolean') return 'boolean';
  if (Array.isArray(input.sample)) return 'string[]';
  return 'text';
}

/** Yes/no offered as two options ("Yes" / "No") is really a boolean question. */
export function looksBooleanOptions(options: readonly string[]): boolean {
  if (options.length !== 2) return false;
  const set = new Set(options.map((o) => o.trim().toLowerCase()));
  return set.has('yes') && set.has('no');
}

/* ---- sink (a): the stored profile --------------------------------------------------------- */

/** Immutable set of one answer/override on a profile. `undefined` removes the key — which is what
 *  "not set" means to the engine (park / skip / guess), not an empty string. */
export function applyAnswer(profile: Profile, target: AnswerTarget, value: AnswerValue | undefined): Profile {
  const map = { ...(target.sink === 'answers' ? profile.answers : profile.overrides) };
  if (value === undefined) delete map[target.key];
  else map[target.key] = value;
  return target.sink === 'answers' ? { ...profile, answers: map } : { ...profile, overrides: map };
}

/* ---- sink (b): profile.yaml, comments intact ---------------------------------------------- */

/**
 * Set (or delete) one key in a YAML document's text, preserving EVERYTHING else about the file:
 * comments, blank lines, key order, quoting style of untouched nodes. This is the whole reason
 * profile.yaml stays hand-editable after the console has written to it.
 */
export function setInYaml(text: string, path: readonly string[], value: AnswerValue | undefined): string {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new Error(`profile.yaml could not be parsed: ${doc.errors[0]!.message}`);
  if (value === undefined) {
    doc.deleteIn(path);
    return print(doc);
  }
  // A value's own comment ("# number -> the bucket containing it") hangs off the value NODE, so
  // replacing the node wholesale would take the explanation with it. Carry the comments — and the
  // quoting style, while the value stays the same JS type — onto the replacement.
  const old = doc.getIn(path, true);
  const next = doc.createNode(value);
  if (isNode(old)) {
    if (old.comment !== undefined) next.comment = old.comment;
    if (old.commentBefore !== undefined) next.commentBefore = old.commentBefore;
    if (old.spaceBefore) next.spaceBefore = old.spaceBefore;
    if (isScalar(old) && isScalar(next) && typeof old.value === typeof value) {
      if (old.type !== undefined) next.type = old.type;
      if (old.format !== undefined) next.format = old.format;
    }
  }
  doc.setIn(path, next);
  return print(doc);
}

/** `String(doc)` with line wrapping off: re-flowing a long URL the user pasted onto two lines is a
 *  diff they never asked for, and profile.yaml is a file they read. */
function print(doc: ReturnType<typeof parseDocument>): string {
  return doc.toString({ lineWidth: 0 });
}

/** Read `<profile>/profile.yaml`, set the key, write it back. Needs the folder's readwrite grant. */
async function writeYamlAnswer(target: AnswerTarget, value: AnswerValue | undefined): Promise<void> {
  const dir = (await getProfileDir('readwrite')) ?? (await requestWrite());
  if (!dir) throw new Error('no profile folder is linked (or write access was not granted)');
  const handle = await dir.getFileHandle('profile.yaml').catch(() => {
    throw new Error('profile.yaml is not in the linked folder');
  });
  const next = setInYaml(await (await handle.getFile()).text(), target.path, value);
  const w = await handle.createWritable();
  await w.write(next);
  await w.close();
}

/** A folder picked with read access only — ask to upgrade it (must be inside a click handler). */
async function requestWrite(): Promise<Awaited<ReturnType<typeof getProfileDir>>> {
  const dir = await getProfileDir('read');
  if (!dir) return null;
  return (await dir.requestPermission({ mode: 'readwrite' })) === 'granted' ? dir : null;
}

/* ---- the one call the UI makes ------------------------------------------------------------- */

export interface SaveAnswerInput {
  /** The question exactly as the form asked it. */
  readonly label: string;
  /** The intent the matcher assigned, when it did (`answers.…`). */
  readonly intent?: string;
  /** `undefined` deletes the answer. */
  readonly value: AnswerValue | undefined;
  /** Also mirror the write into the linked folder's profile.yaml. */
  readonly alsoDisk?: boolean;
}

export interface SaveAnswerResult {
  readonly target: AnswerTarget;
  /** Human names of the sinks actually written, e.g. ['the extension profile', 'profile.yaml']. */
  readonly wrote: readonly string[];
  readonly storedError?: string;
  readonly diskError?: string;
  /** Disk wasn't attempted (or had nothing to write to) — the reason, for the UI to state plainly. */
  readonly diskSkipped?: string;
  readonly ok: boolean;
}

export const STORED_SINK = 'the extension profile';
export const DISK_SINK = 'profile.yaml';

/**
 * Write one answer to every profile the user actually has. Never throws: each sink reports its own
 * outcome, because "saved to the extension but profile.yaml is read-only" is a real state the user
 * must see rather than a silent half-success.
 */
export async function saveAnswer(input: SaveAnswerInput): Promise<SaveAnswerResult> {
  const target = answerTarget(input);
  const wrote: string[] = [];
  let storedError: string | undefined;
  let diskError: string | undefined;
  let diskSkipped: string | undefined;

  try {
    const stored = await loadStoredProfile();
    if (!stored) {
      storedError = 'no profile is saved in the extension yet — import or fill in Profile first';
    } else {
      await saveProfile(applyAnswer(stored.profile, target, input.value), 'ui');
      wrote.push(STORED_SINK);
    }
  } catch (e) {
    storedError = (e as Error).message;
  }

  if (input.alsoDisk) {
    try {
      await writeYamlAnswer(target, input.value);
      wrote.push(DISK_SINK);
    } catch (e) {
      diskError = (e as Error).message;
    }
  } else {
    diskSkipped = 'no profile folder is linked — nothing on disk to update';
  }

  return {
    target,
    wrote,
    ...(storedError ? { storedError } : {}),
    ...(diskError ? { diskError } : {}),
    ...(diskSkipped ? { diskSkipped } : {}),
    ok: wrote.length > 0,
  };
}

/** One sentence for the UI: exactly what was written, where. */
export function describeSave(r: SaveAnswerResult): string {
  if (!r.ok) return `Nothing was written. ${r.storedError ?? r.diskError ?? ''}`.trim();
  return `Saved ${r.target.display} to ${r.wrote.join(' and ')}.`;
}

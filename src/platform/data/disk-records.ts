import type { Application, AppliedField } from '../../engine/types';
import { getProfileDir, readRecordsFile, readCapture } from '../fs-config';

// The full record lives on disk, not in chrome.storage. `store.record()` deliberately strips the
// screenshot, the job description and most of the log line before persisting (a run would blow the
// 10 MB quota otherwise), so the console reads the append-only files under
// <profile>/applications/ to show everything: every question, the résumé used, the captures.
//
// Read-only. The run writes those files (platform/fs-config.ts); this module never does.
// Callable only from an extension page — the directory handle needs a grant the SW cannot hold.

/** One uncertain answer, as `review.jsonl` records it: the "we are not sure" list. */
export interface ReviewLine {
  readonly at: string;
  readonly company: string;
  readonly jobId: string;
  readonly title: string;
  readonly url: string;
  readonly status: string;
  readonly label: string;
  readonly kind?: string;
  readonly intent?: string;
  readonly options?: readonly string[];
  readonly value?: string;
  readonly source?: string;
  readonly error?: string;
}

/** A full application line from `applications.jsonl` — richer than the chrome.storage copy. */
export interface DiskApplication extends Application {
  readonly files?: readonly string[]; // captures/<date>_<jobId>_<status>.{jpg,html}
  readonly fields?: readonly AppliedField[];
}

/** Is a profile folder linked AND still readable? Both matter: a grant can lapse between sessions. */
export async function diskAvailable(): Promise<{ linked: boolean; readable: boolean; folder?: string }> {
  const linked = await getProfileDir('read').then((d) => d !== null).catch(() => false);
  // getProfileDir returns null both when nothing was picked and when the grant lapsed; the console
  // treats either the same way — ask the user to pick the folder again.
  return { linked, readable: linked };
}

/** Ask for read/write access. Must run inside a click handler — Chrome requires the user gesture. */
export async function requestDiskAccess(): Promise<boolean> {
  return (await getProfileDir('readwrite').catch(() => null)) !== null;
}

/** Parse a JSONL body, skipping malformed lines rather than losing the whole file to one bad write. */
export function parseJsonl<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      /* a torn last line from a crash — skip it */
    }
  }
  return out;
}

/** Every application ever written to disk, oldest first. Empty when no folder is linked.
 *  The file is append-only and a job can legitimately appear twice (a parked attempt, then an
 *  applied one), so callers that want "the outcome" should dedupe on jobId + at, last write wins. */
export async function readDiskApplications(): Promise<DiskApplication[]> {
  return parseJsonl<DiskApplication>(await readRecordsFile('applications.jsonl').catch(() => ''));
}

/** Latest line per attempt, newest first — what the Applications page shows. */
export function dedupeDiskApplications(lines: readonly DiskApplication[]): DiskApplication[] {
  const by = new Map<string, DiskApplication>();
  for (const a of lines) by.set(`${a.jobId}@${a.at ?? a.date}`, a); // last write wins
  return [...by.values()].reverse();
}

/** The "not sure" list: one line per guessed / coerced / unanswered / unmatched question. */
export async function readReviewLines(): Promise<ReviewLine[]> {
  return parseJsonl<ReviewLine>(await readRecordsFile('review.jsonl').catch(() => ''));
}

/** Group uncertain answers by question, so one fix can clear every job it blocked. */
export interface ReviewGroup {
  readonly label: string;
  readonly intent?: string;
  readonly kind?: string;
  readonly options: readonly string[];
  readonly sources: readonly string[];
  readonly jobs: readonly ReviewLine[];
  /** The profile key to set, when the matcher recognised the question. */
  readonly profileKey?: string;
}

export function groupReview(lines: readonly ReviewLine[]): ReviewGroup[] {
  const by = new Map<string, ReviewLine[]>();
  for (const l of lines) {
    const key = l.label.trim().toLowerCase();
    const list = by.get(key);
    if (list) list.push(l);
    else by.set(key, [l]);
  }
  const groups: ReviewGroup[] = [];
  for (const jobs of by.values()) {
    const first = jobs[0]!;
    const options = [...new Set(jobs.flatMap((j) => j.options ?? []))];
    const sources = [...new Set(jobs.map((j) => j.source).filter((s): s is string => !!s))];
    groups.push({
      label: first.label,
      ...(first.intent ? { intent: first.intent, profileKey: first.intent.replace(/^answers\./, '') } : {}),
      ...(first.kind ? { kind: first.kind } : {}),
      options,
      sources,
      jobs,
    });
  }
  // Most-blocking question first: that is the one worth answering now.
  return groups.sort((a, b) => b.jobs.length - a.jobs.length);
}

/** A capture file written next to the record (`files[]` on the application line). */
export async function readCaptureFile(path: string): Promise<{ blob: Blob; name: string } | null> {
  const blob = await readCapture(path).catch(() => null);
  if (!blob) return null;
  return { blob, name: path.split('/').filter(Boolean).at(-1) ?? path };
}

/** The complete daily log the run wrote (`log-<date>.txt`), newest lines last. */
export async function readDiskLog(date: string): Promise<string[]> {
  const text = await readRecordsFile(`log-${date}.txt`).catch(() => '');
  return text.split('\n').filter((l) => l.trim());
}

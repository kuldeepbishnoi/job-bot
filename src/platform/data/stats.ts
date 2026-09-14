// Pure helpers over Application[] (+ Run[]) for the dashboard's numbers. No storage, no clock —
// the day is passed in, like engine/stats.ts.
import type { Application } from '../../engine/types';

export interface ReviewGroup {
  cause: string;
  items: Application[]; // newest first
}

/** Parked + failed attempts grouped by WHY, biggest group first. The cause is the note with the
 *  job-specific parts (quoted labels, ids, the detail after ':' / '—') folded away, so "Could not
 *  fill required "X"" and "… "Y"" land in one group. */
export function reviewInbox(apps: readonly Application[]): ReviewGroup[] {
  const groups = new Map<string, Application[]>();
  for (const a of apps) {
    if (a.status !== 'parked' && a.status !== 'failed') continue;
    const cause = causeOf(a);
    const list = groups.get(cause) ?? [];
    list.push(a);
    groups.set(cause, list);
  }
  return [...groups.entries()]
    .map(([cause, items]) => ({ cause, items: items.sort((x, y) => stamp(y).localeCompare(stamp(x))) }))
    .sort((x, y) => y.items.length - x.items.length || x.cause.localeCompare(y.cause));
}

export function causeOf(app: Pick<Application, 'status' | 'note'>): string {
  const note = (app.note ?? '').trim();
  if (!note) return app.status === 'parked' ? 'parked (no note)' : 'failed (no note)';
  const folded = note
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\b\d{5,}\b/g, '#')
    .split(/\s+—\s+|:\s|\s\(/)[0]!
    .trim();
  return folded || note;
}

/** Outcomes per site on one ISO day (yyyy-mm-dd). */
export function bySite(apps: readonly Application[], day: string): Record<string, { applied: number; parked: number; failed: number }> {
  const out: Record<string, { applied: number; parked: number; failed: number }> = {};
  for (const a of apps) {
    if (a.date !== day) continue;
    const row = (out[a.company] ??= { applied: 0, parked: 0, failed: 0 });
    row[a.status]++;
  }
  return out;
}

/** Fields we filled by guessing (on_unknown: guess), across every attempt — the "check these" count. */
export function guessedCount(apps: readonly Application[]): number {
  let n = 0;
  for (const a of apps) for (const f of a.fields ?? []) if (/\(guessed/i.test(f.value)) n++;
  return n;
}

/** Days seen, newest first — the x-axis for a per-day funnel. */
export function daysOf(apps: readonly Application[]): string[] {
  return [...new Set(apps.map((a) => a.date))].sort((a, b) => b.localeCompare(a));
}

const stamp = (a: Application): string => a.at ?? a.date;

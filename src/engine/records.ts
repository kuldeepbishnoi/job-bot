// Observability entities: pure data (no chrome, no DOM). Everything the dashboard shows is one of
// these, or an `Application` (types.ts). Persisted by platform/data/*; produced by the app layer.

/** One run of one site pack, from Start to its end reason. Applications and events point at it. */
export interface Run {
  readonly runId: string;
  readonly siteId: string;
  readonly kind: 'worker' | 'in-page';
  readonly trigger: 'manual' | 'daily' | 'retry' | 'resume';
  readonly account: string;
  readonly startedAt: number; // epoch ms
  readonly endedAt?: number;
  /** Stamped by EVERY step / progress / kick / result. The UI derives alive / stalled / dead from
   *  its age against the pack's own thresholds — never from a spinner. */
  readonly heartbeatAt: number;
  readonly phase: RunPhase;
  /** Waiting on the user (auto_submit off, account rotation…): the exact instruction + which tab. */
  readonly pause?: { readonly reason: string; readonly nextAccount?: string; readonly tabId?: number };
  /** Always set once the run ends: "exhausted (42/42)", "LinkedIn daily limit", "stopped by you"… */
  readonly endReason?: string;
  readonly counts: RunCounts;
  readonly current?: { readonly jobId: string; readonly title: string; readonly step: string; readonly since: number };
  /** What the run was configured with — so a record explains itself later. */
  readonly autoSubmit: boolean;
  readonly onUnknown: 'park' | 'skip' | 'guess';
  readonly resumeName?: string;
  readonly profileRev?: number;
  readonly tabId?: number; // worker tab / in-page tab, if known
  readonly config?: Readonly<Record<string, string>>; // one-line facts: search_url, urls "2/3", page start…
}

export type RunPhase = 'discovering' | 'running' | 'paused' | 'done' | 'stopped' | 'dead';

export interface RunCounts {
  readonly queued: number; // 0 for in-page packs whose queue is the page
  readonly done: number;
  readonly applied: number;
  readonly parked: number;
  readonly failed: number;
  readonly skipped: number;
}

export const EMPTY_COUNTS: RunCounts = { queued: 0, done: 0, applied: 0, parked: 0, failed: 0, skipped: 0 };

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** One structured log event. `dlog(scope, …)` lines become these (level inferred), and the app
 *  layer emits them directly with run/job context. */
export interface LogEvent {
  readonly seq?: number; // assigned by the store (autoIncrement)
  readonly ts: number;
  readonly level: LogLevel;
  readonly origin: 'sw' | 'popup' | 'dashboard' | 'content';
  readonly scope: string; // apply | outcome | login | linkedin | amazon | popup | review …
  readonly siteId?: string;
  readonly runId?: string;
  readonly jobId?: string;
  readonly msg: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/** A page capture attached to an application attempt. Blob lives in IndexedDB only. */
export interface CaptureMeta {
  readonly captureId: string;
  readonly ts: number;
  readonly siteId: string;
  readonly jobId: string;
  readonly runId?: string;
  readonly label: string; // "filled" | "confirmation" | "otp" | "parked" | "failed" | "review" …
  readonly mime: string; // image/png, image/jpeg, text/html
  readonly bytes: number;
}

export interface Capture extends CaptureMeta {
  readonly blob: Blob;
}

/** Résumé variant stored in the extension (uploaded from the dashboard). */
export interface ResumeMeta {
  readonly id: string;
  readonly label: string; // "Backend", "Canada"…
  readonly name: string; // file name, e.g. kuldeep_backend.pdf
  readonly type: string;
  readonly size: number;
  readonly addedAt: number;
}

export interface ResumeFile extends ResumeMeta {
  readonly blob: Blob;
}

/** Derived liveness for the UI, computed from facts only (heartbeat age vs the pack's thresholds). */
export type Health = 'alive' | 'waiting' | 'stalled' | 'dead' | 'ended';

export function runHealth(run: Run, now: number, stallMs: number, deadMs: number): Health {
  if (run.phase === 'done' || run.phase === 'stopped') return 'ended';
  if (run.phase === 'dead') return 'dead';
  if (run.phase === 'paused') return 'waiting';
  const age = now - run.heartbeatAt;
  if (age > deadMs) return 'dead';
  if (age > stallMs) return 'stalled';
  return 'alive';
}

/** Infer a level from a legacy dlog line's text, so old lines light up the same way as new events. */
export function inferLevel(scope: string, text: string): LogLevel {
  if (/FAILED|\berror\b|timed out|stalled|gave up|exception/i.test(text)) return 'error';
  if (/warn|parked|skipped|retry|recover|no answer|guess/i.test(text)) return 'warn';
  if (scope === 'debug' || /^(ping|tick|poll)/i.test(text)) return 'debug';
  return 'info';
}

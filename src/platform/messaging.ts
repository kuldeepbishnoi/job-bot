// Typed message bus. Background orchestrates; the form frame does DOM work;
// the Gmail frame yields the code; the popup starts runs and shows progress.
import type { AppliedField, ApplyStatus, Job } from '../engine/types';
import type { Profile } from '../config/schema';
import type { SerializedFile } from './serialized-file';

// `filled` carries what we actually put in the form back to the orchestrator, for the on-disk record.
export type ApplyOutcome =
  | { status: 'submitted'; filled?: AppliedField[]; note?: string } // note: e.g. "already applied"
  | { status: 'needs_otp'; filled?: AppliedField[] }
  | { status: 'parked'; note: string; filled?: AppliedField[] }
  | { status: 'error'; note: string; filled?: AppliedField[] };

export type OtpOutcome = { status: 'submitted' } | { status: 'ready' } | { status: 'error'; note: string };
/** passport.amazon.jobs login steps (account rotation). 'pending' = navigation in flight, check the tab URL. */
export type LoginOutcome =
  | { status: 'needs_code' }
  | { status: 'captcha' }
  | { status: 'pending' }
  | { status: 'error'; note: string };

import type { Credentials } from './credentials';
export type { Credentials };

export interface LinkedinJob {
  readonly id: string;
  readonly title: string;
  readonly company: string;
  readonly url: string;
}
/** Why a results page stopped: exhausted = every card handled (page on); budget = run cap hit;
 *  limit = LinkedIn's daily Easy Apply cap; halt = auto_submit off, modal left for the user;
 *  stopped = user pressed Stop; error = the loop threw. */
export type LinkedinPageEnd = 'exhausted' | 'budget' | 'limit' | 'halt' | 'stopped' | 'error';

export type Msg =
  // background -> form frame
  | { t: 'ping' } // readiness handshake: is the form content script injected?
  | { t: 'apply'; profile: Profile; job: Job; resume: SerializedFile; autoSubmit: boolean; dryRun?: boolean }
  | { t: 'otp'; code: string; autoSubmit: boolean }
  // background -> passport frame: log this account in (rotation)
  | { t: 'login'; email: string; password: string }
  // background -> gmail frame
  | { t: 'getCode' }
  // popup -> background (profile is loaded in the popup, which has the FS-access gesture)
  | { t: 'run'; siteId: string; profile: Profile; resume: SerializedFile; exclude?: string[]; credentials?: Credentials } // exclude = job ids any account applied to (registry)
  // popup -> background: abandon the current run (queue + alarm + worker tab)
  | { t: 'stop' }
  // popup -> background: the user logged the next account in — continue the paused run
  | { t: 'resume' }
  // popup -> background: Instahyre applies in-page in the user's logged-in tab (no worker window)
  | { t: 'runInstahyre' }
  // background -> instahyre content script: run the in-page apply loop
  | { t: 'instahyre-apply' }
  // instahyre content script -> background: one opportunity applied (records + wakes the SW)
  | { t: 'instahyre-applied'; job: { id: string; title: string; company: string } }
  // instahyre content script -> background: loop finished
  | { t: 'instahyre-done'; applied: number; skipped: number }
  // popup -> background: LinkedIn Easy Apply, in-page in the user's logged-in tab. The profile
  // answers the modal's questions; the résumé is attached only when no card is pre-selected.
  | { t: 'runLinkedin'; profile: Profile; resume: SerializedFile }
  // background -> linkedin content script: apply through every card on the CURRENT results page.
  // `exclude` = job ids already applied/handled (never reopened); `budget` = applies left this run.
  | { t: 'linkedin-apply'; runId: string; profile: Profile; resume: SerializedFile; exclude: string[]; budget: number }
  // background -> linkedin content script: abandon the loop after the current job
  | { t: 'linkedin-stop' }
  // background -> linkedin content script: is a page loop running right now? (re-kick guard)
  | { t: 'linkedin-status' }
  // linkedin content script -> background: one job attempted (applied / parked / failed) — recorded
  | { t: 'linkedin-result'; runId: string; job: LinkedinJob; status: ApplyStatus; note?: string; fields?: AppliedField[] }
  // linkedin content script -> background: cards skipped without an attempt (filtered / applied badge)
  | { t: 'linkedin-handled'; runId: string; ids: string[] }
  // linkedin content script -> background: this page is done; the background pages on or ends the run
  // `pages` = result pages walked in-page (LinkedIn's own pager); `cards` = cards on the last page
  // (0 = LinkedIn showed no results → this search URL is exhausted); `newCards` = unseen ones.
  | { t: 'linkedin-page-done'; runId: string; reason: LinkedinPageEnd; applied: number; skipped: number; cards: number; newCards: number; pages: number; note?: string }
  // background -> popup (broadcast)
  | { t: 'progress'; done: number; total: number; current: string }
  | { t: 'runDone' };

export function send<T = unknown>(msg: Msg): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}
export function sendToTab<T = unknown>(tabId: number, msg: Msg): Promise<T> {
  return chrome.tabs.sendMessage(tabId, msg) as Promise<T>;
}

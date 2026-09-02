// Typed message bus. Background orchestrates; the form frame does DOM work;
// the Gmail frame yields the code; the popup starts runs and shows progress.
import type { AppliedField, Job } from '../engine/types';
import type { Profile } from '../config/schema';
import type { SerializedFile } from './serialized-file';

// `filled` carries what we actually put in the form back to the orchestrator, for the on-disk record.
export type ApplyOutcome =
  | { status: 'submitted'; filled?: AppliedField[]; note?: string } // note: e.g. "already applied"
  | { status: 'needs_otp'; filled?: AppliedField[] }
  | { status: 'parked'; note: string; filled?: AppliedField[] }
  | { status: 'error'; note: string; filled?: AppliedField[] };

export type OtpOutcome = { status: 'submitted' } | { status: 'ready' } | { status: 'error'; note: string };

export type Msg =
  // background -> form frame
  | { t: 'ping' } // readiness handshake: is the form content script injected?
  | { t: 'apply'; profile: Profile; job: Job; resume: SerializedFile; autoSubmit: boolean; dryRun?: boolean }
  | { t: 'otp'; code: string; autoSubmit: boolean }
  // background -> gmail frame
  | { t: 'getCode' }
  // popup -> background (profile is loaded in the popup, which has the FS-access gesture)
  | { t: 'run'; siteId: string; profile: Profile; resume: SerializedFile }
  // popup -> background: abandon the current run (queue + alarm + worker tab)
  | { t: 'stop' }
  // popup -> background: Instahyre applies in-page in the user's logged-in tab (no worker window)
  | { t: 'runInstahyre' }
  // background -> instahyre content script: run the in-page apply loop
  | { t: 'instahyre-apply' }
  // instahyre content script -> background: one opportunity applied (records + wakes the SW)
  | { t: 'instahyre-applied'; job: { id: string; title: string; company: string } }
  // instahyre content script -> background: loop finished
  | { t: 'instahyre-done'; applied: number; skipped: number }
  // background -> popup (broadcast)
  | { t: 'progress'; done: number; total: number; current: string }
  | { t: 'runDone' };

export function send<T = unknown>(msg: Msg): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}
export function sendToTab<T = unknown>(tabId: number, msg: Msg): Promise<T> {
  return chrome.tabs.sendMessage(tabId, msg) as Promise<T>;
}

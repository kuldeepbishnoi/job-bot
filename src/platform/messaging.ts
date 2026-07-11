// Typed message bus. Background orchestrates; the form frame does DOM work;
// the Gmail frame yields the code; the popup starts runs and shows progress.
import type { Job } from '../engine/types';
import type { Profile } from '../config/schema';
import type { SerializedFile } from './serialized-file';

export type ApplyOutcome =
  | { status: 'submitted' }
  | { status: 'needs_otp' }
  | { status: 'parked'; note: string }
  | { status: 'error'; note: string };

export type OtpOutcome = { status: 'submitted' } | { status: 'ready' } | { status: 'error'; note: string };

export type Msg =
  // background -> form frame
  | { t: 'apply'; profile: Profile; job: Job; resume: SerializedFile; autoSubmit: boolean }
  | { t: 'otp'; code: string; autoSubmit: boolean }
  // background -> gmail frame
  | { t: 'getCode' }
  // popup -> background
  | { t: 'run'; siteId: string }
  // background -> popup (broadcast)
  | { t: 'progress'; done: number; total: number; current: string }
  | { t: 'runDone' };

export function send<T = unknown>(msg: Msg): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}
export function sendToTab<T = unknown>(tabId: number, msg: Msg): Promise<T> {
  return chrome.tabs.sendMessage(tabId, msg) as Promise<T>;
}

import type { Profile } from '../config/schema';
import type { SerializedFile } from './serialized-file';

// Hands-off daily runs. The popup (which has the File System Access gesture) loads the profile +
// résumé once and stores them here; a chrome.alarm then re-runs the site every 24h from the
// background, where no user gesture is available. Everything stays in chrome.storage.local.
export const DAILY_ALARM_PREFIX = 'jobbot-daily:';
const KEY_PREFIX = 'daily_schedule:';
const DEFAULT_HOUR = 9; // local time

export interface DailySchedule {
  readonly siteId: string;
  readonly profile: Profile;
  readonly resume: SerializedFile;
  readonly hour: number;
  readonly enabledAt: number; // epoch ms
}

/** Next occurrence of `hour`:00 local time strictly after `now`. Pure; unit-tested. */
export function nextFire(hour: number, now: number): number {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function alarmName(siteId: string): string {
  return `${DAILY_ALARM_PREFIX}${siteId}`;
}

export function siteIdFromAlarm(name: string): string | null {
  return name.startsWith(DAILY_ALARM_PREFIX) ? name.slice(DAILY_ALARM_PREFIX.length) : null;
}

export async function enableDaily(siteId: string, profile: Profile, resume: SerializedFile, hour = DEFAULT_HOUR): Promise<void> {
  const sched: DailySchedule = { siteId, profile, resume, hour, enabledAt: Date.now() };
  await chrome.storage.local.set({ [KEY_PREFIX + siteId]: sched });
  await chrome.alarms.create(alarmName(siteId), { when: nextFire(hour, Date.now()), periodInMinutes: 24 * 60 });
}

export async function disableDaily(siteId: string): Promise<void> {
  await chrome.alarms.clear(alarmName(siteId));
  await chrome.storage.local.remove(KEY_PREFIX + siteId);
}

export async function dailySchedule(siteId: string): Promise<DailySchedule | null> {
  const got = await chrome.storage.local.get(KEY_PREFIX + siteId);
  return (got[KEY_PREFIX + siteId] as DailySchedule | undefined) ?? null;
}

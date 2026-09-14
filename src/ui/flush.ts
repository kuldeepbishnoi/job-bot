import { flushToDisk } from '@/platform/fs-config';
import { allRecords } from '@/platform/store';

// The append-only files under <profile>/applications/ can only be written by a surface that holds
// the folder grant — the service worker never does. The old popup flushed on a 30s timer; it also
// died whenever the worker tab took focus, so records could sit unwritten for a whole run. Both
// extension pages call this now, and the console (which stays open) is the reliable one.

let timer: number | undefined;

export async function flushNow(): Promise<number> {
  try {
    const got = await chrome.storage.local.get('debug_log');
    return await flushToDisk(await allRecords(), (got['debug_log'] as string[] | undefined) ?? []);
  } catch {
    return 0; // no folder linked, or no write grant — the console shows that in Settings
  }
}

export function startFlushing(everyMs = 30_000): void {
  if (timer !== undefined) return;
  void flushNow();
  timer = setInterval(() => void flushNow(), everyMs) as unknown as number;
}

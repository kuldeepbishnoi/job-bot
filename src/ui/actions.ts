import type { SitePack } from '@/sites/packs';
import type { Profile } from '@/config/schema';
import type { SerializedFile } from '@/platform/serialized-file';
import { send } from '@/platform/messaging';
import { resolveRunInputs } from '@/platform/data/profile-store';
import { readRegistry, loadCredentials } from '@/platform/fs-config';
import { requestHosts } from './facts';

// One place that starts and stops a run, whatever the pack. The background still speaks three
// different start messages today (run / runInstahyre / runLinkedin); this adapter hides that from
// every view, so collapsing them into one `start` message later changes only this file.

export interface StartResult {
  readonly ok: boolean;
  readonly error?: string;
}

/** Load profile + résumé the way THIS surface is allowed to: an extension page may fall back to the
 *  picked folder (it has the File System Access gesture); the service worker never can. */
async function inputs(pack: SitePack): Promise<{ profile: Profile; resume: SerializedFile }> {
  const { profile, resume } = await resolveRunInputs({ allowFolder: true });
  if (pack.config?.key === 'linkedin' && !profile.linkedin) {
    throw new Error('LinkedIn needs search URLs — set them in Sites › LinkedIn');
  }
  if (pack.config?.key === 'amazon' && !profile.amazon) {
    throw new Error('Amazon needs a search URL — set it in Sites › Amazon');
  }
  return { profile, resume };
}

/** Start a run. Must be called from a click handler: granting hosts and reading the folder both
 *  need the user gesture, and Chrome drops it across an await of anything else. */
export async function startSite(pack: SitePack): Promise<StartResult> {
  try {
    const granted = await requestHosts(pack.hosts);
    if (!granted) return { ok: false, error: 'site access not granted (chrome://extensions → JobBot → Site access)' };

    if (pack.id === 'instahyre') {
      const res = await send<{ ok: boolean; error?: string }>({ t: 'runInstahyre' });
      return res ?? { ok: false, error: 'no answer from the background' };
    }

    const { profile, resume } = await inputs(pack);

    if (pack.id === 'linkedin') {
      const res = await send<{ ok: boolean; error?: string }>({ t: 'runLinkedin', profile, resume });
      return res ?? { ok: false, error: 'no answer from the background' };
    }

    // Worker-window packs (Greenhouse/Datadog, Amazon): the shared registry keeps every account
    // from repeating a job, and accounts.csv (when present) lets rotation log the next one in.
    const exclude = [...(await readRegistry().catch(() => new Set<string>()))];
    const credentials = await loadCredentials().catch(() => undefined);
    const res = await send<{ ok: boolean; error?: string }>({ t: 'run', siteId: pack.id, profile, resume, exclude, credentials });
    return res ?? { ok: false, error: 'no answer from the background' };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function stopRuns(): Promise<StartResult> {
  try {
    const res = await send<{ ok: boolean; error?: string }>({ t: 'stop' });
    return res ?? { ok: false, error: 'no answer from the background' };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Account rotation parked the run until the next login happened; the user says "go". */
export async function resumeRun(): Promise<StartResult> {
  try {
    const res = await send<{ ok: boolean; error?: string }>({ t: 'resume' });
    return res ?? { ok: false, error: 'no answer from the background' };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function openTab(url: string): Promise<void> {
  await chrome.tabs.create({ url, active: true });
}

export function openDashboard(hash = '/'): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL(`/dashboard.html#${hash}`) });
}

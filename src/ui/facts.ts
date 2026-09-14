import type { SitePack } from '@/sites/packs';
import type { Profile } from '@/config/schema';
import { gmailApiAvailable, getToken } from '@/platform/gmail-api';

// Every indicator the UI shows about readiness is CHECKED here, never assumed. If a check can't be
// made (no permission API, no tabs access), it says "unknown" rather than inventing a tick.

export interface Requirement {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean | null; // null = could not determine
  readonly detail?: string;
  readonly fix?: { readonly label: string; readonly action: 'grantHosts' | 'connectGmail' | 'openUrl' | 'goto'; readonly arg?: string };
}

const originPatterns = (hosts: readonly string[]): string[] => hosts.map((h) => `https://${h}/*`);

export async function hostsGranted(hosts: readonly string[]): Promise<boolean | null> {
  try {
    return await chrome.permissions.contains({ origins: originPatterns(hosts) });
  } catch {
    return null;
  }
}

/** Ask for the pack's hosts. MUST be called from a click handler — Chrome requires the gesture. */
export async function requestHosts(hosts: readonly string[]): Promise<boolean> {
  try {
    return await chrome.permissions.request({ origins: originPatterns(hosts) });
  } catch {
    return false;
  }
}

export async function findTab(urlPrefix: string): Promise<chrome.tabs.Tab | null> {
  try {
    const tabs = await chrome.tabs.query({ url: `${urlPrefix}*` });
    return tabs[0] ?? null;
  } catch {
    return null;
  }
}

/** Alarms actually armed right now — this is how "will this run continue?" is answered honestly. */
export async function armedAlarms(): Promise<chrome.alarms.Alarm[]> {
  try {
    return await chrome.alarms.getAll();
  } catch {
    return [];
  }
}

export async function gmailConnected(): Promise<boolean | null> {
  if (!gmailApiAvailable()) return null;
  try {
    return !!(await getToken(false));
  } catch {
    return false;
  }
}

/** Is the background service worker answering? A dashboard that can't reach it must say so. */
export async function backgroundAlive(): Promise<boolean> {
  try {
    await chrome.runtime.sendMessage({ t: 'ping' });
    return true;
  } catch (e) {
    // "Receiving end does not exist" = nothing listened; the SW itself woke up to tell us that,
    // so the extension is alive. Only a thrown context error means it is genuinely unreachable.
    return /Receiving end does not exist|message port closed/i.test(String((e as Error).message));
  }
}

/** Everything a pack needs before Start can do anything useful. Shown as chips on the site card. */
export async function packRequirements(pack: SitePack, profile: Profile | null, hasResume: boolean): Promise<Requirement[]> {
  const reqs: Requirement[] = [];

  reqs.push({
    id: 'profile',
    label: 'Profile',
    ok: profile !== null,
    detail: profile ? `${profile.identity.first_name} ${profile.identity.last_name}` : 'not set up yet',
    ...(profile ? {} : { fix: { label: 'Set up', action: 'goto' as const, arg: '/profile/identity' } }),
  });

  if (pack.needs.resume) {
    reqs.push({
      id: 'resume',
      label: 'Résumé',
      ok: hasResume,
      detail: hasResume ? undefined : 'no résumé uploaded or linked',
      ...(hasResume ? {} : { fix: { label: 'Upload', action: 'goto' as const, arg: '/profile/resumes' } }),
    });
  }

  const hosts = await hostsGranted(pack.hosts);
  reqs.push({
    id: 'hosts',
    label: 'Site access',
    ok: hosts,
    detail: pack.hosts.join(', '),
    ...(hosts === false ? { fix: { label: 'Grant', action: 'grantHosts' as const } } : {}),
  });

  if (pack.needs.gmail) {
    const gmail = await gmailConnected();
    reqs.push({
      id: 'gmail',
      label: 'Gmail (for the emailed code)',
      ok: gmail,
      detail: gmail === null ? 'OAuth not configured in this build — falls back to scraping an open Gmail tab' : undefined,
      ...(gmail === false ? { fix: { label: 'Connect', action: 'connectGmail' as const } } : {}),
    });
  }

  if (pack.needs.loggedInTab) {
    const tab = await findTab(pack.needs.loggedInTab);
    reqs.push({
      id: 'tab',
      label: 'Logged-in tab',
      ok: tab !== null,
      detail: tab ? (tab.title ?? pack.needs.loggedInTab) : `open ${pack.needs.loggedInTab} and log in`,
      ...(tab ? {} : { fix: { label: 'Open', action: 'openUrl' as const, arg: pack.needs.loggedInTab } }),
    });
  }

  if (pack.config) {
    const block = (profile as unknown as Record<string, unknown> | null)?.[pack.config.key];
    const missing = pack.config.fields.filter((f) => f.required && !(block as Record<string, unknown> | undefined)?.[f.key]);
    reqs.push({
      id: 'config',
      label: 'Site settings',
      ok: block !== undefined && missing.length === 0,
      detail: missing.length ? `missing: ${missing.map((f) => f.label).join(', ')}` : undefined,
      ...(missing.length || !block ? { fix: { label: 'Configure', action: 'goto' as const, arg: `/sites/${pack.id}` } } : {}),
    });
  }

  return reqs;
}

export function allOk(reqs: readonly Requirement[]): boolean {
  // `null` (undeterminable, e.g. Gmail OAuth not built in) does not block a start.
  return reqs.every((r) => r.ok !== false);
}

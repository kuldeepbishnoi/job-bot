import type { Job } from '../engine/types';

// Lever discovery: api.lever.co/v0/postings/<site> is the public JSON behind every jobs.lever.co
// page. The apply form lives at <hostedUrl>/apply (ats/lever.ts).
const API = 'https://api.lever.co/v0/postings';
const CONCURRENCY = 4;

/** Curated Lever sites that answered the public postings API on 2026-09-14 — validated live, not
 *  guessed. Lever's own public customer base skews smaller than Greenhouse's or Ashby's (many
 *  well-known companies that once used Lever have since moved to another ATS or gated their
 *  board), so this list is shorter by nature, not by effort. Plain data — safe to import in a UI. */
export const DEFAULT_LEVER_BOARDS: readonly string[] = [
  'anchorage', 'angellist', 'binance', 'gopuff', 'hive', 'matchgroup', 'nium', 'outreach',
  'palantir', 'spotify', 'toptal', 'zoox',
];

interface RawPosting {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  workplaceType?: string; // "remote" | "hybrid" | "onsite" | "unspecified"
  categories?: { commitment?: string; department?: string; location?: string; team?: string; allLocations?: string[] };
}

/** "zoox" or any jobs.lever.co/zoox/... URL → "zoox". Pure — the dashboard validates with it. */
export function parseBoardRef(ref: string): string | null {
  const s = ref.trim();
  if (!s) return null;
  if (/^[a-z0-9][a-z0-9_.-]*$/i.test(s)) return s.toLowerCase();
  try {
    const url = new URL(s.includes('://') ? s : `https://${s}`);
    if (!/(^|\.)lever\.co$/i.test(url.hostname)) return null;
    const first = url.pathname.split('/').filter(Boolean)[0];
    return first && first !== 'v0' ? first.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function parseLeverLocations(p: RawPosting): string[] {
  const raw = p.categories?.allLocations?.length ? p.categories.allLocations : [p.categories?.location ?? ''];
  const out: string[] = [];
  for (const loc of raw) {
    const city = loc.replace(/\(.*?\)/g, ' ').split(/[,/]/)[0]?.trim();
    if (city && !/^remote$/i.test(city) && !out.includes(city)) out.push(city);
  }
  if ((p.workplaceType === 'remote' || raw.some((l) => /remote/i.test(l))) && !out.includes('Remote')) out.push('Remote');
  return out;
}

export function postingToJob(site: string, p: RawPosting): Job {
  return {
    id: p.id,
    title: p.text,
    team: p.categories?.team ?? '',
    department: p.categories?.department ?? '',
    url: p.applyUrl ?? `${p.hostedUrl.replace(/\/$/, '')}/apply`,
    locations: parseLeverLocations(p),
    seniority: [],
    company: site,
  };
}

export async function discoverLeverSite(site: string, fetchImpl: typeof fetch = fetch): Promise<Job[]> {
  const res = await fetchImpl(`${API}/${encodeURIComponent(site)}?mode=json`);
  if (!res.ok) throw new Error(`lever site "${site}": HTTP ${res.status}`);
  const json = (await res.json()) as RawPosting[] | { ok?: boolean; error?: string };
  if (!Array.isArray(json)) throw new Error(`lever site "${site}": ${(json as { error?: string }).error ?? 'unexpected response'}`);
  return json.map((p) => postingToJob(site, p));
}

export async function discoverLever(
  sites: readonly string[],
  fetchImpl: typeof fetch = fetch,
  log: (msg: string) => void = (m) => console.warn('[jobbot]', m),
): Promise<Job[]> {
  const unique = [...new Set(sites)];
  const jobs: Job[] = [];
  const failures: string[] = [];
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const slice = unique.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(slice.map((s) => discoverLeverSite(s, fetchImpl)));
    results.forEach((r, k) => {
      if (r.status === 'fulfilled') jobs.push(...r.value);
      else {
        failures.push(String((r.reason as Error).message));
        log(`skipping Lever site ${slice[k]}: ${(r.reason as Error).message}`);
      }
    });
  }
  if (unique.length && failures.length === unique.length) throw new Error(`every Lever site failed:\n${failures.join('\n')}`);
  return jobs;
}

export function boardsToWalk(cfg: { boards: readonly string[]; include_defaults: boolean }, defaults: readonly string[] = DEFAULT_LEVER_BOARDS): string[] {
  const own = cfg.boards.map(parseBoardRef).filter((b): b is string => !!b);
  return [...new Set([...(cfg.include_defaults ? defaults : []), ...own])];
}

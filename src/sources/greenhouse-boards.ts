import type { Job } from '../engine/types';

// Generic Greenhouse discovery: every company that uses Greenhouse exposes its board through the
// public Job Board API — one GET per board lists every open job. That is what makes this pack a
// multiplier: N companies for the price of one adapter (the hosted form at
// job-boards.greenhouse.io/<board>/jobs/<id> is the same React form Datadog embeds, so
// ats/greenhouse.ts fills it unchanged).
const API = 'https://boards-api.greenhouse.io/v1/boards';
const HOSTED = 'https://job-boards.greenhouse.io';
const CONCURRENCY = 4; // politeness: a handful of boards at a time, never all at once

/** Curated boards that answered the public Job Board API on 2026-09-14 (all with open jobs at
 *  the time — validated live, not guessed). The user's own profile.greenhouse.boards adds to (or,
 *  with include_defaults:false, replaces) this list. Plain data — safe to import in a UI. */
export const DEFAULT_GREENHOUSE_BOARDS: readonly string[] = [
  'adyen', 'affirm', 'airbnb', 'airtable', 'algolia', 'alloy', 'amplitude', 'anthropic',
  'applovin', 'archer', 'asana', 'astranis', 'attentive', 'axios', 'bitgo', 'bitwarden',
  'braze', 'brex', 'buzzfeed', 'calendly', 'calm', 'cameo', 'carta', 'chime',
  'classpass', 'cloudflare', 'cockroachlabs', 'coinbase', 'consensys', 'contentful', 'coursera', 'current',
  'customerio', 'dashlane', 'databricks', 'datadog', 'discord', 'doximity', 'dremio', 'dropbox',
  'duolingo', 'elastic', 'epicgames', 'faire', 'fastly', 'figma', 'figure', 'fireblocks',
  'fivetran', 'flexport', 'galileo', 'gemini', 'ghost', 'gitlab', 'glossier', 'gocardless',
  'greenhouse', 'gusto', 'handshake', 'hightouch', 'honeycomb', 'hootsuite', 'instacart', 'intercom',
  'iterable', 'justworks', 'kayak', 'klaviyo', 'labelbox', 'lastpass', 'lattice', 'launchdarkly',
  'lucidmotors', 'lyft', 'masterclass', 'mercury', 'mindbody', 'mixpanel', 'mongodb', 'monzo',
  'n26', 'nansen', 'netlify', 'netskope', 'newrelic', 'nextdoor', 'nuro', 'okta',
  'opentable', 'oscar', 'oura', 'pagerduty', 'peloton', 'pendo', 'pinterest', 'planetscale',
  'postman', 'reddit', 'remote', 'riotgames', 'robinhood', 'roblox', 'rocketlab', 'salesloft',
  'samsara', 'scaleai', 'scopely', 'sendbird', 'sigmacomputing', 'singlestore', 'sofi', 'sproutsocial',
  'squarespace', 'starburst', 'stockx', 'stripe', 'sumologic', 'tanium', 'toast', 'tripadvisor',
  'truelayer', 'turing', 'twilio', 'twitch', 'udemy', 'upstart', 'upwork', 'vercel',
  'waymo', 'webflow', 'wise', 'ziprecruiter', 'zscaler',
];

interface RawJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string | null } | null;
  company_name?: string;
  departments?: { name: string }[];
}

/**
 * Normalise what the user typed into a board token. Accepts the token itself ("discord") or any
 * URL on that board:
 *   https://boards.greenhouse.io/discord            https://job-boards.greenhouse.io/discord/jobs/1
 *   https://boards.greenhouse.io/embed/job_board?for=discord   https://x.com/careers?gh_jid=1&for=discord
 * Returns null when nothing board-like can be read out of it. Pure — the dashboard validates with it.
 */
export function parseBoardRef(ref: string): string | null {
  const s = ref.trim();
  if (!s) return null;
  if (/^[a-z0-9][a-z0-9_-]*$/i.test(s)) return s.toLowerCase();
  let url: URL;
  try {
    url = new URL(s.includes('://') ? s : `https://${s}`);
  } catch {
    return null;
  }
  const forParam = url.searchParams.get('for');
  if (forParam && /^[a-z0-9_-]+$/i.test(forParam)) return forParam.toLowerCase();
  if (/(^|\.)greenhouse\.io$/i.test(url.hostname)) {
    const parts = url.pathname.split('/').filter(Boolean);
    // boards-api.greenhouse.io/v1/boards/<token>/jobs — the Job Board API URL CLAUDE.md itself
    // documents as ground truth; without this a pasted API URL silently resolves to "v1".
    if (parts[0] === 'v1' && parts[1] === 'boards' && parts[2]) return parts[2].toLowerCase();
    const first = parts[0];
    if (first && first !== 'embed' && /^[a-z0-9_-]+$/i.test(first)) return first.toLowerCase();
  }
  return null;
}

/**
 * Greenhouse writes one free-text location per job. Seen live: "Dublin", "New York City, NY; San
 * Francisco, CA | New York City, NY", "San Francisco, CA • New York, NY • United States",
 * "San Francisco Bay Area or New York (Remote)", "Hybrid". Split on the separators, keep the
 * city-ish head of each part, and keep the Remote signal.
 */
export function parseLocationName(name: string | null | undefined): string[] {
  if (!name) return [];
  const out: string[] = [];
  for (const raw of name.split(/[;|•·]|\s+or\s+|\s\/\s/i)) {
    const part = raw.replace(/\(.*?\)/g, ' ').trim();
    const city = part.split(',')[0]?.trim();
    if (city && !/^remote$/i.test(city) && !out.includes(city)) out.push(city);
  }
  if (/\bremote\b/i.test(name) && !out.includes('Remote')) out.push('Remote');
  return out;
}

export function rawToJob(board: string, j: RawJob): Job {
  return {
    id: String(j.id),
    title: j.title,
    team: '',
    department: j.departments?.[0]?.name ?? '',
    // Always the hosted page (a known host with the known form), never the company's own site.
    url: `${HOSTED}/${board}/jobs/${j.id}`,
    locations: parseLocationName(j.location?.name),
    seniority: [],
    company: j.company_name || board,
  };
}

/** One board's jobs. Throws on a non-200 (an unknown token is a 404). */
export async function discoverBoard(board: string, fetchImpl: typeof fetch = fetch): Promise<Job[]> {
  const res = await fetchImpl(`${API}/${encodeURIComponent(board)}/jobs`);
  if (!res.ok) throw new Error(`greenhouse board "${board}": HTTP ${res.status}`);
  const json = (await res.json()) as { jobs?: RawJob[] };
  return (json.jobs ?? []).map((j) => rawToJob(board, j));
}

/**
 * Every job across every board, a few boards at a time. One broken board (typo, company moved
 * off Greenhouse) is logged and skipped — it must not sink the other forty. Only when EVERY board
 * fails is the run refused, with the reasons.
 */
export async function discoverGreenhouseBoards(
  boards: readonly string[],
  fetchImpl: typeof fetch = fetch,
  log: (msg: string) => void = (m) => console.warn('[jobbot]', m),
): Promise<Job[]> {
  const unique = [...new Set(boards)];
  const jobs: Job[] = [];
  const failures: string[] = [];
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const slice = unique.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(slice.map((b) => discoverBoard(b, fetchImpl)));
    results.forEach((r, k) => {
      if (r.status === 'fulfilled') jobs.push(...r.value);
      else {
        failures.push(String((r.reason as Error).message));
        log(`skipping board ${slice[k]}: ${(r.reason as Error).message}`);
      }
    });
  }
  if (unique.length && failures.length === unique.length) throw new Error(`every Greenhouse board failed:\n${failures.join('\n')}`);
  return jobs;
}

/** The boards a run walks: the curated defaults (unless switched off) plus the user's own. */
export function boardsToWalk(cfg: { boards: readonly string[]; include_defaults: boolean }, defaults: readonly string[] = DEFAULT_GREENHOUSE_BOARDS): string[] {
  const own = cfg.boards.map(parseBoardRef).filter((b): b is string => !!b);
  return [...new Set([...(cfg.include_defaults ? defaults : []), ...own])];
}

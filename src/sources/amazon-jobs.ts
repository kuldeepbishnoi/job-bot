import type { Job } from '../engine/types';

// amazon.jobs discovery. The search page (`/en/search?…`) is backed by a public JSON endpoint,
// `/en/search.json`, that takes the SAME query string — with one twist verified live: the page
// filters by `country[]=CAN` but the API only honours `normalized_country_code[]=CAN` (the page
// param is silently ignored → 2.6k worldwide hits instead of 175). One paginated query = every
// matching job; each doc carries `id_icims` (the job id in every URL) and its city.
//
// The user pastes their search-page URL (filters applied in the UI) into profile.yaml; this
// module turns it into API pages. No HTML scraping, no clicking through result pages.

export const DEFAULT_SEARCH_URL =
  'https://www.amazon.jobs/en/search?category[]=software-development&country[]=CAN&industry_experience=four_to_six_years&sort=relevant';

const PAGE = 100; // result_limit the API accepts without complaint (verified: offset=100 pages fine)
const MAX_PAGES = 30; // hard stop — 3k jobs is far beyond any sane filter
const APPLY = (id: string) => `https://www.amazon.jobs/applicant/jobs/${id}/apply`;

// Page-only / geo params the API doesn't need (and that the UI leaves empty).
const DROP = new Set(['offset', 'result_limit', 'latitude', 'longitude', 'loc_group_id', 'loc_query', 'base_query', 'city', 'region', 'county', 'query_options', 'distanceType', 'radius']);
const RENAME: Record<string, string> = { 'country[]': 'normalized_country_code[]' };

/** Search-page URL -> the JSON API URL for one page. Pure; unit-tested. */
export function searchApiUrl(searchPageUrl: string, offset: number, limit = PAGE): string {
  const u = new URL(searchPageUrl);
  const out = new URL('https://www.amazon.jobs/en/search.json');
  for (const [k, v] of u.searchParams) {
    if (DROP.has(k)) continue;
    if (k === 'country' && v === '') continue; // the UI's empty `country=` shadow field
    if (v === '') continue;
    out.searchParams.append(RENAME[k] ?? k, v);
  }
  out.searchParams.set('offset', String(offset));
  out.searchParams.set('result_limit', String(limit));
  return out.toString();
}

export interface RawAmazonJob {
  id_icims: string;
  title: string;
  job_category?: string;
  business_category?: string;
  team?: { label?: string | null } | null;
  city?: string;
  normalized_location?: string;
  locations?: string[]; // JSON-encoded {city, normalizedStateName, normalizedCountryCode}
  job_path?: string;
  job_schedule_type?: string;
}

export interface SearchResult {
  hits: number;
  jobs: RawAmazonJob[];
}

/** Every city a posting lists, e.g. ["Toronto"] or ["Vancouver", "Toronto"]. */
export function parseLocations(d: RawAmazonJob): string[] {
  const cities: string[] = [];
  for (const raw of d.locations ?? []) {
    try {
      const city = (JSON.parse(raw) as { city?: string }).city?.trim();
      if (city && !cities.includes(city)) cities.push(city);
    } catch {
      /* not JSON — ignore */
    }
  }
  if (cities.length === 0 && d.city) cities.push(d.city.trim());
  return cities;
}

export function docToJob(d: RawAmazonJob): Job {
  const id = String(d.id_icims);
  return {
    id,
    title: d.title.trim(),
    team: d.team?.label?.replace(/-/g, ' ') ?? '',
    department: d.job_category ?? '',
    url: APPLY(id), // the apply page IS the form; it redirects to /summary?result=duplicate once applied
    locations: parseLocations(d),
    seniority: d.job_schedule_type ? [d.job_schedule_type] : [],
  };
}

/** Parse an already-fetched page (used by tests against the saved fixture). */
export function jobsFromResult(result: SearchResult): Job[] {
  return result.jobs.map(docToJob);
}

async function fetchPage(url: string, fetchImpl: typeof fetch): Promise<SearchResult> {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`amazon.jobs search ${res.status}`);
  const json = (await res.json()) as SearchResult & { error?: string | null };
  if (json.error) throw new Error(`amazon.jobs search: ${json.error}`);
  return json;
}

/** Discover every job matching the search URL. `fetchImpl` is injectable for tests. */
export async function discoverAmazonJobs(searchPageUrl = DEFAULT_SEARCH_URL, fetchImpl: typeof fetch = fetch): Promise<Job[]> {
  const first = await fetchPage(searchApiUrl(searchPageUrl, 0), fetchImpl);
  const pages = Math.min(MAX_PAGES, Math.max(1, Math.ceil(first.hits / PAGE)));
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) => fetchPage(searchApiUrl(searchPageUrl, (i + 1) * PAGE), fetchImpl)),
  );
  const seen = new Set<string>();
  return [first, ...rest].flatMap(jobsFromResult).filter((j) => (seen.has(j.id) ? false : (seen.add(j.id), true)));
}

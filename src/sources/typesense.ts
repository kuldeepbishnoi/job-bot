import type { Job } from '../engine/types';

// Datadog careers is indexed in Typesense. One paginated query = every job.
// Endpoint + public search key are what the careers site itself uses in-browser.
const HOST = 'https://gk6e3zbyuntvc5dap.a1.typesense.net';
const API_KEY = '1Hwq7hntXp211hKvRS3CSI2QSU7w2gFm';
const PER_PAGE = 250; // Typesense max

interface RawDoc {
  job_id: number;
  title: string;
  team?: string;
  department?: string;
  location_string?: string;
  time_type?: string[];
  absolute_url: string;
}

/**
 * Split a location_string into city-ish tokens.
 *   "New York, New York, USA; San Francisco, California, USA" -> ["New York", "San Francisco"]
 *   "Portugal, Remote" -> ["Portugal", "Remote"]   (keep the Remote signal)
 */
export function parseLocations(s: string | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  for (const part of s.split(';')) {
    const city = part.split(',')[0]?.trim();
    if (city) out.push(city);
    if (/\bremote\b/i.test(part) && !/^remote$/i.test(city ?? '')) out.push('Remote');
  }
  return out;
}

export function docToJob(d: RawDoc): Job {
  return {
    id: String(d.job_id),
    title: d.title,
    team: d.team ?? '',
    department: d.department ?? '',
    url: d.absolute_url,
    locations: parseLocations(d.location_string),
    seniority: d.time_type ?? [],
  };
}

interface SearchPage {
  found: number;
  hits: { document: RawDoc }[];
}

function body(page: number) {
  return {
    searches: [
      {
        collection: 'careers_alias',
        preset: 'careers_list_view',
        q: '*',
        filter_by: 'language: en',
        per_page: PER_PAGE,
        page,
      },
    ],
  };
}

async function fetchPage(page: number, fetchImpl: typeof fetch): Promise<SearchPage> {
  const res = await fetchImpl(`${HOST}/multi_search?x-typesense-api-key=${API_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body(page)),
  });
  if (!res.ok) throw new Error(`typesense ${res.status}`);
  const json = (await res.json()) as { results: SearchPage[] };
  const first = json.results[0];
  if (!first) throw new Error('typesense: empty results');
  return first;
}

/** Discover every Datadog job. `fetchImpl` is injectable for tests. */
export async function discoverDatadogJobs(fetchImpl: typeof fetch = fetch): Promise<Job[]> {
  const first = await fetchPage(1, fetchImpl);
  const pages = Math.max(1, Math.ceil(first.found / PER_PAGE));
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) => fetchPage(i + 2, fetchImpl)),
  );
  return [first, ...rest].flatMap((p) => p.hits.map((h) => docToJob(h.document)));
}

/** Parse an already-fetched Typesense result (used by tests against the saved fixture). */
export function jobsFromResult(result: SearchPage): Job[] {
  return result.hits.map((h) => docToJob(h.document));
}

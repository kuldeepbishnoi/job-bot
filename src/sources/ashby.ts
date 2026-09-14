import type { Job } from '../engine/types';

// Ashby discovery: api.ashbyhq.com/posting-api/job-board/<org> is the public JSON behind every
// jobs.ashbyhq.com/<org> page. The apply form lives at <jobUrl>/application (ats/ashby.ts).
const API = 'https://api.ashbyhq.com/posting-api/job-board';
const CONCURRENCY = 4;

/** Curated Ashby boards that answered the public job-board API on 2026-09-14 — validated live,
 *  not guessed. The user's own profile.ashby.boards adds to (or, with include_defaults:false,
 *  replaces) this list. Plain data — safe to import in a UI. */
export const DEFAULT_ASHBY_BOARDS: readonly string[] = [
  '1password', 'abridge', 'alchemy', 'andela', 'anyscale', 'ashby', 'attio', 'baseten',
  'cartesia', 'character', 'clickup', 'cohere', 'cursor', 'decagon', 'docker', 'drata',
  'eightsleep', 'elevenlabs', 'harvey', 'hex', 'inngest', 'langchain', 'linear', 'lovable',
  'magiceden', 'miro', 'modal', 'neon', 'notion', 'openai', 'opensea', 'perplexity',
  'persona', 'pika', 'pinecone', 'posthog', 'railway', 'ramp', 'render', 'replit',
  'resend', 'restate', 'rho', 'runway', 'secureframe', 'sierra', 'snyk', 'suno',
  'supabase', 'temporal', 'vanta', 'warp', 'weaviate', 'whoop', 'writer', 'zapier',
];

interface RawAshbyJob {
  id: string;
  title: string;
  department?: string;
  team?: string;
  location?: string;
  secondaryLocations?: { location?: string }[];
  isListed?: boolean;
  isRemote?: boolean;
  workplaceType?: string;
  jobUrl: string;
  applyUrl?: string;
}

/** "notion" or any jobs.ashbyhq.com/notion/... URL → "notion". Pure — the dashboard validates with it. */
export function parseBoardRef(ref: string): string | null {
  const s = ref.trim();
  if (!s) return null;
  if (/^[a-z0-9][a-z0-9_.-]*$/i.test(s)) return s.toLowerCase();
  try {
    const url = new URL(s.includes('://') ? s : `https://${s}`);
    if (!/(^|\.)ashbyhq\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    const first = parts[0] === 'posting-api' ? parts[2] : parts[0];
    return first ? first.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function parseAshbyLocations(j: RawAshbyJob): string[] {
  const raw = [j.location ?? '', ...(j.secondaryLocations ?? []).map((l) => l.location ?? '')];
  const out: string[] = [];
  for (const loc of raw) {
    const city = loc.replace(/\(.*?\)/g, ' ').split(/[,/]/)[0]?.trim();
    if (city && !/^remote(\s*-\s*)?/i.test(city) && !out.includes(city)) out.push(city);
    // "Remote - European Union" → keep the region too.
    const region = /^remote\s*[-–]\s*(.+)$/i.exec(loc)?.[1]?.trim();
    if (region && !out.includes(region)) out.push(region);
  }
  if ((j.isRemote || j.workplaceType === 'Remote' || raw.some((l) => /remote/i.test(l))) && !out.includes('Remote')) out.push('Remote');
  return out;
}

export function ashbyToJob(org: string, j: RawAshbyJob): Job {
  return {
    id: j.id,
    title: j.title,
    team: j.team ?? '',
    department: j.department ?? '',
    url: j.applyUrl ?? `${j.jobUrl.replace(/\/$/, '')}/application`,
    locations: parseAshbyLocations(j),
    seniority: [],
    company: org,
  };
}

export async function discoverAshbyBoard(org: string, fetchImpl: typeof fetch = fetch): Promise<Job[]> {
  const res = await fetchImpl(`${API}/${encodeURIComponent(org)}`);
  if (!res.ok) throw new Error(`ashby board "${org}": HTTP ${res.status}`);
  const json = (await res.json()) as { jobs?: RawAshbyJob[] };
  return (json.jobs ?? []).filter((j) => j.isListed !== false).map((j) => ashbyToJob(org, j));
}

export async function discoverAshby(
  orgs: readonly string[],
  fetchImpl: typeof fetch = fetch,
  log: (msg: string) => void = (m) => console.warn('[jobbot]', m),
): Promise<Job[]> {
  const unique = [...new Set(orgs)];
  const jobs: Job[] = [];
  const failures: string[] = [];
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const slice = unique.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(slice.map((o) => discoverAshbyBoard(o, fetchImpl)));
    results.forEach((r, k) => {
      if (r.status === 'fulfilled') jobs.push(...r.value);
      else {
        failures.push(String((r.reason as Error).message));
        log(`skipping Ashby board ${slice[k]}: ${(r.reason as Error).message}`);
      }
    });
  }
  if (unique.length && failures.length === unique.length) throw new Error(`every Ashby board failed:\n${failures.join('\n')}`);
  return jobs;
}

export function boardsToWalk(cfg: { boards: readonly string[]; include_defaults: boolean }, defaults: readonly string[] = DEFAULT_ASHBY_BOARDS): string[] {
  const own = cfg.boards.map(parseBoardRef).filter((b): b is string => !!b);
  return [...new Set([...(cfg.include_defaults ? defaults : []), ...own])];
}

// ---------------------------------------------------------------------------------------------
// The application form's question schema. The apply page itself loads it from this same-origin
// GraphQL call (jobs.ashbyhq.com/api/non-user-graphql, op ApiJobPosting) — captured for real in
// fixtures/ashby-form-schema.json. It is the offline oracle for the resolver: title, type,
// required, options and the `path` the DOM tags each field with (data-field-path).
const GQL = 'https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting';
const QUERY =
  'query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) { jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) { id title applicationForm { sections { title fieldEntries { id isRequired field } } } } }';

export interface AshbyFormField {
  readonly path: string; // DOM: [data-field-path=<path>]; "_systemfield_name" | "_systemfield_email" | uuid…
  readonly entryId: string; // radio/checkbox inputs are named after it
  readonly title: string;
  readonly type: string; // String | Email | Phone | Location | File | LongText | Boolean | ValueSelect | MultiValueSelect | Date | …
  readonly required: boolean;
  readonly options: readonly string[]; // ValueSelect / MultiValueSelect labels
}

interface RawSchema {
  data?: { jobPosting?: { applicationForm?: { sections?: { fieldEntries?: { id?: string; isRequired?: boolean; field?: { path?: string; title?: string; type?: string; selectableValues?: { label: string }[]; isDeactivated?: boolean } }[] }[] } } | null };
  errors?: { message: string }[];
}

export function formFieldsFromSchema(json: RawSchema): AshbyFormField[] {
  if (json.errors?.length) throw new Error(`ashby form schema: ${json.errors.map((e) => e.message).join('; ')}`);
  const out: AshbyFormField[] = [];
  for (const s of json.data?.jobPosting?.applicationForm?.sections ?? []) {
    for (const e of s.fieldEntries ?? []) {
      const f = e.field;
      if (!f?.path || f.isDeactivated) continue;
      out.push({
        path: f.path,
        entryId: e.id ?? f.path,
        title: (f.title ?? '').trim(),
        type: f.type ?? 'String',
        required: e.isRequired === true,
        options: (f.selectableValues ?? []).map((v) => v.label),
      });
    }
  }
  return out;
}

/** "https://jobs.ashbyhq.com/<org>/<jobId>/application" → { org, jobId }. */
export function parseApplicationUrl(url: string): { org: string; jobId: string } | null {
  const m = /^https:\/\/jobs\.ashbyhq\.com\/([^/]+)\/([0-9a-f-]{36})(?:\/application)?/i.exec(url);
  return m ? { org: m[1]!, jobId: m[2]! } : null;
}

export async function fetchAshbyForm(org: string, jobId: string, fetchImpl: typeof fetch = fetch): Promise<AshbyFormField[]> {
  const res = await fetchImpl(GQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationName: 'ApiJobPosting', variables: { organizationHostedJobsPageName: org, jobPostingId: jobId }, query: QUERY }),
  });
  if (!res.ok) throw new Error(`ashby form schema: HTTP ${res.status}`);
  return formFieldsFromSchema((await res.json()) as RawSchema);
}

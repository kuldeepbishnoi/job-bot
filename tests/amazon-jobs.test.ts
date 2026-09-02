import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { searchApiUrl, jobsFromResult, discoverAmazonJobs, parseLocations } from '@/sources/amazon-jobs';

const fixture = JSON.parse(readFileSync('fixtures/amazon-search.json', 'utf8'));

// The search-page URL exactly as the browser shows it with the owner's filters applied.
const PAGE_URL =
  'https://www.amazon.jobs/en/search?offset=0&result_limit=10&sort=relevant&category%5B%5D=software-development&country%5B%5D=CAN&distanceType=Mi&radius=24km&industry_experience=four_to_six_years&latitude=&longitude=&loc_group_id=&loc_query=&base_query=&city=&country=&region=&county=&query_options=&';

describe('amazon.jobs discovery', () => {
  it('turns the search-page URL into the JSON API URL (country[] → normalized_country_code[])', () => {
    const u = new URL(searchApiUrl(PAGE_URL, 200));
    expect(u.pathname).toBe('/en/search.json');
    expect(u.searchParams.getAll('normalized_country_code[]')).toEqual(['CAN']); // the param the API honours
    expect(u.searchParams.has('country[]')).toBe(false); // the page param it silently ignores
    expect(u.searchParams.getAll('category[]')).toEqual(['software-development']);
    expect(u.searchParams.get('industry_experience')).toBe('four_to_six_years');
    expect(u.searchParams.get('sort')).toBe('relevant');
    expect(u.searchParams.get('offset')).toBe('200');
    expect(u.searchParams.get('result_limit')).toBe('100');
    for (const dropped of ['latitude', 'city', 'country', 'radius', 'distanceType']) expect(u.searchParams.has(dropped)).toBe(false);
  });

  it('accepts a URL that already uses the API param name', () => {
    const u = new URL(searchApiUrl('https://www.amazon.jobs/en/search?normalized_country_code[]=IND&category[]=software-development', 0));
    expect(u.searchParams.getAll('normalized_country_code[]')).toEqual(['IND']);
  });

  it('maps the real search result into jobs (apply URL, city, icims id)', () => {
    const jobs = jobsFromResult(fixture);
    expect(jobs.length).toBe(10);
    const j = jobs.find((x) => x.id === '10441359')!;
    expect(j.title).toBe('Software Development Engineer, Amazon Customer Service');
    expect(j.url).toBe('https://www.amazon.jobs/applicant/jobs/10441359/apply');
    expect(j.locations).toEqual(['Toronto']);
    expect(j.department).toBe('Software Development');
    for (const job of jobs) expect(job.id).toMatch(/^\d+$/);
  });

  it('reads every city from the locations list, falling back to city', () => {
    expect(parseLocations({ id_icims: '1', title: 't', locations: ['{"city":"Vancouver"}', '{"city":"Toronto"}', '{"city":"Vancouver"}'] })).toEqual(['Vancouver', 'Toronto']);
    expect(parseLocations({ id_icims: '1', title: 't', city: 'Toronto' })).toEqual(['Toronto']);
    expect(parseLocations({ id_icims: '1', title: 't' })).toEqual([]);
  });

  it('pages through the whole result set and dedupes', async () => {
    const calls: string[] = [];
    const page = (offset: number) => ({
      hits: 175,
      jobs: Array.from({ length: offset === 100 ? 75 : 100 }, (_, i) => ({ id_icims: String(offset + i), title: `J${offset + i}`, city: 'Toronto' })),
    });
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      const offset = Number(new URL(url).searchParams.get('offset'));
      return { ok: true, json: async () => page(offset) } as unknown as Response;
    }) as unknown as typeof fetch;
    const jobs = await discoverAmazonJobs(PAGE_URL, fetchImpl);
    expect(calls).toHaveLength(2);
    expect(jobs).toHaveLength(175);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(175);
  });

  it('surfaces an API error instead of an empty queue', async () => {
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ error: 'boom', hits: 0, jobs: [] }) }) as unknown as Response) as unknown as typeof fetch;
    await expect(discoverAmazonJobs(PAGE_URL, fetchImpl)).rejects.toThrow(/boom/);
  });
});

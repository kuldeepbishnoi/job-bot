import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBoardRef, ashbyToJob, parseAshbyLocations, discoverAshby, boardsToWalk, DEFAULT_ASHBY_BOARDS } from '@/sources/ashby';

const board = JSON.parse(readFileSync('fixtures/ashby-board.json', 'utf8')); // real posting-api page (linear)

describe('ashby discovery', () => {
  it('normalises slugs and URLs', () => {
    expect(parseBoardRef('Notion')).toBe('notion');
    expect(parseBoardRef('https://jobs.ashbyhq.com/notion/abc/application')).toBe('notion');
    expect(parseBoardRef('https://api.ashbyhq.com/posting-api/job-board/notion')).toBe('notion');
    expect(parseBoardRef('https://example.com')).toBeNull();
  });

  it('maps a real job onto its application URL with locations and company', () => {
    const j = ashbyToJob('linear', board.jobs[0]);
    expect(j.url).toMatch(/^https:\/\/jobs\.ashbyhq\.com\/linear\/.+\/application$/);
    expect(j.company).toBe('linear');
    expect(j.locations).toContain('Remote');
    expect(j.team).toBe('Engineering');
  });

  it('keeps secondary locations and the region behind "Remote - …"', () => {
    expect(parseAshbyLocations({ id: '1', title: 't', jobUrl: 'u', location: 'Remote - European Union', secondaryLocations: [{ location: 'Spain' }], isRemote: true })).toEqual(['European Union', 'Spain', 'Remote']);
    expect(parseAshbyLocations({ id: '1', title: 't', jobUrl: 'u', location: 'San Francisco, California', secondaryLocations: [{ location: 'New York, New York' }] })).toEqual(['San Francisco', 'New York']);
  });

  it('drops unlisted jobs and survives a broken board', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/linear')) return { ok: true, json: async () => ({ jobs: [...board.jobs, { ...board.jobs[0], id: 'x', isListed: false }] }) } as Response;
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    const jobs = await discoverAshby(['linear', 'nope'], fetchImpl, () => {});
    expect(jobs.length).toBe(board.jobs.length);
    await expect(discoverAshby(['nope'], fetchImpl, () => {})).rejects.toThrow(/every Ashby board failed/);
  });

  it('boardsToWalk honours include_defaults', () => {
    expect(boardsToWalk({ boards: ['acme'], include_defaults: true })).toEqual([...DEFAULT_ASHBY_BOARDS, 'acme']);
  });
});

describe('ashby site refuses to run with nothing configured, rather than silently applying to the curated list', () => {
  it('discover() throws a clear, actionable error when no boards are named and include_defaults is off (#regression)', async () => {
    const { parseProfile } = await import('@/config/schema');
    const { ashby: ashbySite } = await import('@/sites/ashby');
    const p = parseProfile({ identity: { first_name: 'K', last_name: 'B', email: 'k@x.com', phone: '1', country: 'India' }, resume: 'r.pdf' });
    expect(p.ashby).toEqual({ boards: [], include_defaults: false }); // this pack applies — never a silent fan-out
    await expect(ashbySite.discover(p)).rejects.toThrow(/no boards configured.*profile\.ashby\.boards.*include_defaults/);
  });
});

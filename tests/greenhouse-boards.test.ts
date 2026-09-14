import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBoardRef, parseLocationName, rawToJob, discoverGreenhouseBoards, boardsToWalk, DEFAULT_GREENHOUSE_BOARDS } from '@/sources/greenhouse-boards';
import { extract } from '@/ats/greenhouse';
import { withIntent } from '@/engine/matcher';
import { parseProfile } from '@/config/schema';

const board = JSON.parse(readFileSync('fixtures/greenhouse-board.json', 'utf8')); // real boards-api page (discord)

describe('greenhouse boards discovery', () => {
  it('normalises tokens and every URL shape to a board token', () => {
    expect(parseBoardRef('Discord')).toBe('discord');
    expect(parseBoardRef('https://boards.greenhouse.io/discord')).toBe('discord');
    expect(parseBoardRef('https://job-boards.greenhouse.io/discord/jobs/8686353002')).toBe('discord');
    expect(parseBoardRef('https://boards.greenhouse.io/embed/job_board?for=discord')).toBe('discord');
    expect(parseBoardRef('https://stripe.com/jobs/search?gh_jid=1&for=stripe')).toBe('stripe');
    expect(parseBoardRef('https://careers.example.com/')).toBeNull();
    expect(parseBoardRef('not a token!')).toBeNull();
  });

  it('parses the free-text location shapes seen live', () => {
    expect(parseLocationName('Dublin')).toEqual(['Dublin']);
    expect(parseLocationName('New York City, NY; San Francisco, CA | New York City, NY')).toEqual(['New York City', 'San Francisco']);
    expect(parseLocationName('San Francisco, CA • New York, NY • United States')).toEqual(['San Francisco', 'New York', 'United States']);
    expect(parseLocationName('San Francisco Bay Area or New York (Remote)')).toEqual(['San Francisco Bay Area', 'New York', 'Remote']);
    expect(parseLocationName('Remote')).toEqual(['Remote']);
    expect(parseLocationName(null)).toEqual([]);
  });

  it('maps a real board job onto the hosted apply page', () => {
    const j = rawToJob('discord', board.jobs[0]);
    expect(j.id).toBe('8686353002');
    expect(j.url).toBe('https://job-boards.greenhouse.io/discord/jobs/8686353002');
    expect(j.company).toBe('Discord');
    expect(j.locations).toContain('Remote');
  });

  it('skips a broken board and keeps the rest; refuses only when every board fails', async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes('/discord/')) return { ok: true, json: async () => board } as Response;
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    const logs: string[] = [];
    const jobs = await discoverGreenhouseBoards(['discord', 'nope'], fetchImpl, (m) => logs.push(m));
    expect(jobs.length).toBe(board.jobs.length);
    expect(logs).toEqual([expect.stringMatching(/nope.*404/)]);
    await expect(discoverGreenhouseBoards(['nope'], fetchImpl, () => {})).rejects.toThrow(/every Greenhouse board failed/);
  });

  it('boardsToWalk = defaults + own (deduped), or own only', () => {
    expect(boardsToWalk({ boards: ['discord', 'https://boards.greenhouse.io/acme'], include_defaults: true })).toEqual([...DEFAULT_GREENHOUSE_BOARDS, 'acme']);
    expect(boardsToWalk({ boards: ['acme'], include_defaults: false })).toEqual(['acme']);
  });

  it('profile.greenhouse defaults to the curated list so the pack runs without config', () => {
    const p = parseProfile({ identity: { first_name: 'K', last_name: 'B', email: 'k@x.com', phone: '1', country: 'India' }, resume: 'r.pdf' });
    expect(p.greenhouse).toEqual({ boards: [], include_defaults: true });
    expect(boardsToWalk(p.greenhouse)).toEqual([...DEFAULT_GREENHOUSE_BOARDS]);
  });
});

describe('greenhouse hosted job page (real capture) uses the same form as the embed', () => {
  const html = readFileSync('fixtures/greenhouse-hosted-form.html', 'utf8').replace(/<link\b[^>]*>/gi, '').replace(/<script\b[\s\S]*?<\/script>/gi, '');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const fields = extract(doc).map(withIntent);
  const byId = (id: string) => fields.find((f) => f.id === id);

  it('extracts identity, résumé, custom questions and the EEO selects with the existing adapter', () => {
    expect(byId('first_name')?.intent).toBe('identity.first_name');
    expect(byId('resume')?.kind).toBe('file');
    expect(byId('country')?.kind).toBe('select');
    expect(fields.find((f) => /visa sponsorship/i.test(f.label))?.intent).toBe('answers.needs_sponsorship');
    expect(byId('gender')?.intent).toBe('answers.gender');
    expect(byId('veteran_status')?.intent).toBe('answers.veteran_status');
    expect(byId('disability_status')?.intent).toBe('answers.disability');
    expect(doc.querySelector('button[type="submit"]')).not.toBeNull();
  });
});

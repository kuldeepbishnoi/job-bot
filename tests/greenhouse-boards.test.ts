import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBoardRef, parseLocationName, rawToJob, discoverGreenhouseBoards, boardsToWalk, DEFAULT_GREENHOUSE_BOARDS } from '@/sources/greenhouse-boards';
import { extract, confirmed } from '@/ats/greenhouse';
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

  // #regression (2026-09-15): the pack always built job-boards.greenhouse.io/<board>/jobs/<id>.
  // Measured live, ~30% of the curated boards host their own careers page instead, and for every
  // one of those the hosted URL returns 200 with NO form (coinbase 403s) — we would have opened a
  // formless page and failed every job on airbnb, coinbase, brex, asana, stripe and the rest.
  it('uses the company\'s own apply URL when the board does not use the hosted page', () => {
    const own = rawToJob('airbnb', { id: 1, title: 'SWE', absolute_url: 'https://careers.airbnb.com/positions/8184174?gh_jid=8184174' });
    expect(own.url).toBe('https://careers.airbnb.com/positions/8184174?gh_jid=8184174');
  });

  it('keeps the hosted page when that IS where the board applies', () => {
    const hosted = rawToJob('anthropic', { id: 2, title: 'SWE', absolute_url: 'https://job-boards.greenhouse.io/anthropic/jobs/2' });
    expect(hosted.url).toBe('https://job-boards.greenhouse.io/anthropic/jobs/2');
    // …and falls back to it when the API gives us nothing to go on.
    expect(rawToJob('anthropic', { id: 3, title: 'SWE' }).url).toBe('https://job-boards.greenhouse.io/anthropic/jobs/3');
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

  // #regression (2026-09-15): every other test here spreads DEFAULT_GREENHOUSE_BOARDS into its own
  // expectation, so the suite asserted the list equals itself and could not catch a bad entry by
  // construction. A 200 from the board API only proves SOME company owns that slug: `archer` was
  // Archer Veterinary Clinic (a DVM student externship), `wise` was an insurance field-sales org
  // with 19 "Supplemental Sales Agent" posts, `remote` was General Assembly. These name real
  // companies explicitly, so a future sweep cannot quietly re-add a look-alike.
  it('contains the companies it claims to, and none of the look-alikes that were pruned', () => {
    for (const real of ['databricks', 'stripe', 'anthropic', 'datadog', 'cloudflare', 'figma', 'discord', 'reddit', 'coinbase', 'airbnb']) {
      expect(DEFAULT_GREENHOUSE_BOARDS, real).toContain(real);
    }
    for (const lookalike of ['archer', 'wise', 'remote', 'ghost', 'galileo', 'handshake', 'current']) {
      expect(DEFAULT_GREENHOUSE_BOARDS, `${lookalike} is a different company than the name implies`).not.toContain(lookalike);
    }
  });

  it('has no duplicates and no empty entries', () => {
    expect(new Set(DEFAULT_GREENHOUSE_BOARDS).size).toBe(DEFAULT_GREENHOUSE_BOARDS.length);
    expect(DEFAULT_GREENHOUSE_BOARDS.every((b) => b.trim().length > 0)).toBe(true);
    expect(DEFAULT_GREENHOUSE_BOARDS.every((b) => parseBoardRef(b) === b)).toBe(true); // already canonical
  });

  it('boardsToWalk = defaults + own (deduped), or own only', () => {
    expect(boardsToWalk({ boards: ['discord', 'https://boards.greenhouse.io/acme'], include_defaults: true })).toEqual([...DEFAULT_GREENHOUSE_BOARDS, 'acme']);
    expect(boardsToWalk({ boards: ['acme'], include_defaults: false })).toEqual(['acme']);
  });

  // An application cannot be withdrawn, and auto_submit is commonly on. So a profile that never
  // mentions the pack must apply to NOBODY — reaching the curated list has to be a decision.
  it('a profile with no greenhouse block walks no boards at all (#regression)', () => {
    const p = parseProfile({ identity: { first_name: 'K', last_name: 'B', email: 'k@x.com', phone: '1', country: 'India' }, resume: 'r.pdf' });
    expect(p.greenhouse).toEqual({ boards: [], include_defaults: false });
    expect(boardsToWalk(p.greenhouse)).toEqual([]);
  });

  it('the curated list is opt-in, and then it is the whole list', () => {
    const p = parseProfile({
      identity: { first_name: 'K', last_name: 'B', email: 'k@x.com', phone: '1', country: 'India' },
      resume: 'r.pdf',
      greenhouse: { include_defaults: true },
    });
    expect(boardsToWalk(p.greenhouse)).toEqual([...DEFAULT_GREENHOUSE_BOARDS]);
  });
});

describe('greenhouse site refuses to run with nothing configured, rather than silently applying to the curated list', () => {
  it('discover() throws a clear, actionable error when no boards are named and include_defaults is off', async () => {
    const { greenhouse } = await import('@/sites/greenhouse');
    const p = parseProfile({ identity: { first_name: 'K', last_name: 'B', email: 'k@x.com', phone: '1', country: 'India' }, resume: 'r.pdf' });
    await expect(greenhouse.discover(p)).rejects.toThrow(/no boards configured.*profile\.greenhouse\.boards.*include_defaults/);
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

describe('greenhouse confirmed() — the real capture proves the naive text check false-positives', () => {
  const html = readFileSync('fixtures/greenhouse-hosted-form.html', 'utf8').replace(/<link\b[^>]*>/gi, '').replace(/<script\b[\s\S]*?<\/script>/gi, '');

  it('is NOT confirmed on the unsubmitted apply page even though its own prose/JSON say "confirmation"', () => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(extract(doc).length).toBeGreaterThan(0); // sanity: this is the real, unsubmitted form
    expect(confirmed(doc)).toBe(false);
  });

  it('IS confirmed once the app navigates to its own confirmation route', () => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    Object.defineProperty(doc, 'location', { value: { pathname: '/anthropic/jobs/4461450008/confirmation' }, configurable: true });
    expect(confirmed(doc)).toBe(true);
  });

  it('parses the Job Board API URL (boards-api.greenhouse.io/v1/boards/<token>/jobs) too', () => {
    expect(parseBoardRef('https://boards-api.greenhouse.io/v1/boards/discord/jobs?content=false')).toBe('discord');
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseLocations, jobsFromResult } from '@/sources/typesense';

const fixture = JSON.parse(readFileSync('fixtures/typesense-response.json', 'utf8'));

describe('typesense', () => {
  it('parses multi-location strings', () => {
    expect(parseLocations('New York, New York, USA; San Francisco, California, USA')).toEqual(['New York', 'San Francisco']);
    expect(parseLocations('Paris, France')).toEqual(['Paris']);
    expect(parseLocations(undefined)).toEqual([]);
  });

  it('keeps the Remote signal', () => {
    expect(parseLocations('Portugal, Remote')).toEqual(['Portugal', 'Remote']);
    expect(parseLocations('Remote')).toEqual(['Remote']);
  });

  it('maps the real search result into jobs', () => {
    const jobs = jobsFromResult(fixture.results[0]);
    expect(jobs.length).toBeGreaterThan(0);
    const j = jobs[0]!;
    expect(j.id).toMatch(/^\d+$/);
    expect(j.url).toContain('careers.datadoghq.com/detail/');
    expect(j.locations.length).toBeGreaterThan(0);
  });
});

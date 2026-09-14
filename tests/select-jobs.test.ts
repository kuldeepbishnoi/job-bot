import { describe, it, expect } from 'vitest';
import { selectJobs, spreadAcrossEmployers } from '@/engine/select-jobs';
import type { Job } from '@/engine/types';

const mk = (o: Partial<Job>): Job => ({
  id: '1', title: 'x', team: '', department: 'Engineering', url: 'u', locations: [], seniority: [], ...o,
});

describe('selectJobs', () => {
  const jobs = [
    mk({ id: '1', title: 'Software Engineer - Backend', locations: ['Bangalore'], seniority: ['Individual Contributor'] }),
    mk({ id: '2', title: 'Engineering Manager', locations: ['Bangalore'], seniority: ['Manager'] }),
    mk({ id: '3', title: 'Backend Engineer', locations: ['Paris'], seniority: ['Individual Contributor'] }),
    mk({ id: '4', title: 'SDE Intern', locations: ['Remote'], seniority: ['Individual Contributor'] }),
  ];
  const want = { titles_any: ['Engineer', 'SDE'], titles_none: ['Manager', 'Intern'], locations: ['Bangalore', 'Remote'], seniority: ['Individual Contributor'] };

  it('keeps wanted IC roles in wanted locations, drops managers/interns/other cities', () => {
    const ids = selectJobs(jobs, want).map((j) => j.id);
    expect(ids).toEqual(['1']); // 2=manager, 3=Paris, 4=intern
  });
});

describe('spreadAcrossEmployers', () => {
  const j = (id: string, company?: string): Job => ({ id, title: 'SWE', team: '', department: '', url: `https://x/${id}`, locations: [], seniority: [], ...(company ? { company } : {}) });

  it('a capped run reaches many employers instead of emptying the first', () => {
    // 133 boards discovered alphabetically + max_per_run 15 used to mean 15 applications to adyen.
    const jobs = [...Array(20)].map((_, i) => j(`a${i}`, 'adyen')).concat([...Array(20)].map((_, i) => j(`b${i}`, 'affirm')), [...Array(20)].map((_, i) => j(`c${i}`, 'airbnb')));
    const first15 = spreadAcrossEmployers(jobs).slice(0, 15);
    expect(new Set(first15.map((x) => x.company)).size).toBe(3);
    expect(first15.filter((x) => x.company === 'adyen')).toHaveLength(5);
  });

  it('keeps every job, exactly once', () => {
    const jobs = [j('1', 'a'), j('2', 'b'), j('3', 'a'), j('4', 'c'), j('5', 'a')];
    const out = spreadAcrossEmployers(jobs);
    expect(out).toHaveLength(5);
    expect(new Set(out.map((x) => x.id)).size).toBe(5);
  });

  it('preserves each employer\'s own order', () => {
    const jobs = [j('a1', 'a'), j('a2', 'a'), j('b1', 'b')];
    expect(spreadAcrossEmployers(jobs).map((x) => x.id)).toEqual(['a1', 'b1', 'a2']);
  });

  it('leaves a single-company site untouched', () => {
    const jobs = [j('1'), j('2'), j('3')];
    expect(spreadAcrossEmployers(jobs).map((x) => x.id)).toEqual(['1', '2', '3']);
  });
});

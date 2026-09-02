import { describe, it, expect } from 'vitest';
import { selectJobs } from '@/engine/select-jobs';
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

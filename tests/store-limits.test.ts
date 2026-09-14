import { describe, it, expect, beforeEach } from 'vitest';
import { accountsAtLimitToday, appliedTodayCount, getRunState, record, saveRunState } from '@/platform/store';
import type { Application } from '@/engine/types';

// A tiny chrome.storage.local stand-in: the repository is the only thing under test here.
// `quotaJobs` stands in for "how much of the 10 MB budget is left" — a run_state bigger than that
// is rejected the way Chrome rejects one, so the shed-and-retry path is exercised for real.
const mem: Record<string, unknown> = {};
let quotaJobs = Number.POSITIVE_INFINITY;
const setQuota = (n: number): void => {
  quotaJobs = n;
};
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      get: async (k: string | string[]) => {
        const keys = Array.isArray(k) ? k : [k];
        return Object.fromEntries(keys.filter((x) => x in mem).map((x) => [x, mem[x]]));
      },
      set: async (o: Record<string, unknown>) => {
        const run = o['run_state'] as { queue?: unknown[] } | undefined;
        if (run?.queue && run.queue.length > quotaJobs) throw new Error('QUOTA_BYTES quota exceeded');
        Object.assign(mem, o);
      },
    },
  },
};

const today = new Date().toISOString().slice(0, 10);
const app = (company: string, account: string, note: string): Application => ({
  company, jobId: `${company}-${account}-${note}`, title: 't', url: 'u', date: today, status: 'failed', note, account,
});

describe('accountsAtLimitToday is per site', () => {
  beforeEach(() => {
    for (const k of Object.keys(mem)) delete mem[k];
    mem['account'] = 'a@x.com';
  });

  it('an Amazon cap does not exclude the account from another site\'s rotation', async () => {
    await record(app('amazon', 'a@x.com', 'Amazon application limit reached'));
    expect(await accountsAtLimitToday('amazon')).toEqual(new Set(['a@x.com']));
    // Was: the same account was treated as capped everywhere, so a Datadog run skipped it and
    // could end with "every account is at its limit for today" while its quota was untouched.
    expect(await accountsAtLimitToday('datadog')).toEqual(new Set());
    expect(await accountsAtLimitToday('linkedin')).toEqual(new Set());
    expect(await accountsAtLimitToday()).toEqual(new Set(['a@x.com'])); // unfiltered: every site
  });

  it('ignores records from other days and ordinary failures', async () => {
    await record({ ...app('amazon', 'b@x.com', 'form timed out'), date: today });
    await record({ ...app('amazon', 'c@x.com', 'limit reached'), date: '2020-01-01' });
    expect(await accountsAtLimitToday('amazon')).toEqual(new Set());
  });
});

describe('appliedTodayCount is per site', () => {
  beforeEach(() => {
    for (const k of Object.keys(mem)) delete mem[k];
    mem['account'] = 'a@x.com';
  });

  it('counts one site at a time, so another site\'s applications cannot trigger a rotation', async () => {
    for (let i = 0; i < 8; i++) await record({ company: 'linkedin', jobId: `li-${i}`, title: 't', url: 'u', date: today, status: 'applied' });
    for (let i = 0; i < 3; i++) await record({ company: 'amazon', jobId: `az-${i}`, title: 't', url: 'u', date: today, status: 'applied' });
    // per_account_limit is Amazon's 10/day. Counting every site together said 11 and rotated.
    expect(await appliedTodayCount('a@x.com', 'amazon')).toBe(3);
    expect(await appliedTodayCount('a@x.com', 'linkedin')).toBe(8);
    expect(await appliedTodayCount('a@x.com')).toBe(11); // unfiltered: every site
  });
});

describe('saveRunState under a full storage budget', () => {
  const job = (i: number) => ({ id: `j${i}`, title: 't', team: '', department: '', url: 'u', locations: [], seniority: [] });
  const state = (queue: ReturnType<typeof job>[]) =>
    ({ siteId: 'datadog', profile: {} as never, resume: {} as never, queue, cursor: 0 });

  beforeEach(() => {
    for (const k of Object.keys(mem)) delete mem[k];
    setQuota(Number.POSITIVE_INFINITY);
  });

  it('halves the queue and retries rather than failing the run before it starts', async () => {
    // Only a run_state holding ~1000 jobs fits in what is left of this machine's budget.
    setQuota(1000);
    await saveRunState(state(Array.from({ length: 4000 }, (_, i) => job(i))));
    // 4000 -> 2000 -> 1000: the run starts with what fits instead of not starting at all, and the
    // rest is picked up next run because applied ids are excluded.
    expect((await getRunState())?.queue).toHaveLength(1000);
  });

  it('gives up rather than looping when there is nothing left to shed', async () => {
    setQuota(-1); // every write refused, even an empty queue
    await expect(saveRunState(state([]))).rejects.toThrow(/quota/i);
  });
});

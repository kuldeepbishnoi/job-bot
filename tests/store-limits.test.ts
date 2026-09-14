import { describe, it, expect, beforeEach } from 'vitest';
import { accountsAtLimitToday, record } from '@/platform/store';
import type { Application } from '@/engine/types';

// A tiny chrome.storage.local stand-in: the repository is the only thing under test here.
const mem: Record<string, unknown> = {};
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      get: async (k: string | string[]) => {
        const keys = Array.isArray(k) ? k : [k];
        return Object.fromEntries(keys.filter((x) => x in mem).map((x) => [x, mem[x]]));
      },
      set: async (o: Record<string, unknown>) => void Object.assign(mem, o),
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

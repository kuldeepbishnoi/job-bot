import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { installChromeFake, type ChromeFake } from './helpers/chrome-fake';
import { appendEvents, queryEvents, eventCount, clearEvents, legacyLinesToEvents, importLegacyDebugLog, pruneEvents } from '@/platform/data/events';
import type { LogEvent } from '@/engine/records';

let chrome: ChromeFake;
beforeEach(async () => {
  chrome = installChromeFake();
  await clearEvents();
});

const ev = (msg: string, extra: Partial<LogEvent> = {}): LogEvent => ({ ts: 1_700_000_000_000, level: 'info', origin: 'sw', scope: 'apply', msg, ...extra });

describe('events store', () => {
  it('appends in order, assigns seq, and queries newest first', async () => {
    await appendEvents([ev('one'), ev('two'), ev('three')]);
    expect(await eventCount()).toBe(3);
    const got = await queryEvents({});
    expect(got.map((e) => e.msg)).toEqual(['three', 'two', 'one']);
    const top = got[0]!.seq!;
    expect(got.map((e) => e.seq)).toEqual([top, top - 1, top - 2]); // autoIncrement keys survive clear()
  });

  it('filters by run / job / site / minimum level / text, with limit and beforeSeq paging', async () => {
    await appendEvents([
      ev('open job', { runId: 'r1', jobId: '10524143', siteId: 'datadog', level: 'debug' }),
      ev('filled 14', { runId: 'r1', jobId: '10524143', siteId: 'datadog' }),
      ev('parked: no answer', { runId: 'r1', jobId: '10524144', siteId: 'datadog', level: 'warn' }),
      ev('FAILED timeout', { runId: 'r2', jobId: '99', siteId: 'amazon', level: 'error', data: { step: 'submit' } }),
    ]);
    expect((await queryEvents({ runId: 'r1' })).map((e) => e.msg)).toEqual(['parked: no answer', 'filled 14', 'open job']);
    expect((await queryEvents({ jobId: '10524143' })).map((e) => e.msg)).toEqual(['filled 14', 'open job']);
    expect((await queryEvents({ siteId: 'amazon' })).map((e) => e.msg)).toEqual(['FAILED timeout']);
    expect((await queryEvents({ level: 'warn' })).map((e) => e.msg)).toEqual(['FAILED timeout', 'parked: no answer']);
    expect((await queryEvents({ runId: 'r1', level: 'info' })).map((e) => e.msg)).toEqual(['parked: no answer', 'filled 14']);
    expect((await queryEvents({ text: 'SUBMIT' })).map((e) => e.msg)).toEqual(['FAILED timeout']); // searches data too, case-insensitive
    const seqs = (await queryEvents({})).map((e) => e.seq!); // newest first: [s4, s3, s2, s1]
    expect((await queryEvents({ limit: 2 })).map((e) => e.seq)).toEqual(seqs.slice(0, 2));
    expect((await queryEvents({ beforeSeq: seqs[1]! })).map((e) => e.seq)).toEqual(seqs.slice(2));
    expect((await queryEvents({ runId: 'r1', beforeSeq: seqs[2]! })).map((e) => e.seq)).toEqual([seqs[3]]);
  });

  it('prunes the oldest beyond the cap', async () => {
    await appendEvents(Array.from({ length: 12 }, (_, i) => ev(`e${i}`)));
    expect(await pruneEvents(5)).toBe(7);
    expect(await eventCount()).toBe(5);
    expect((await queryEvents({})).map((e) => e.msg)).toEqual(['e11', 'e10', 'e9', 'e8', 'e7']);
    expect(await pruneEvents(5)).toBe(0);
  });

  it('clearEvents empties the store', async () => {
    await appendEvents([ev('x')]);
    await clearEvents();
    expect(await eventCount()).toBe(0);
  });
});

describe('legacy dlog lines', () => {
  it('converts "<iso> <scope> <text>" into events with inferred level, site and job id', () => {
    const [a, b, c, d] = legacyLinesToEvents([
      '2026-09-02T10:14:02.123Z outcome 10524143 applied  filled 14',
      '2026-09-02T10:15:40.001Z linkedin page done {"reason":"limit","applied":3}',
      '2026-09-02T10:16:00.000Z apply [4171828] FAILED: waitFor: timeout',
      'garbage without a timestamp',
    ]);
    expect(a).toMatchObject({ ts: Date.parse('2026-09-02T10:14:02.123Z'), scope: 'outcome', jobId: '10524143', level: 'info', origin: 'sw', msg: '10524143 applied  filled 14' });
    expect(a!.siteId).toBeUndefined();
    expect(b).toMatchObject({ scope: 'linkedin', siteId: 'linkedin', level: 'info' });
    expect(b!.jobId).toBeUndefined();
    expect(c).toMatchObject({ scope: 'apply', jobId: '4171828', level: 'error' });
    expect(d).toMatchObject({ ts: 0, scope: 'legacy', msg: 'garbage without a timestamp' });
  });

  it('importLegacyDebugLog imports once, then only what is new', async () => {
    const l1 = '2026-09-02T10:14:02.123Z outcome 10524143 applied  filled 14';
    const l2 = '2026-09-02T10:14:09.000Z outcome 10524150 parked  no answer for "Salary"';
    const l3 = '2026-09-02T10:14:20.000Z apply next job';
    await chrome.storage.local.set({ debug_log: [l1, l2] });
    expect(await importLegacyDebugLog()).toBe(2);
    expect(await importLegacyDebugLog()).toBe(0); // cursor remembered
    await chrome.storage.local.set({ debug_log: [l1, l2, l3] });
    expect(await importLegacyDebugLog()).toBe(1);
    expect(await eventCount()).toBe(3);
    expect((await queryEvents({ level: 'warn' })).map((e) => e.jobId)).toEqual(['10524150']);
    // The cursor line rotated out of the 400-line buffer → import everything present.
    await chrome.storage.local.set({ debug_log: ['2026-09-02T11:00:00.000Z apply fresh start'] });
    expect(await importLegacyDebugLog()).toBe(1);
  });
});

describe('idb isolation', () => {
  it('uses its own database, never fs-config’s `jobbot`', async () => {
    const { DB_NAME } = await import('@/platform/data/idb');
    expect(DB_NAME).toBe('jobbot-data');
    expect(indexedDB).toBeInstanceOf(IDBFactory);
  });
});

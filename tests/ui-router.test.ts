import { describe, it, expect, beforeEach } from 'vitest';
import { route, go, href, setQuery } from '@/ui/router';
import { runHealth, inferLevel, type Run, EMPTY_COUNTS } from '@/engine/records';

// The router is the console's only navigation primitive, so its parsing is worth pinning:
// a wrong query parse silently drops a filter and the user sees the wrong rows.

describe('hash router', () => {
  beforeEach(() => {
    location.hash = '';
  });

  it('parses path segments and query', () => {
    go('/apps/9101', { status: 'parked', site: 'datadog' });
    expect(route.value.path).toBe('/apps/9101');
    expect(route.value.segments).toEqual(['apps', '9101']);
    expect(route.value.query['status']).toBe('parked');
    expect(route.value.query['site']).toBe('datadog');
  });

  it('drops empty query values instead of writing "key="', () => {
    expect(href('/apps', { status: '', site: 'amazon', account: undefined })).toBe('#/apps?site=amazon');
  });

  it('treats an empty hash as the root route', () => {
    location.hash = '';
    go('/');
    expect(route.value.path).toBe('/');
    expect(route.value.segments).toEqual([]);
  });

  it('setQuery merges and clears without changing the path', () => {
    go('/logs', { level: 'warn' });
    setQuery({ site: 'linkedin' });
    expect(route.value.path).toBe('/logs');
    expect(route.value.query).toEqual({ level: 'warn', site: 'linkedin' });
    setQuery({ level: undefined });
    expect(route.value.query).toEqual({ site: 'linkedin' });
  });

  it('round-trips a value containing spaces and slashes', () => {
    go('/apps', { text: 'Staff SWE / Platform' });
    expect(route.value.query['text']).toBe('Staff SWE / Platform');
  });
});

const run = (patch: Partial<Run>): Run => ({
  runId: 'r1',
  siteId: 'datadog',
  kind: 'worker',
  trigger: 'manual',
  account: '',
  startedAt: 0,
  heartbeatAt: 0,
  phase: 'running',
  counts: EMPTY_COUNTS,
  autoSubmit: false,
  onUnknown: 'guess',
  ...patch,
});

describe('runHealth', () => {
  const STALL = 60_000;
  const DEAD = 600_000;

  it('is alive while the heartbeat is fresh', () => {
    expect(runHealth(run({ heartbeatAt: 1_000 }), 5_000, STALL, DEAD)).toBe('alive');
  });

  it('becomes stalled past the pack threshold, then dead', () => {
    expect(runHealth(run({ heartbeatAt: 0 }), STALL + 1, STALL, DEAD)).toBe('stalled');
    expect(runHealth(run({ heartbeatAt: 0 }), DEAD + 1, STALL, DEAD)).toBe('dead');
  });

  it('waiting on the user is not stalling, however long it takes', () => {
    expect(runHealth(run({ phase: 'paused', heartbeatAt: 0 }), DEAD * 10, STALL, DEAD)).toBe('waiting');
  });

  it('an ended run never reports as dead', () => {
    expect(runHealth(run({ phase: 'done', heartbeatAt: 0 }), DEAD * 5, STALL, DEAD)).toBe('ended');
    expect(runHealth(run({ phase: 'stopped', heartbeatAt: 0 }), DEAD * 5, STALL, DEAD)).toBe('ended');
  });

  it('respects a phase the watchdog already marked dead', () => {
    expect(runHealth(run({ phase: 'dead', heartbeatAt: Date.now() }), Date.now(), STALL, DEAD)).toBe('dead');
  });
});

describe('inferLevel', () => {
  it('finds errors in the legacy log wording', () => {
    expect(inferLevel('apply', 'apply 123 FAILED')).toBe('error');
    expect(inferLevel('linkedin', 'page error: timed out')).toBe('error');
    expect(inferLevel('watchdog', 'run stalled at 3/40 — re-driving')).toBe('error');
  });

  it('flags the park/guess wording as a warning', () => {
    expect(inferLevel('outcome', '9101 parked No answer for required: Salary')).toBe('warn');
    expect(inferLevel('amazon', 'question guessed first option')).toBe('warn');
  });

  it('leaves ordinary progress at info', () => {
    expect(inferLevel('outcome', '9142 applied filled 19')).toBe('info');
  });
});

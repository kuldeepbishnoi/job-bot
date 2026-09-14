import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installChromeFake, type ChromeFake } from './helpers/chrome-fake';
import { dlog, elog, flushLogs, takePendingLines, formatLine, setEventSink, type LogEntry } from '@/platform/debug-log';
import { mirrorLogsToEvents, event as observeEvent, runStarted, runEnded } from '@/app/observe';
import { clearEvents, queryEvents, eventCount } from '@/platform/data/events';

// The flat log everybody already calls (`dlog`) must keep working exactly as before, AND every
// line must reach the structured event store — batched, one write per flush.

let chrome: ChromeFake;
beforeEach(async () => {
  chrome = installChromeFake();
  await clearEvents();
});
afterEach(() => {
  setEventSink(null);
});

/** debug-log decides ONCE, at import, whether it owns the pending list — only the service worker
 *  does, so a content script can't race takePendingLines. Tests that care about the pending list
 *  must therefore import the module with no `window`, the way the worker sees it. */
async function asServiceWorker(): Promise<typeof import('@/platform/debug-log')> {
  const realWindow = globalThis.window;
  // @ts-expect-error — emulating the worker global scope, which has no window
  delete globalThis.window;
  vi.resetModules();
  try {
    return await import('@/platform/debug-log');
  } finally {
    globalThis.window = realWindow;
  }
}

describe('debug log', () => {
  it('still writes the flat line to storage and hands it to takePendingLines', async () => {
    const sw = await asServiceWorker();
    sw.dlog('apply', '4001', { status: 'applied' });
    const pending = await sw.takePendingLines();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z apply 4001 \{"status":"applied"\}$/);
    expect((chrome._data.get('debug_log') as string[])[0]).toBe(pending[0]);
    expect(await sw.takePendingLines()).toEqual([]); // pending list is drained, the history is not
    expect(formatLine('x', ['a', 1])).toMatch(/ x a 1$/);
  });

  it('an extension page logs, but never touches the pending list the worker drains', async () => {
    // happy-dom gives us a window, so this import IS the page case.
    dlog('popup', 'opened');
    await flushLogs();
    expect(chrome._data.get('debug_log')).toHaveLength(1);
    expect(chrome._data.get('debug_log_pending') ?? []).toHaveLength(0);
  });

  it('hands the whole batch to the sink at once, not one write per line', async () => {
    const batches: (readonly LogEntry[])[] = [];
    setEventSink((entries) => void batches.push(entries));
    dlog('linkedin', 'card 1');
    dlog('linkedin', 'card 2');
    dlog('linkedin', 'card 3');
    await flushLogs();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((e) => e.text)).toEqual(['card 1', 'card 2', 'card 3']);
  });

  it('mirrors every dlog line into the event store, inferring the level', async () => {
    mirrorLogsToEvents();
    dlog('outcome', '4001 FAILED: modal never opened');
    dlog('apply', '4002 opened');
    await flushLogs();
    await new Promise((r) => setTimeout(r, 0)); // the mirror write is fire-and-forget

    const events = await queryEvents({});
    expect(events.map((e) => e.level)).toEqual(['info', 'error']); // newest first
    expect(events[1]).toMatchObject({ scope: 'outcome', origin: 'sw' });
  });

  it('elog carries level, data and job context through to the event', async () => {
    mirrorLogsToEvents();
    elog('warn', 'apply', 'no answer for "Years of experience"', { intent: 'answers.years_of_experience' }, { jobId: '4001', siteId: 'linkedin' });
    await flushLogs();
    await new Promise((r) => setTimeout(r, 0));

    const [ev] = await queryEvents({ jobId: '4001' });
    expect(ev).toMatchObject({
      level: 'warn', scope: 'apply', siteId: 'linkedin', jobId: '4001',
      msg: 'no answer for "Years of experience"', data: { intent: 'answers.years_of_experience' },
    });
  });

  it('mirrored lines inherit the active run, so the Logs page can filter by run', async () => {
    mirrorLogsToEvents();
    const runId = await runStarted({ siteId: 'datadog', kind: 'worker', trigger: 'manual', account: '', autoSubmit: false, onUnknown: 'park' });
    dlog('apply', 'something happened');
    await flushLogs();
    await new Promise((r) => setTimeout(r, 0));

    const events = await queryEvents({ runId: runId! });
    expect(events.some((e) => e.msg === 'something happened')).toBe(true);
    await runEnded(runId, 'done', 'test over');
  });

  it('an observe event is written once, not twice, and still reaches the flat log', async () => {
    mirrorLogsToEvents();
    await observeEvent('info', 'run', 'run started on datadog');
    await flushLogs();
    await new Promise((r) => setTimeout(r, 0));

    expect(await eventCount()).toBe(1);
    // The flat log keeps the line too, so the on-disk copy stays complete without a second event.
    expect(((chrome._data.get('debug_log') as string[] | undefined) ?? []).join()).toMatch(/run run started on datadog/);
  });
});

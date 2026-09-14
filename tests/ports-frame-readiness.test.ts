import { describe, it, expect, vi, beforeEach } from 'vitest';

// The 2026-09-14 run lost all 13 Datadog jobs to Chrome's opaque "message channel closed": the
// readiness ping only proved a content script existed, and the Greenhouse embed replaces its
// bootstrap document with the real form moments later. These pin the handshake's MEANING.

const sent: { msg: { t: string } }[] = [];
let replies: (Record<string, unknown> | null)[] = [];
vi.mock('@/platform/messaging', async (orig) => ({
  ...(await orig<typeof import('@/platform/messaging')>()),
  sendToTab: async (_tabId: number, msg: { t: string }) => {
    sent.push({ msg });
    const next = replies.shift();
    if (next === null) throw new Error('Could not establish connection');
    return next ?? { pong: true, ready: true };
  },
}));
vi.mock('@/platform/debug-log', () => ({ dlog: () => {}, elog: () => {}, flatLog: () => {} }));
vi.mock('@/app/observe', () => ({ capture: async () => {}, event: async () => {} }));

const { chromePorts } = await import('@/app/ports');
const site = { id: 'datadog', label: 'Datadog', ats: 'greenhouse' as const, discover: async () => [] };
const job = { id: '4599111', title: 'Senior SWE', team: '', department: '', url: 'u', locations: [], seniority: [] };
const profile = { auto_submit: false } as never;
const resume = { name: 'cv.pdf', type: 'application/pdf', dataBase64: '' };

beforeEach(() => {
  sent.length = 0;
  replies = [];
  (globalThis as unknown as { chrome: unknown }).chrome = { tabs: { get: async () => ({ windowId: 1 }), captureVisibleTab: async () => null }, storage: { local: { get: async () => ({}), remove: async () => {} } } };
});

describe('the apply handshake waits for the FORM, not for any script', () => {
  it('does not send apply into a document that answers but has no form', async () => {
    // bootstrap doc answers "not ready" twice, then the real form arrives
    replies = [{ pong: true, ready: false }, { pong: true, ready: false }, { pong: true, ready: true }, { status: 'submitted' }];
    const out = await chromePorts().apply(site, 1, profile, job, resume);
    expect(out.status).toBe('submitted');
    const applyIndex = sent.findIndex((s) => s.msg.t === 'apply');
    expect(applyIndex).toBe(3); // three pings first — apply went ONLY to the ready document
  });

  it('an older script that does not report readiness still works', async () => {
    replies = [{ pong: true }, { status: 'submitted' }]; // ready === undefined
    const out = await chromePorts().apply(site, 1, profile, job, resume);
    expect(out.status).toBe('submitted');
  });

  it('names what was missing instead of "never became ready" when the page answered', async () => {
    // The wait is 30 polls × 500ms of real time; fake timers keep the test instant.
    vi.useFakeTimers();
    try {
      replies = Array.from({ length: 40 }, () => ({ pong: true, ready: false }));
      const p = chromePorts().apply(site, 1, profile, job, resume);
      const assertion = expect(p).rejects.toThrow(/form was not there/);
      await vi.advanceTimersByTimeAsync(30 * 500 + 100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a document replaced mid-apply is recovered, not lost', () => {
  it('refills the new form when the port closes and nothing was submitted', async () => {
    replies = [{ pong: true, ready: true }, null, { pong: true, ready: true }, { pong: true, ready: true, confirmed: false }, { status: 'submitted', filled: [] }];
    const out = await chromePorts().apply(site, 1, profile, job, resume);
    expect(out.status).toBe('submitted');
    expect(sent.filter((s) => s.msg.t === 'apply')).toHaveLength(2); // original + one retry
  });

  it('does NOT retry when the form says it was already submitted', async () => {
    replies = [{ pong: true, ready: true }, null, { pong: true, ready: true }, { pong: true, ready: true, confirmed: true }];
    const out = await chromePorts().apply(site, 1, profile, job, resume);
    expect(out.status).toBe('submitted');
    expect(sent.filter((s) => s.msg.t === 'apply')).toHaveLength(1); // never applied twice
  });
});

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { putCapture, putDataUrlCapture, listCaptures, getCapture, captureUsage, deleteCapture, pruneCaptures } from '@/platform/data/captures';

const png = (n: number) => new Blob([new Uint8Array(n).fill(7)], { type: 'image/png' });

beforeEach(async () => {
  for (const c of await listCaptures({ limit: 1000 })) await deleteCapture(c.captureId);
});

describe('captures', () => {
  it('stores a blob with its meta and reads it back', async () => {
    const meta = await putCapture({ siteId: 'datadog', jobId: '10524143', runId: 'r1', label: 'filled', blob: png(10) });
    expect(meta).toMatchObject({ siteId: 'datadog', jobId: '10524143', runId: 'r1', label: 'filled', mime: 'image/png', bytes: 10 });
    expect(meta.captureId).toBe(`10524143-${meta.ts}`);
    const got = await getCapture(meta.captureId);
    expect(got?.blob.size).toBe(10);
    expect(got?.blob.type).toBe('image/png');
    expect(new Uint8Array(await got!.blob.arrayBuffer())[0]).toBe(7);
    expect(await getCapture('missing')).toBeNull();
  });

  it('decodes a data URL', async () => {
    const meta = await putDataUrlCapture({ siteId: 'amazon', jobId: '99', label: 'confirmation', dataUrl: 'data:text/html;base64,' + btoa('<b>ok</b>') });
    expect(meta).toMatchObject({ mime: 'text/html', bytes: 9 });
    expect(await (await getCapture(meta.captureId))!.blob.text()).toBe('<b>ok</b>');
  });

  it('lists newest first, by job or run, with limit', async () => {
    const a = await putCapture({ siteId: 's', jobId: 'j1', runId: 'r1', label: 'a', blob: png(1) });
    await new Promise((r) => setTimeout(r, 2)); // distinct ts → distinct ids
    const b = await putCapture({ siteId: 's', jobId: 'j2', runId: 'r1', label: 'b', blob: png(1) });
    await new Promise((r) => setTimeout(r, 2));
    const c = await putCapture({ siteId: 's', jobId: 'j1', runId: 'r2', label: 'c', blob: png(1) });
    expect((await listCaptures({})).map((m) => m.label)).toEqual(['c', 'b', 'a']);
    expect((await listCaptures({ jobId: 'j1' })).map((m) => m.label)).toEqual(['c', 'a']);
    expect((await listCaptures({ runId: 'r1' })).map((m) => m.label)).toEqual(['b', 'a']);
    expect((await listCaptures({ limit: 1 })).map((m) => m.captureId)).toEqual([c.captureId]);
    expect([a, b, c].every((m) => m.captureId)).toBe(true);
  });

  it('tracks usage, deletes meta + bytes together', async () => {
    const m = await putCapture({ siteId: 's', jobId: 'j', label: 'x', blob: png(100) });
    await putCapture({ siteId: 's', jobId: 'k', label: 'y', blob: png(50) });
    expect(await captureUsage()).toEqual({ count: 2, bytes: 150 });
    await deleteCapture(m.captureId);
    expect(await captureUsage()).toEqual({ count: 1, bytes: 50 });
    expect(await getCapture(m.captureId)).toBeNull();
  });

  it('evicts the oldest until under the byte cap (LRU by ts)', async () => {
    for (const [i, label] of ['old', 'mid', 'new'].entries()) {
      await putCapture({ siteId: 's', jobId: `j${i}`, label, blob: png(100) });
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(await pruneCaptures(250)).toBe(1); // 300 > 250 → drop one
    expect((await listCaptures({})).map((m) => m.label)).toEqual(['new', 'mid']);
    expect(await pruneCaptures(100)).toBe(1);
    expect((await listCaptures({})).map((m) => m.label)).toEqual(['new']);
    expect(await captureUsage()).toEqual({ count: 1, bytes: 100 });
    expect(await pruneCaptures(100)).toBe(0);
  });
});

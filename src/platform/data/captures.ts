// Page captures (screenshots / HTML) per application attempt. Metas and bytes sit in two stores:
// listing and LRU pruning read metas only, so a 300 MB store never gets pulled into memory.
// Bytes are stored as ArrayBuffer (structured-clone safe everywhere); the Blob is rebuilt on read.
import type { Capture, CaptureMeta } from '../../engine/records';
import { STORE, changes, multiTx, req, tx, walk } from './idb';

export const CAPTURE_CAP_BYTES = 300 * 1024 * 1024;
const DEFAULT_LIMIT = 100;

interface BlobRow {
  captureId: string;
  data: ArrayBuffer;
}

export async function putCapture(c: { siteId: string; jobId: string; runId?: string; label: string; blob: Blob }): Promise<CaptureMeta> {
  const ts = Date.now();
  const meta: CaptureMeta = {
    captureId: `${c.jobId}-${ts}`,
    ts,
    siteId: c.siteId,
    jobId: c.jobId,
    ...(c.runId ? { runId: c.runId } : {}),
    label: c.label,
    mime: c.blob.type || 'application/octet-stream',
    bytes: c.blob.size,
  };
  const data = await c.blob.arrayBuffer();
  await multiTx([STORE.captures, STORE.captureBlobs], 'readwrite', async (t) => {
    await req(t.objectStore(STORE.captures).put(meta));
    await req(t.objectStore(STORE.captureBlobs).put({ captureId: meta.captureId, data } satisfies BlobRow));
  });
  await pruneCaptures();
  changes.emit('captures');
  return meta;
}

export function putDataUrlCapture(c: { siteId: string; jobId: string; runId?: string; label: string; dataUrl: string }): Promise<CaptureMeta> {
  const { dataUrl, ...rest } = c;
  return putCapture({ ...rest, blob: dataUrlToBlob(dataUrl) });
}

/** Newest first. */
export async function listCaptures(q: { jobId?: string; runId?: string; limit?: number }): Promise<CaptureMeta[]> {
  const limit = q.limit ?? DEFAULT_LIMIT;
  const out: CaptureMeta[] = [];
  await tx(STORE.captures, 'readonly', (s) => {
    const [source, range]: [IDBObjectStore | IDBIndex, IDBKeyRange | null] = q.jobId
      ? [s.index('jobId'), IDBKeyRange.only(q.jobId)]
      : q.runId
        ? [s.index('runId'), IDBKeyRange.only(q.runId)]
        : [s.index('ts'), null];
    return walk(source, range, 'prev', (c) => {
      const m = c.value as CaptureMeta;
      if (q.runId && m.runId !== q.runId) return true;
      out.push(m);
      return out.length < limit;
    });
  });
  // The jobId/runId indexes order by primary key (captureId = `${jobId}-${ts}`), not by time.
  return out.sort((a, b) => b.ts - a.ts);
}

export async function getCapture(captureId: string): Promise<Capture | null> {
  return multiTx([STORE.captures, STORE.captureBlobs], 'readonly', async (t) => {
    const meta = (await req(t.objectStore(STORE.captures).get(captureId))) as CaptureMeta | undefined;
    const row = (await req(t.objectStore(STORE.captureBlobs).get(captureId))) as BlobRow | undefined;
    if (!meta || !row) return null;
    return { ...meta, blob: new Blob([row.data], { type: meta.mime }) };
  });
}

export async function captureUsage(): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  await tx(STORE.captures, 'readonly', (s) =>
    walk(s, null, 'next', (c) => {
      count++;
      bytes += (c.value as CaptureMeta).bytes;
    }),
  );
  return { count, bytes };
}

export async function deleteCapture(captureId: string): Promise<void> {
  await multiTx([STORE.captures, STORE.captureBlobs], 'readwrite', async (t) => {
    await req(t.objectStore(STORE.captures).delete(captureId));
    await req(t.objectStore(STORE.captureBlobs).delete(captureId));
  });
  changes.emit('captures');
}

/** Evict the oldest captures until the total fits under `capBytes`. Returns how many went. */
export async function pruneCaptures(capBytes = CAPTURE_CAP_BYTES): Promise<number> {
  const { bytes } = await captureUsage();
  if (bytes <= capBytes) return 0;
  let over = bytes - capBytes;
  const victims: string[] = [];
  await tx(STORE.captures, 'readonly', (s) =>
    walk(s.index('ts'), null, 'next', (c) => {
      const m = c.value as CaptureMeta;
      victims.push(m.captureId);
      over -= m.bytes;
      return over > 0;
    }),
  );
  await multiTx([STORE.captures, STORE.captureBlobs], 'readwrite', async (t) => {
    for (const id of victims) {
      t.objectStore(STORE.captures).delete(id);
      t.objectStore(STORE.captureBlobs).delete(id);
    }
  });
  return victims.length;
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head = '', b64 = ''] = dataUrl.split(',');
  const mime = /:(.*?);/.exec(head)?.[1] ?? 'image/png';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

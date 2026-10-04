import { describe, it, expect, beforeEach } from 'vitest';
import { saveToDownloads, saveLogChunk } from '@/platform/download-disk';

// With no profile-folder grant the records still reach disk — through chrome.downloads, with no
// user step (owner, 2026-10-04: "it should be auto handled not by user").
const saved: { url: string; filename: string; conflictAction?: string; saveAs?: boolean }[] = [];
const erased: number[] = [];
let listener: ((d: { id: number; state?: { current: string } }) => void) | null = null;

beforeEach(() => {
  saved.length = 0;
  erased.length = 0;
  (globalThis as unknown as { chrome: unknown }).chrome = {
    downloads: {
      setUiOptions: async () => {},
      download: async (o: (typeof saved)[number]) => (saved.push(o), saved.length),
      erase: async ({ id }: { id: number }) => void erased.push(id),
      onChanged: { addListener: (f: typeof listener) => (listener = f), removeListener: () => (listener = null) },
    },
  };
});

describe('download-disk', () => {
  it('writes under jobbot/, overwrites, never asks where to save, and decodes back to the same UTF-8 text', async () => {
    expect(await saveToDownloads('records/2026-10-04_lever_x_applied.json', '{"title":"Résumé — ✓"}', 'application/json')).toBe(true);
    const s = saved[0]!;
    expect(s.filename).toBe('jobbot/records/2026-10-04_lever_x_applied.json');
    expect(s.conflictAction).toBe('overwrite');
    expect(s.saveAs).toBe(false);
    const b64 = s.url.split('base64,')[1]!;
    expect(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))).toBe('{"title":"Résumé — ✓"}');
  });

  it('erases the finished item from the download LIST (the file stays) so nothing piles up', async () => {
    await saveToDownloads('a.txt', 'x');
    listener!({ id: 1, state: { current: 'complete' } });
    await Promise.resolve();
    expect(erased).toEqual([1]);
  });

  it('a screenshot data: URL is saved as-is; log lines go to logs/<their day>/', async () => {
    await saveToDownloads('captures/x.png', 'data:image/png;base64,iVBORw0KGgo=');
    expect(saved[0]!.url).toBe('data:image/png;base64,iVBORw0KGgo=');
    await saveLogChunk(['2026-10-04T15:00:00.000Z run started', 'next']);
    expect(saved[1]!.filename).toMatch(/^jobbot\/logs\/2026-10-04\/\d\d-\d\d-\d\d-\d{3}\.txt$/);
  });

  it('a path cannot climb out of jobbot/', async () => {
    await saveToDownloads('../../etc/x', 'y');
    expect(saved[0]!.filename.startsWith('jobbot/')).toBe(true);
    expect(saved[0]!.filename).not.toContain('..');
  });
});

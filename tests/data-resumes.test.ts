import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { addResume, listResumes, getResume, removeResume, resumeAsSerialized } from '@/platform/data/resumes';
import { serializeFile, deserializeFile } from '@/platform/serialized-file';

const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0x00, 0x7f]); // "%PDF-" + high/low bytes

beforeEach(async () => {
  for (const r of await listResumes()) await removeResume(r.id);
});

describe('résumés', () => {
  it('adds with a derived label and lists in upload order', async () => {
    const a = await addResume(new Blob([bytes], { type: 'application/pdf' }), { name: 'kuldeep_backend.pdf' });
    await new Promise((r) => setTimeout(r, 2));
    const b = await addResume(new Blob([bytes]), { name: 'kuldeep_canada.pdf', label: 'Canada', type: 'application/pdf' });
    expect(a).toMatchObject({ label: 'kuldeep_backend', name: 'kuldeep_backend.pdf', type: 'application/pdf', size: 8 });
    expect(a.id).toMatch(/^r-/);
    expect(b.label).toBe('Canada');
    expect((await listResumes()).map((r) => r.id)).toEqual([a.id, b.id]);
    expect(Object.keys(a)).not.toContain('data');
  });

  it('reads the file back as a Blob, removes it', async () => {
    const m = await addResume(new Blob([bytes], { type: 'application/pdf' }), { name: 'x.pdf' });
    const got = await getResume(m.id);
    expect(got?.name).toBe('x.pdf');
    expect(new Uint8Array(await got!.blob.arrayBuffer())).toEqual(bytes);
    await removeResume(m.id);
    expect(await getResume(m.id)).toBeNull();
    expect(await listResumes()).toEqual([]);
  });

  it('resumeAsSerialized matches serializeFile byte for byte', async () => {
    const file = new File([bytes], 'kuldeep_bishnoi.pdf', { type: 'application/pdf' });
    const m = await addResume(file, { name: file.name });
    const ours = await resumeAsSerialized(m.id);
    const theirs = await serializeFile(file);
    expect(ours).toEqual(theirs);
    expect(ours.dataBase64).toBe(btoa(String.fromCharCode(...bytes)));
    expect(new Uint8Array(await deserializeFile(ours).arrayBuffer())).toEqual(bytes);
  });

  it('names the fix when the id is unknown', async () => {
    await expect(resumeAsSerialized('r-nope')).rejects.toThrow(/Profile › Résumés/);
  });
});

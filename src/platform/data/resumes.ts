// Résumé variants uploaded from the dashboard. `profile.resume` holds one of these ids (or a
// legacy folder path — profile-store.ts tells them apart by asking this store).
import type { ResumeFile, ResumeMeta } from '../../engine/records';
import { serializeFile, type SerializedFile } from '../serialized-file';
import { STORE, changes, tx } from './idb';

interface ResumeRow extends ResumeMeta {
  data: ArrayBuffer; // structured-clone safe in every runtime; the Blob is rebuilt on read
}

export async function addResume(file: File | Blob, meta: { name: string; label?: string; type?: string }): Promise<ResumeMeta> {
  const now = Date.now();
  const row: ResumeRow = {
    id: `r-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: meta.name,
    label: meta.label?.trim() || meta.name.replace(/\.[a-z0-9]+$/i, ''),
    type: meta.type || file.type || 'application/pdf',
    size: file.size,
    addedAt: now,
    data: await file.arrayBuffer(),
  };
  await tx(STORE.resumes, 'readwrite', (s) => s.put(row));
  changes.emit('resumes');
  const { data: _omit, ...out } = row;
  return out;
}

/** Oldest first (upload order). */
export async function listResumes(): Promise<ResumeMeta[]> {
  const rows = (await tx(STORE.resumes, 'readonly', (s) => s.getAll())) as ResumeRow[];
  return rows.map(({ data: _omit, ...m }) => m).sort((a, b) => a.addedAt - b.addedAt);
}

export async function getResume(id: string): Promise<ResumeFile | null> {
  const row = (await tx(STORE.resumes, 'readonly', (s) => s.get(id))) as ResumeRow | undefined;
  if (!row) return null;
  const { data, ...meta } = row;
  return { ...meta, blob: new Blob([data], { type: meta.type }) };
}

export async function removeResume(id: string): Promise<void> {
  await tx(STORE.resumes, 'readwrite', (s) => s.delete(id));
  changes.emit('resumes');
}

/** The run-message shape (base64) — built by the same `serializeFile` the folder path uses. */
export async function resumeAsSerialized(id: string): Promise<SerializedFile> {
  const r = await getResume(id);
  if (!r) throw new Error(`résumé "${id}" is not stored in the extension — upload it in Profile › Résumés`);
  return serializeFile(new File([r.blob], r.name, { type: r.type }));
}

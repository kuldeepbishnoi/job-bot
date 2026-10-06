// profile.yaml → the extension, with no click in the browser. `npm run install:chrome` writes the
// YAML (+ its résumé) into the installed extension as seed/profile.json (scripts/seed-profile.mjs);
// this imports it into the dashboard's store whenever the YAML changed since the last import.
//
// Newest edit wins: a seed is imported once per content hash, so a later dashboard edit stands
// until profile.yaml itself changes again. Before this, a dashboard copy ALWAYS beat profile.yaml,
// and on 2026-10-04 that copy was near-empty (auto_submit off, no answers, a typo'd email) while
// the complete YAML sat unread — every run parked, and nothing outside Chrome could fix it.
import { parse } from 'yaml';
import { parseProfile } from '../../config/schema';
import { saveProfile } from './profile-store';
import { addResume, listResumes } from './resumes';

export interface ProfileSeed {
  readonly hash: string;
  readonly yaml: string;
  readonly resume: { readonly name: string; readonly type: string; readonly base64: string } | null;
  readonly from?: string;
  /** registry.jsonl's applied job ids — excluded from every run (store.ts#appliedIds). */
  readonly applied?: readonly string[];
}

export const SEED_APPLIED_KEY = 'seed_applied_ids';

const SEED_HASH_KEY = 'profile_seed_hash';

export type SeedResult =
  | { readonly status: 'none' } // no seed in this install
  | { readonly status: 'unchanged' }
  | { readonly status: 'imported'; readonly resumeId: string | null }
  | { readonly status: 'invalid'; readonly error: string };

/** The seed shipped in THIS install, or null (a store build, or no profile.yaml at install time). */
export async function readSeed(): Promise<ProfileSeed | null> {
  try {
    const res = await fetch(chrome.runtime.getURL('seed/profile.json'));
    return res.ok ? ((await res.json()) as ProfileSeed) : null;
  } catch {
    return null;
  }
}

export async function importSeed(seed: ProfileSeed | null): Promise<SeedResult> {
  if (!seed) return { status: 'none' };
  // The applied list is not part of "the profile": refresh it every time, so a registry line added
  // after the last profile import still stops a repeat — and never overwrites a dashboard edit.
  if (seed.applied) await chrome.storage.local.set({ [SEED_APPLIED_KEY]: [...seed.applied] });
  const got = await chrome.storage.local.get(SEED_HASH_KEY);
  if (got[SEED_HASH_KEY] === seed.hash) return { status: 'unchanged' };

  let profile;
  try {
    profile = parseProfile(parse(seed.yaml));
  } catch (e) {
    // Never half-import: a broken YAML leaves the stored profile alone, and is retried next reload.
    return { status: 'invalid', error: (e as Error).message };
  }
  // profile.yaml names a FILE path; the store wants a stored résumé id. Reuse an identical upload
  // rather than adding a copy on every install.
  let resumeId: string | null = null;
  if (seed.resume) {
    const bytes = Uint8Array.from(atob(seed.resume.base64), (c) => c.charCodeAt(0));
    const same = (await listResumes()).find((r) => r.name === seed.resume!.name && r.size === bytes.byteLength);
    resumeId = same?.id ?? (await addResume(new Blob([bytes], { type: seed.resume.type }), { name: seed.resume.name, type: seed.resume.type })).id;
    profile = { ...profile, resume: resumeId };
  }
  await saveProfile(profile, 'yaml-import');
  await chrome.storage.local.set({ [SEED_HASH_KEY]: seed.hash });
  return { status: 'imported', resumeId };
}

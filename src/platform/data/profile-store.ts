// The profile the dashboard edits: `profile_v1` (exact ProfileSchema output) + `profile_meta` in
// chrome.storage.local. The legacy profile/ folder (fs-config) keeps working as a fallback; which
// one a run uses is decided in ONE place, `resolveRunInputs`.
import { parse, stringify } from 'yaml';
import { parseProfile, type Profile } from '../../config/schema';
import { loadProfileAndResume } from '../fs-config';
import type { SerializedFile } from '../serialized-file';
import { changes } from './idb';
import { getResume, resumeAsSerialized } from './resumes';

const PROFILE_KEY = 'profile_v1';
const META_KEY = 'profile_meta';

export interface ProfileMeta {
  rev: number;
  savedAt: string; // ISO
  source: 'ui' | 'yaml-import' | 'folder';
}

export async function loadStoredProfile(): Promise<{ profile: Profile; meta: ProfileMeta } | null> {
  const got = await chrome.storage.local.get([PROFILE_KEY, META_KEY]);
  const raw = got[PROFILE_KEY];
  if (raw === undefined || raw === null) return null;
  const meta = (got[META_KEY] as ProfileMeta | undefined) ?? { rev: 0, savedAt: '', source: 'ui' };
  return { profile: parseProfile(raw), meta };
}

/** Validates first (throws the schema's message), then bumps rev. */
export async function saveProfile(profile: Profile, source: ProfileMeta['source']): Promise<ProfileMeta> {
  const valid = parseProfile(profile);
  const got = await chrome.storage.local.get(META_KEY);
  const prev = got[META_KEY] as ProfileMeta | undefined;
  const meta: ProfileMeta = { rev: (prev?.rev ?? 0) + 1, savedAt: new Date().toISOString(), source };
  await chrome.storage.local.set({ [PROFILE_KEY]: valid, [META_KEY]: meta });
  changes.emit('profile');
  return meta;
}

/** Unvalidated, for the editor (a half-typed draft still needs to render). */
export async function loadStoredProfileRaw(): Promise<unknown | null> {
  const got = await chrome.storage.local.get(PROFILE_KEY);
  return got[PROFILE_KEY] ?? null;
}

export function profileToYaml(profile: Profile): string {
  return stringify(profile);
}

export function profileFromYaml(text: string): Profile {
  return parseProfile(parse(text));
}

export interface RunInputs {
  profile: Profile;
  resume: SerializedFile;
  /** 'ui' = stored profile + IDB résumé; 'folder' = the legacy profile/ folder supplied something. */
  source: 'ui' | 'folder';
}

/**
 * What a run needs. Order: stored profile + IDB résumé (`profile.resume` or `resumeId` is a stored
 * résumé id) → else the legacy folder via fs-config.loadProfileAndResume — only when `allowFolder`,
 * because that needs an extension page with a user gesture (never the SW).
 */
export async function resolveRunInputs(opts: { allowFolder: boolean; resumeId?: string }): Promise<RunInputs> {
  const stored = await loadStoredProfile();
  if (stored) {
    const id = opts.resumeId ?? stored.profile.resume;
    if (await getResume(id)) return { profile: { ...stored.profile, resume: id }, resume: await resumeAsSerialized(id), source: 'ui' };
    if (opts.allowFolder) {
      // The dashboard's profile is the truth; only the résumé file comes from the folder.
      const folder = await loadProfileAndResume();
      return { profile: stored.profile, resume: folder.resume, source: 'folder' };
    }
    throw new Error(`résumé "${id}" is not stored in the extension — upload a résumé in Profile › Résumés and pick it as profile.resume`);
  }
  if (opts.allowFolder) return { ...(await loadProfileAndResume()), source: 'folder' };
  throw new Error('No profile saved yet — fill in Profile in the dashboard (or import profile.yaml), and upload a résumé in Profile › Résumés');
}

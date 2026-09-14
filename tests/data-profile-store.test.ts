import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { installChromeFake, type ChromeFake } from './helpers/chrome-fake';
import { loadStoredProfile, saveProfile, loadStoredProfileRaw, profileToYaml, profileFromYaml, resolveRunInputs } from '@/platform/data/profile-store';
import { addResume, listResumes, removeResume } from '@/platform/data/resumes';
import { changes } from '@/platform/data/idb';

const exampleYaml = readFileSync('profile/profile.example.yaml', 'utf-8');

let chrome: ChromeFake;
beforeEach(async () => {
  chrome = installChromeFake();
  for (const r of await listResumes()) await removeResume(r.id);
});

describe('profile store', () => {
  it('round-trips profile.example.yaml through YAML and storage', async () => {
    const p = profileFromYaml(exampleYaml);
    expect(p.identity.first_name).toBe('Kuldeep');
    expect(p.answers['years_of_experience']).toBe(6);
    expect(p.answers['languages']).toEqual(['English', 'Hindi']);
    expect(p.linkedin?.search_urls).toHaveLength(2);
    const again = profileFromYaml(profileToYaml(p));
    expect(again).toEqual(p); // defaults applied once, stable after

    expect(await loadStoredProfile()).toBeNull();
    const meta = await saveProfile(p, 'yaml-import');
    expect(meta).toMatchObject({ rev: 1, source: 'yaml-import' });
    expect(Date.parse(meta.savedAt)).not.toBeNaN();
    const stored = await loadStoredProfile();
    expect(stored?.profile).toEqual(p);
    expect(stored?.meta).toEqual(meta);
    expect(await loadStoredProfileRaw()).toEqual(p);
    expect((await saveProfile(p, 'ui')).rev).toBe(2);
  });

  it('refuses an invalid profile before writing', async () => {
    const p = profileFromYaml(exampleYaml);
    await expect(saveProfile({ ...p, identity: { ...p.identity, email: 'not-an-email' } }, 'ui')).rejects.toThrow(/identity\.email/);
    expect(await loadStoredProfile()).toBeNull();
    expect(() => profileFromYaml('identity: {}\n')).toThrow(/profile\.yaml is invalid/);
  });

  it('emits a profile change on save', async () => {
    const seen: string[] = [];
    const off = changes.subscribe((s) => void seen.push(s));
    await saveProfile(profileFromYaml(exampleYaml), 'ui');
    off();
    expect(seen).toEqual(['profile']);
  });
});

describe('resolveRunInputs', () => {
  const pdf = () => new File([new Uint8Array([1, 2, 3])], 'cv.pdf', { type: 'application/pdf' });

  it('uses the stored profile + IDB résumé when profile.resume is a résumé id', async () => {
    const r = await addResume(pdf(), { name: 'cv.pdf' });
    await saveProfile({ ...profileFromYaml(exampleYaml), resume: r.id }, 'ui');
    const got = await resolveRunInputs({ allowFolder: false });
    expect(got.source).toBe('ui');
    expect(got.profile.resume).toBe(r.id);
    expect(got.resume).toEqual({ name: 'cv.pdf', type: 'application/pdf', dataBase64: btoa('') });
  });

  it('an explicit resumeId wins over profile.resume', async () => {
    const r = await addResume(pdf(), { name: 'cv.pdf' });
    await saveProfile(profileFromYaml(exampleYaml), 'ui'); // resume: resume/kuldeep_bishnoi.pdf (legacy path)
    const got = await resolveRunInputs({ allowFolder: false, resumeId: r.id });
    expect(got.profile.resume).toBe(r.id);
    expect(got.resume.name).toBe('cv.pdf');
  });

  it('names the fix when the résumé is a legacy path and the folder is not allowed', async () => {
    await saveProfile(profileFromYaml(exampleYaml), 'ui');
    await expect(resolveRunInputs({ allowFolder: false })).rejects.toThrow(/Upload a résumé in Profile › Résumés/i);
  });

  it('without a stored profile: explains, or falls through to the folder only when allowed', async () => {
    await expect(resolveRunInputs({ allowFolder: false })).rejects.toThrow(/No profile saved yet/);
    // allowFolder → fs-config, which has no folder handle here (its `jobbot` db is empty).
    await expect(resolveRunInputs({ allowFolder: true })).rejects.toThrow(/No profile folder chosen yet/);
    expect(chrome._data.has('profile_v1')).toBe(false);
  });
});

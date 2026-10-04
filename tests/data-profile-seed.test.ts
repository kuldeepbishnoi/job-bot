import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { installChromeFake } from './helpers/chrome-fake';
import { importSeed, type ProfileSeed } from '@/platform/data/profile-seed';
import { loadStoredProfile, saveProfile } from '@/platform/data/profile-store';
import { listResumes, removeResume } from '@/platform/data/resumes';

// profile.yaml reaches the extension through the install, with no click in Chrome. On 2026-10-04
// a near-empty dashboard copy (auto_submit off, no answers, "@gmai.com") silently beat a complete
// profile.yaml and every run parked.
const yaml = readFileSync('profile/profile.example.yaml', 'utf-8');
const pdf = { name: 'cv.pdf', type: 'application/pdf', base64: Buffer.from('%PDF-1.4 test').toString('base64') };
const seed = (hash: string, text = yaml): ProfileSeed => ({ hash, yaml: text, resume: pdf });

beforeEach(async () => {
  installChromeFake();
  for (const r of await listResumes()) await removeResume(r.id);
});

describe('profile seed', () => {
  it('replaces a stale dashboard profile, and stores the résumé it names', async () => {
    const stale = (await import('@/config/schema')).parseProfile({ identity: { first_name: 'K', last_name: 'B', email: 'k@gmai.com', phone: '1', country: 'India' }, resume: 'r-old', auto_submit: false });
    await saveProfile(stale, 'ui');

    const r = await importSeed(seed('h1'));
    expect(r.status).toBe('imported');
    const got = (await loadStoredProfile())!;
    expect(got.profile.identity.email).not.toBe('k@gmai.com');
    expect(got.meta.source).toBe('yaml-import');
    const resumes = await listResumes();
    expect(resumes).toHaveLength(1);
    expect(got.profile.resume).toBe(resumes[0]!.id);
  });

  it('imports a given YAML once — a later dashboard edit stands until profile.yaml changes', async () => {
    await importSeed(seed('h1'));
    const edited = { ...(await loadStoredProfile())!.profile, max_per_run: 3 };
    await saveProfile(edited, 'ui');

    expect((await importSeed(seed('h1'))).status).toBe('unchanged');
    expect((await loadStoredProfile())!.profile.max_per_run).toBe(3);

    expect((await importSeed(seed('h2'))).status).toBe('imported'); // the YAML changed → it wins again
    expect((await loadStoredProfile())!.profile.max_per_run).not.toBe(3);
    expect(await listResumes()).toHaveLength(1); // the same file is reused, not re-added
  });

  it('a broken YAML never half-imports, and no seed changes nothing', async () => {
    await importSeed(seed('h1'));
    const before = (await loadStoredProfile())!.profile;
    expect((await importSeed(seed('h3', 'identity: [nope'))).status).toBe('invalid');
    expect((await loadStoredProfile())!.profile).toEqual(before);
    expect((await importSeed(null)).status).toBe('none');
  });
});

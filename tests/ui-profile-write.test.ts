import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { installChromeFake, type ChromeFake } from './helpers/chrome-fake';

// The console writes answers back to the profile. The test that matters most is the YAML one:
// profile.yaml is hand-maintained and every key carries a comment explaining it, so a write that
// round-trips through parse()+stringify() (throwing all of that away) would be a regression the
// user only notices weeks later, in a file they trusted.

// A fake File System Access directory holding one file, so the disk sink is exercised end to end.
const disk = { yaml: '', mode: 'readwrite' as 'read' | 'readwrite' | 'none', writes: 0 };
const fileHandle = {
  getFile: async () => ({ text: async () => disk.yaml }),
  createWritable: async () => ({
    write: async (data: string) => {
      disk.yaml = data;
      disk.writes += 1;
    },
    close: async () => undefined,
  }),
};
const dirHandle = {
  getFileHandle: async (name: string) => {
    if (name !== 'profile.yaml') throw new Error('not found');
    return fileHandle;
  },
  requestPermission: async () => 'granted',
};

vi.mock('@/platform/fs-config', () => ({
  getProfileDir: async (mode: string) => (disk.mode === 'none' || (mode === 'readwrite' && disk.mode !== 'readwrite') ? null : dirHandle),
  loadProfileAndResume: async () => {
    throw new Error('not used in this test');
  },
}));

const { answerTarget, applyAnswer, fieldShape, looksBooleanOptions, saveAnswer, setInYaml, describeSave } = await import('@/ui/profile-write');
const { profileFromYaml, loadStoredProfile, saveProfile } = await import('@/platform/data/profile-store');

const exampleYaml = readFileSync('profile/profile.example.yaml', 'utf-8');

let chrome: ChromeFake;
beforeEach(() => {
  chrome = installChromeFake();
  disk.yaml = exampleYaml;
  disk.mode = 'readwrite';
  disk.writes = 0;
});

describe('answerTarget', () => {
  it('sends a matched intent to answers.* and everything else to overrides', () => {
    const a = answerTarget({ intent: 'answers.needs_sponsorship', label: 'Will you require sponsorship?' });
    expect(a).toMatchObject({ sink: 'answers', key: 'needs_sponsorship', display: 'answers.needs_sponsorship' });
    expect(a.path).toEqual(['answers', 'needs_sponsorship']);

    const b = answerTarget({ label: '  Which shift do you prefer?  ' });
    expect(b).toMatchObject({ sink: 'overrides', key: 'Which shift do you prefer?' });
    expect(b.display).toBe('overrides["Which shift do you prefer?"]');
    // resolver.ts looks overrides up by label.trim() — the key must match that exactly.
    expect(b.path).toEqual(['overrides', 'Which shift do you prefer?']);

    // A non-answers intent (identity, resume) is not a profile answer: key it by text instead.
    const c = answerTarget({ intent: 'identity.city', label: 'City' });
    expect(c.sink).toBe('overrides');
    expect(c.why).toMatch(/identity\.city/);
  });
});

describe('fieldShape', () => {
  it('takes the intent catalog first, then the control kind', () => {
    expect(fieldShape({ intent: 'answers.needs_sponsorship' })).toBe('boolean');
    expect(fieldShape({ intent: 'answers.years_of_experience' })).toBe('number');
    expect(fieldShape({ intent: 'answers.gender' })).toBe('token');
    expect(fieldShape({ kind: 'checkbox' })).toBe('boolean');
    expect(fieldShape({ kind: 'multiselect' })).toBe('string[]');
    expect(fieldShape({ kind: 'text#' })).toBe('number'); // a numeric box
    expect(fieldShape({ kind: 'select' })).toBe('text');
    expect(fieldShape({ sample: true })).toBe('boolean');
  });

  it('spots a yes/no pair of options', () => {
    expect(looksBooleanOptions(['Yes', 'No'])).toBe(true);
    expect(looksBooleanOptions(['no', 'yes'])).toBe(true);
    expect(looksBooleanOptions(['Yes', 'No', 'Prefer not to say'])).toBe(false);
    expect(looksBooleanOptions(['Remote', 'Hybrid'])).toBe(false);
  });
});

describe('applyAnswer', () => {
  it('sets and deletes without mutating the profile it was given', () => {
    const p = profileFromYaml(exampleYaml);
    const target = answerTarget({ intent: 'answers.non_compete', label: 'Are you subject to a non-compete?' });
    const next = applyAnswer(p, target, false);
    expect(next.answers['non_compete']).toBe(false);
    expect(p.answers['non_compete']).toBeUndefined(); // original untouched

    const cleared = applyAnswer(next, target, undefined);
    expect('non_compete' in cleared.answers).toBe(false);

    const ov = answerTarget({ label: 'Preferred shift' });
    expect(applyAnswer(p, ov, 'Night').overrides['Preferred shift']).toBe('Night');
  });
});

describe('setInYaml', () => {
  it('keeps every comment and the key order when it rewrites one answer', () => {
    const out = setInYaml(exampleYaml, ['answers', 'years_of_experience'], 7);

    // the value changed…
    expect(parse(out).answers.years_of_experience).toBe(7);
    expect(out).toMatch(/years_of_experience: 7/);
    // …and NOTHING else did: the comments that explain the file are all still there.
    expect(out).toContain('# number -> the "N to less than M years" bucket containing it');
    expect(out).toContain('# yes/no  -> picks the "Yes" option');
    expect(out).toContain('# (MAX belongs on range dropdowns; an exact box must match the résumé)');
    expect(out).toContain('# max_per_run: 15');

    // key order is the human's, not the serializer's
    const keys = out.split('\n').filter((l) => /^[a-z_]+:/.test(l)).map((l) => l.split(':')[0]);
    const before = exampleYaml.split('\n').filter((l) => /^[a-z_]+:/.test(l)).map((l) => l.split(':')[0]);
    expect(keys).toEqual(before);

    // nothing else about the DATA moved either
    const after = parse(out);
    expect({ ...after, answers: { ...after.answers, years_of_experience: 6 } }).toEqual(parse(exampleYaml));

    // and the result still validates as a profile
    expect(profileFromYaml(out).answers['years_of_experience']).toBe(7);
  });

  it('rewrites the one line it was asked to and leaves every other byte alone', () => {
    // A hand-written file, the way a user keeps one: comments above, beside, and between keys.
    const file = [
      '# my profile — hand written, keep the comments',
      'identity:',
      '  first_name: Kuldeep # the one the forms want',
      '  country: India',
      '',
      '# how questions get answered',
      'answers:',
      '  work_authorization: true # yes/no -> picks "Yes"',
      '  exact_years_of_experience: 6 # the figure on the résumé',
      '  how_did_you_hear: "Amazon Career Site" # keep the quotes',
      '',
      'on_unknown: park # park | skip | guess',
      '',
    ].join('\n');

    const out = setInYaml(file, ['answers', 'exact_years_of_experience'], 7);
    const changed = out.split('\n').filter((l, i) => l !== file.split('\n')[i]);
    expect(changed).toEqual(['  exact_years_of_experience: 7 # the figure on the résumé']);
    expect(out.split('\n')).toHaveLength(file.split('\n').length);

    // a string keeps its quoting style, too
    expect(setInYaml(file, ['answers', 'how_did_you_hear'], 'Job Posting')).toContain('how_did_you_hear: "Job Posting" # keep the quotes');
  });

  it('adds a key that was not there, deletes one that was, and creates a missing map', () => {
    const added = setInYaml(exampleYaml, ['answers', 'non_compete'], false);
    expect(parse(added).answers.non_compete).toBe(false);
    expect(added).toContain('# yes/no  -> picks the "Yes" option'); // still comment-preserving

    const withOverride = setInYaml(exampleYaml, ['overrides', 'How did you hear about this role?'], 'A friend');
    expect(parse(withOverride).overrides['How did you hear about this role?']).toBe('A friend');

    const removed = setInYaml(added, ['answers', 'non_compete'], undefined);
    expect('non_compete' in parse(removed).answers).toBe(false);

    const fresh = setInYaml('# just a comment\nresume: resume/cv.pdf\n', ['answers', 'over_18'], true);
    expect(fresh).toContain('# just a comment');
    expect(parse(fresh)).toEqual({ resume: 'resume/cv.pdf', answers: { over_18: true } });
  });

  it('refuses to write over a file it could not parse', () => {
    expect(() => setInYaml('answers:\n  - [unbalanced\n', ['answers', 'x'], 1)).toThrow(/could not be parsed/);
  });
});

describe('saveAnswer', () => {
  it('writes both sinks and says which ones it wrote', async () => {
    await saveProfile(profileFromYaml(exampleYaml), 'yaml-import');

    const res = await saveAnswer({ label: 'Are you comfortable commuting?', intent: 'answers.commute_ok', value: true, alsoDisk: true });
    expect(res.ok).toBe(true);
    expect(res.wrote).toEqual(['the extension profile', 'profile.yaml']);
    expect(res.target.display).toBe('answers.commute_ok');
    expect(describeSave(res)).toBe('Saved answers.commute_ok to the extension profile and profile.yaml.');

    expect((await loadStoredProfile())?.profile.answers['commute_ok']).toBe(true);
    expect(disk.writes).toBe(1);
    expect(parse(disk.yaml).answers.commute_ok).toBe(true);
    expect(disk.yaml).toContain('# yes/no  -> picks the "Yes" option'); // comments survived the real write path
  });

  it('writes only the extension profile when no folder is asked for', async () => {
    await saveProfile(profileFromYaml(exampleYaml), 'yaml-import');
    const res = await saveAnswer({ label: 'Preferred shift', value: 'Night' });
    expect(res.wrote).toEqual(['the extension profile']);
    expect(res.diskSkipped).toMatch(/no profile folder/);
    expect(disk.writes).toBe(0);
    expect((await loadStoredProfile())?.profile.overrides['Preferred shift']).toBe('Night');
    expect(chrome._data.has('profile_v1')).toBe(true);
  });

  it('reports a half-success instead of pretending, when the folder is not writable', async () => {
    await saveProfile(profileFromYaml(exampleYaml), 'yaml-import');
    disk.mode = 'none';
    const res = await saveAnswer({ label: 'Preferred shift', value: 'Night', alsoDisk: true });
    expect(res.ok).toBe(true); // the stored profile DID get it
    expect(res.wrote).toEqual(['the extension profile']);
    expect(res.diskError).toMatch(/no profile folder is linked/);
    expect(disk.writes).toBe(0);
  });

  it('says so when there is no profile to write to at all', async () => {
    const res = await saveAnswer({ label: 'Preferred shift', value: 'Night' });
    expect(res.ok).toBe(false);
    expect(res.storedError).toMatch(/no profile is saved/);
    expect(describeSave(res)).toMatch(/Nothing was written/);
  });
});

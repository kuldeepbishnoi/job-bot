import { describe, it, expect } from 'vitest';
import {
  addChips,
  answerToText,
  answersOf,
  bareAnswerKey,
  coerceAnswer,
  emptyDraft,
  getAt,
  identityFields,
  isDirty,
  matchesSearch,
  overridesOf,
  removeAt,
  removeChip,
  resumeKind,
  sameData,
  setAnswer,
  setAt,
  setOverrides,
  splitChips,
  supportsMax,
  toDraft,
  validateDraft,
  type Draft,
} from '@/ui/profile-draft';
import type { Profile } from '@/config/schema';

const VALID: Profile = {
  identity: {
    first_name: 'Kuldeep',
    last_name: 'Bishnoi',
    preferred_name: '',
    email: 'k@example.com',
    phone: '+91 9416375330',
    country: 'India',
    linkedin: '',
    website: '',
    city: 'Bengaluru',
  },
  resume: 'r-abc',
  want: { titles_any: ['SDE'], titles_none: [], locations: ['Remote'], seniority: [] },
  answers: { work_authorization: true },
  overrides: {},
  on_unknown: 'park',
  auto_submit: false,
  careers: [],
  accounts: [],
  greenhouse: { boards: [], include_defaults: false },
  lever: { boards: [], include_defaults: false },
  ashby: { boards: [], include_defaults: false },
};

describe('validateDraft', () => {
  it('accepts a complete draft and hands back the parsed Profile', () => {
    const { profile, errors } = validateDraft(toDraft(VALID));
    expect(errors).toEqual({});
    expect(profile?.identity.email).toBe('k@example.com');
  });

  it('keys every issue by its zod path joined with "." so the input can render it', () => {
    const draft = setAt(setAt(toDraft(VALID), 'identity.email', 'nope'), 'accounts.0', 'not-an-email');
    const { profile, errors } = validateDraft(draft);
    expect(profile).toBeNull();
    expect(errors['identity.email']).toMatch(/email/i);
    expect(errors['accounts.0']).toMatch(/email/i);
  });

  it('reports the empty draft as invalid (name / email / résumé are required)', () => {
    const { profile, errors } = validateDraft(emptyDraft());
    expect(profile).toBeNull();
    expect(Object.keys(errors)).toEqual(expect.arrayContaining(['identity.first_name', 'identity.email', 'resume']));
  });
});

describe('paths', () => {
  it('sets nested values immutably', () => {
    const before = toDraft(VALID);
    const after = setAt(before, 'identity.city', 'Toronto');
    expect(getAt(after, 'identity.city')).toBe('Toronto');
    expect(getAt(before, 'identity.city')).toBe('Bengaluru'); // original untouched
  });

  it('treats numeric segments as array indexes and splices on remove', () => {
    const d = setAt(emptyDraft(), 'want.locations.1', 'Remote');
    expect(getAt(d, 'want.locations')).toEqual([undefined, 'Remote']);
    const back = removeAt(setAt(d, 'want.locations.0', 'Bangalore'), 'want.locations.0');
    expect(getAt(back, 'want.locations')).toEqual(['Remote']);
  });

  it('returns undefined for a path that does not exist instead of throwing', () => {
    expect(getAt(emptyDraft(), 'amazon.search_url')).toBeUndefined();
    expect(getAt(emptyDraft(), 'identity.email.deeper')).toBeUndefined();
  });
});

describe('answers + overrides', () => {
  it('removes an answer when the value is undefined ("not set" = park/skip/guess)', () => {
    const d = setAnswer(toDraft(VALID), 'work_authorization', undefined);
    expect('work_authorization' in answersOf(d)).toBe(false);
  });

  it('keeps override insertion order and drops blank keys', () => {
    const d = setOverrides(emptyDraft(), [
      { key: 'Are you a US citizen?', value: false },
      { key: '  ', value: 'ignored' },
      { key: 'Languages you speak', value: ['English'] },
    ]);
    expect(Object.keys(overridesOf(d))).toEqual(['Are you a US citizen?', 'Languages you speak']);
  });

  it('survives a question label containing dots (overrides are not dotted paths)', () => {
    const d = setOverrides(emptyDraft(), [{ key: 'Have you worked at Acme Inc. before?', value: true }]);
    expect(overridesOf(d)['Have you worked at Acme Inc. before?']).toBe(true);
    expect(validateDraft(setAt(d, 'resume', 'r-1')).errors['overrides']).toBeUndefined();
  });
});

describe('coerceAnswer', () => {
  it('parses numbers, keeps free text, and passes MAX through', () => {
    expect(coerceAnswer('number', '6')).toBe(6);
    expect(coerceAnswer('number', '')).toBeUndefined();
    expect(coerceAnswer('number', 'MAX')).toBe('MAX');
    expect(coerceAnswer('number', '3 years')).toBe('3 years');
  });

  it('only accepts real booleans, so "unset" stays unset', () => {
    expect(coerceAnswer('boolean', true)).toBe(true);
    expect(coerceAnswer('boolean', 'yes')).toBeUndefined();
  });

  it('splits pasted lists and trims empty answers away', () => {
    expect(coerceAnswer('string[]', 'English, Hindi')).toEqual(['English', 'Hindi']);
    expect(coerceAnswer('string[]', [])).toBeUndefined();
    expect(coerceAnswer('text', '  ')).toBeUndefined();
    expect(coerceAnswer('derived', 'Bangalore')).toBeUndefined();
  });

  it('offers MAX only where the resolver honours it', () => {
    expect(supportsMax('answers.years_of_experience')).toBe(true);
    expect(supportsMax('years_of_experience')).toBe(true);
    expect(supportsMax('answers.notice_period')).toBe(false);
  });

  it('normalizes catalog keys and renders values for display', () => {
    expect(bareAnswerKey('answers.gender')).toBe('gender');
    expect(answerToText(['English', 'Hindi'])).toBe('English, Hindi');
    expect(answerToText(undefined)).toBe('');
  });
});

describe('chips', () => {
  it('adds comma-separated values without duplicates and removes by index', () => {
    expect(splitChips('a, b\nc ,, ')).toEqual(['a', 'b', 'c']);
    expect(addChips(['a'], 'b, a, c')).toEqual(['a', 'b', 'c']);
    expect(removeChip(['a', 'b', 'c'], 1)).toEqual(['a', 'c']);
  });
});

describe('resumeKind', () => {
  it('tells a stored id, a legacy folder path, an empty value and a dangling id apart', () => {
    expect(resumeKind('r-abc', ['r-abc'])).toBe('stored');
    expect(resumeKind('resume/kuldeep.pdf', ['r-abc'])).toBe('legacy-path');
    expect(resumeKind('kuldeep.docx', [])).toBe('legacy-path');
    expect(resumeKind('', [])).toBe('unset');
    expect(resumeKind('r-gone', ['r-abc'])).toBe('missing');
  });
});

describe('dirty check', () => {
  it('ignores key order but sees a real edit', () => {
    const a: Draft = { x: 1, y: [1, 2], z: { p: true, q: 'v' } };
    const b: Draft = { y: [1, 2], z: { q: 'v', p: true }, x: 1 };
    expect(sameData(a, b)).toBe(true);
    expect(isDirty(a, b)).toBe(false);
    expect(isDirty(a, { ...b, x: 2 })).toBe(true);
  });
});

describe('identityFields', () => {
  it('is generated from IdentitySchema, with required-ness asked of zod', () => {
    const fields = identityFields();
    expect(fields.map((f) => f.key)).toEqual([
      'first_name',
      'last_name',
      'preferred_name',
      'email',
      'phone',
      'country',
      'linkedin',
      'website',
      'city',
    ]);
    const required = fields.filter((f) => f.required).map((f) => f.key);
    expect(required).toEqual(['first_name', 'last_name', 'email', 'phone', 'country']);
    expect(fields.find((f) => f.key === 'email')?.type).toBe('email');
  });
});

describe('matchesSearch', () => {
  it('matches any of the haystacks, and everything when the box is empty', () => {
    expect(matchesSearch('', 'anything')).toBe(true);
    expect(matchesSearch('spons', 'needs_sponsorship', 'Do you need sponsorship?')).toBe(true);
    expect(matchesSearch('veteran', 'gender', 'Gender', undefined)).toBe(false);
  });
});

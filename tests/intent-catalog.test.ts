import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { INTENT_CATALOG, intentMeta, answersKeys, answerKey, intentOf } from '@/engine/intent-catalog';
import { AnswerToken } from '@/engine/answer-tokens';

const typesSrc = readFileSync('src/engine/types.ts', 'utf-8');
const typesIntents = [...new Set([...typesSrc.matchAll(/'(answers\.[a-z_]+)'/g)].map((m) => m[1]!))];
const exampleAnswers = (parse(readFileSync('profile/profile.example.yaml', 'utf-8')) as { answers: Record<string, unknown> }).answers;

describe('intent catalog', () => {
  it('covers every answers.* intent in types.ts', () => {
    expect(typesIntents.length).toBeGreaterThan(40);
    const missing = typesIntents.filter((i) => !(i in INTENT_CATALOG));
    expect(missing).toEqual([]);
  });

  it('every entry has a label, a shape and a group; token shapes list tokens', () => {
    for (const [k, m] of Object.entries(INTENT_CATALOG)) {
      expect(m!.label, k).not.toBe('');
      expect(['boolean', 'text', 'number', 'string[]', 'token', 'derived']).toContain(m!.shape);
      expect(m!.group, k).toBeTruthy();
      if (m!.shape === 'token') expect(m!.tokens?.length, k).toBeGreaterThan(0);
      else expect(m!.tokens, k).toBeUndefined();
    }
  });

  it('self-ID intents are tokens drawn from answer-tokens.ts', () => {
    const selfId = ['gender', 'hispanic_latino', 'veteran_status', 'disability', 'indigenous', 'visible_minority', 'racial_identity', 'ex_military', 'reserve_forces', 'military_spouse'];
    const valid = new Set<string>(Object.values(AnswerToken));
    for (const k of selfId) {
      const m = intentMeta(intentOf(k));
      expect(m.shape, k).toBe('token');
      expect(m.group, k).toBe('Self-identification');
      expect(m.tokens, k).toContain(AnswerToken.DECLINE);
      for (const t of m.tokens!) expect(valid.has(t), `${k}:${t}`).toBe(true);
    }
    expect(intentMeta('answers.veteran_status').tokens).toContain(AnswerToken.NOT_A_VETERAN);
    expect(intentMeta('answers.disability').tokens).toContain(AnswerToken.NO_DISABILITY);
  });

  it('shapes agree with the example profile’s values', () => {
    for (const [k, v] of Object.entries(exampleAnswers)) {
      const m = intentMeta(intentOf(k), v);
      if (m.shape === 'token') expect(typeof v, k).toBe('string');
      else if (m.shape === 'boolean') expect(typeof v, k).toBe('boolean');
      else if (m.shape === 'string[]') expect(Array.isArray(v), k).toBe(true);
      else if (m.shape === 'number') expect(['number', 'string']).toContain(typeof v); // MAX / "Immediately"-style text is allowed
    }
  });

  it('falls back for an unknown intent: humanized label, shape from the sample', () => {
    expect(intentMeta('answers.pets_at_home', true)).toEqual({ label: 'Pets at home', shape: 'boolean', group: 'Other' });
    expect(intentMeta('answers.team_size', 12).shape).toBe('number');
    expect(intentMeta('answers.frameworks', ['react']).shape).toBe('string[]');
    expect(intentMeta('answers.motto', 'x').shape).toBe('text');
    expect(intentMeta('answers.motto').shape).toBe('text');
  });

  it('answersKeys = catalog keys ∪ the given answers, catalog order first', () => {
    const keys = answersKeys();
    expect(keys.every((k) => k.startsWith('answers.'))).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of Object.keys(exampleAnswers)) expect(keys).toContain(intentOf(k));
    const withExtra = answersKeys({ ...exampleAnswers, custom_thing: 'x' });
    expect(withExtra.slice(0, keys.length)).toEqual(keys);
    expect(withExtra[withExtra.length - 1]).toBe('answers.custom_thing');
  });

  it('answerKey / intentOf are inverses', () => {
    expect(answerKey('answers.gender')).toBe('gender');
    expect(intentOf('gender')).toBe('answers.gender');
    expect(intentOf('answers.gender')).toBe('answers.gender');
    expect(answerKey('locations')).toBe('locations');
  });
});

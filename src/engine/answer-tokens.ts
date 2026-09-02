// Canonical answer tokens for standard demographic / self-ID questions.
// The user writes the TOKEN in profile.yaml (e.g. `gender: DECLINE`); the resolver maps it to
// whichever option wording a given company uses ("Decline to self-identify", "Prefer not to say",
// "I don't wish to answer" …). One token, reusable across every site — no magic strings in config.

export const AnswerToken = {
  DECLINE: 'DECLINE', // prefer not to answer / decline to self-identify
  NOT_A_VETERAN: 'NOT_A_VETERAN',
  NO_DISABILITY: 'NO_DISABILITY',
} as const;

export type AnswerToken = (typeof AnswerToken)[keyof typeof AnswerToken];

// Phrases (lowercased, substring-matched) that identify the right dropdown option for each token.
const SYNONYMS: Record<AnswerToken, readonly string[]> = {
  DECLINE: [
    'decline to self-identify',
    'decline to identify',
    "don't wish to answer",
    'do not wish to answer',
    "don't want to answer",
    'do not want to answer',
    'prefer not to say',
    'prefer not to answer',
  ],
  NOT_A_VETERAN: ['i am not a protected veteran', 'not a protected veteran', 'i am not a veteran', 'not a veteran'],
  NO_DISABILITY: [
    'no, i do not have a disability',
    'do not have a disability',
    'no disability',
    "don't wish to answer",
    'prefer not to answer',
  ],
};

export function isAnswerToken(v: unknown): v is AnswerToken {
  return typeof v === 'string' && v in SYNONYMS;
}

/** Find the option label that satisfies a token, or null if the form offers none. */
export function optionForToken(token: AnswerToken, options: readonly string[]): string | null {
  const syn = SYNONYMS[token];
  return options.find((o) => syn.some((s) => o.toLowerCase().includes(s))) ?? null;
}

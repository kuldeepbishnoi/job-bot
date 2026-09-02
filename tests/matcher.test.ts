import { describe, it, expect } from 'vitest';
import { matchIntent, normalize } from '@/engine/matcher';

describe('matchIntent (real Datadog labels)', () => {
  const cases: [string, string | undefined][] = [
    ['Are you legally authorised to work full-time in the country where this job is based?', 'answers.work_authorization'],
    ['In what cities are you available to work?', 'locations'],
    ['Please select all the languages you speak fluently.', 'answers.languages'],
    ['How did you hear about this opportunity?', 'answers.how_did_you_hear'],
    ['I certify that the information provided in this application is true and correct', 'answers.acknowledge_true'],
    ["I understand my application will be processed in accordance with Datadog's Candidate Privacy Policy.", 'answers.privacy_consent'],
    ['Voluntary Self-Identification of Gender', 'answers.gender'],
    ['LinkedIn Profile', 'identity.linkedin'],
    ['Website', 'identity.website'],
    ['What is your expected salary?', undefined], // unknown -> park
  ];
  it.each(cases)('%s', (label, intent) => {
    expect(matchIntent(label)).toBe(intent);
  });

  it('normalizes punctuation and case', () => {
    expect(normalize('  How DID you   hear? ')).toBe('how did you hear');
  });
});

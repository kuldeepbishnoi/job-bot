import { describe, it, expect } from 'vitest';
import { scrapeGmailCode } from '@/platform/gmail-otp';

// The real Greenhouse email — note the decoys: "security" and "resubmit" are both 8 chars.
function emailDoc(codeMarkup: string): Document {
  const html = `<div class="a3s">
    <p>Hi Kuldeep,</p>
    <p>Copy and paste this code into the security code field on your application:</p>
    ${codeMarkup}
    <p>After you enter the code, resubmit your application.</p>
  </div>`;
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('scrapeGmailCode', () => {
  it('picks the bold code, not the 8-letter decoy words', () => {
    expect(scrapeGmailCode(emailDoc('<h1>mfbNtxKW</h1>'))).toBe('mfbNtxKW');
    expect(scrapeGmailCode(emailDoc('<strong>2PrIEao4</strong>'))).toBe('2PrIEao4');
  });

  it('falls back to the phrase-anchored token when nothing is emphasized', () => {
    const doc = new DOMParser().parseFromString(
      '<div class="a3s">greenhouse security code — paste this code into your application: aB3dEf9H then resubmit</div>',
      'text/html',
    );
    expect(scrapeGmailCode(doc)).toBe('aB3dEf9H');
  });

  it('returns null for unrelated mail', () => {
    const doc = new DOMParser().parseFromString('<div class="a3s">Your Amazon order shipped</div>', 'text/html');
    expect(scrapeGmailCode(doc)).toBeNull();
  });
});

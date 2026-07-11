import { describe, it, expect } from 'vitest';
import { scrapeGmailCode, scrapeGmailCodes } from '@/platform/gmail-otp';

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

describe('scrapeGmailCodes', () => {
  it('collects every distinct code so a fresh one can be told from stale leftovers', () => {
    // Two OTP emails open in a thread: an earlier apply's code and the newest one.
    const html = `
      <div class="a3s">paste this code into the security code field: <h1>STALE001</h1> then resubmit</div>
      <div class="a3s">paste this code into the security code field: <h1>FRESH999</h1> then resubmit</div>
    `;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const codes = scrapeGmailCodes(doc);
    expect(codes).toContain('STALE001');
    expect(codes).toContain('FRESH999');
    // Excluding the pre-submit snapshot leaves exactly the fresh code.
    const stale = ['STALE001'];
    expect(codes.filter((c) => !stale.includes(c))).toEqual(['FRESH999']);
  });

  it('floats the newest UNREAD inbox row to the front, ahead of older read ones', () => {
    // Gmail inbox list view: an unread (.zE) fresh code plus an older, already-read one.
    const rows = `
      <table><tbody>
        <tr class="zA zE"><td><span class="y2">greenhouse security code — on your application: FRESH999 — resubmit</span></td></tr>
        <tr class="zA yO"><td><span class="y2">greenhouse security code — on your application: STALE001 — resubmit</span></td></tr>
      </tbody></table>`;
    const doc = new DOMParser().parseFromString(rows, 'text/html');
    expect(scrapeGmailCodes(doc)[0]).toBe('FRESH999');
  });
});

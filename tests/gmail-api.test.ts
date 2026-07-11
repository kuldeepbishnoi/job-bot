import { describe, it, expect } from 'vitest';
import { extractCode } from '@/platform/gmail-api';

// Gmail API base64url-encodes body data (no padding, - and _ for + and /).
function b64url(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const BODY =
  'Hi Kuldeep,\n\nCopy and paste this code into the security code field on your application:\n\nd3KboUkO\n\nAfter you enter the code, resubmit your application.';

describe('extractCode (Gmail API message)', () => {
  it('reads the code from a text/plain body part', () => {
    const msg = { payload: { mimeType: 'text/plain', body: { data: b64url(BODY) } } };
    expect(extractCode(msg)).toBe('d3KboUkO');
  });

  it('walks a multipart/alternative payload to find the text/plain part', () => {
    const msg = {
      payload: {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/html', body: { data: b64url('<h1>d3KboUkO</h1>') } },
          { mimeType: 'text/plain', body: { data: b64url(BODY) } },
        ],
      },
    };
    expect(extractCode(msg)).toBe('d3KboUkO');
  });

  it('falls back to the snippet when the body has no parsable code', () => {
    const msg = { snippet: 'greenhouse security code on your application: aB3dEf9H then resubmit' };
    expect(extractCode(msg)).toBe('aB3dEf9H');
  });

  it('returns null when nothing looks like a code', () => {
    expect(extractCode({ snippet: 'Your Amazon order shipped' })).toBeNull();
  });
});

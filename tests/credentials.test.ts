import { describe, it, expect } from 'vitest';
import { parseCredentialsCsv, passwordFor, accountsFor, credentialsFor } from '@/platform/credentials';

describe('accounts.csv', () => {
  const c = parseCredentialsCsv(`# comment
email,site,password
A.01@gmail.com,amazon,pw1
a.02@gmail.com,*,pw2
a.03@gmail.com,datadog,"p,w3"
bad-row-without-password,amazon,
`);
  it('parses rows, lowercases emails, keeps quoted commas, skips incomplete rows', () => {
    expect(passwordFor(c, 'amazon', 'a.01@gmail.com')).toBe('pw1');
    expect(passwordFor(c, 'amazon', 'a.02@gmail.com')).toBe('pw2'); // '*' fallback
    expect(passwordFor(c, 'datadog', 'a.03@gmail.com')).toBe('p,w3');
    expect(passwordFor(c, 'amazon', 'a.03@gmail.com')).toBeUndefined();
    expect(passwordFor(c, 'amazon', 'bad-row-without-password')).toBeUndefined();
  });
  it('lists the logins usable for a site', () => {
    expect(accountsFor(c, 'amazon')).toEqual(['a.01@gmail.com', 'a.02@gmail.com']);
    expect(accountsFor(c, 'datadog')).toEqual(['a.03@gmail.com', 'a.02@gmail.com']);
    expect(accountsFor(undefined, 'amazon')).toEqual([]);
  });
  it('accepts a headerless email,site,password file', () => {
    expect(passwordFor(parseCredentialsCsv('x@y.com,amazon,pw'), 'amazon', 'x@y.com')).toBe('pw');
  });
});

describe('credentialsFor — a run holds only the site it is running', () => {
  const all = parseCredentialsCsv([
    'email,site,password',
    'a@x.com,amazon,amazon-secret',
    'a@x.com,datadog,datadog-secret',
    'b@x.com,*,shared-secret',
  ].join('\n'));

  it('keeps this site\'s rows (and the * fallback), drops every other site\'s password', () => {
    const amazon = credentialsFor(all, 'amazon');
    expect(JSON.stringify(amazon)).not.toContain('datadog-secret');
    expect(passwordFor(amazon, 'amazon', 'a@x.com')).toBe('amazon-secret');
    expect(passwordFor(amazon, 'amazon', 'b@x.com')).toBe('shared-secret');
    expect(credentialsFor(all, 'linkedin')).toEqual({ bySite: { linkedin: { 'b@x.com': 'shared-secret' } } });
    expect(credentialsFor(undefined, 'amazon')).toBeUndefined();
  });
});

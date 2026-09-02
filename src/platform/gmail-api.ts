// v2 OTP source: read the Greenhouse code straight from the Gmail API instead of scraping an
// open Gmail tab. This removes the "keep mail.google.com open" requirement and the DOM fragility
// (two OTP emails, unread/read ordering, snippet truncation) that made the tab scrape unreliable.
// getOtp/seenOtps in gmail-otp.ts call this when a token is available; otherwise they fall back.
import { findCodeInText } from './gmail-otp';

const SENDER = 'no-reply@us.greenhouse-mail.io';
// Only the last hour of security-code mail — an older code is stale by definition. Gmail returns
// message ids newest-first, so parsing them in order yields the freshest code first.
const QUERY = `from:${SENDER} newer_than:1h`;
const API = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}
interface GmailMessage {
  snippet?: string;
  payload?: GmailPart;
}

/** Is the Gmail API reachable — i.e. has the user connected their account (oauth2 configured)? */
export function gmailApiAvailable(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.identity?.getAuthToken;
}

/**
 * Fetch an OAuth token via chrome.identity. Interactive (a user gesture, from the popup) grants
 * consent the first time; non-interactive (from the background) silently reuses/refreshes it.
 * Returns null on any failure so callers can fall back to the tab scrape rather than throw.
 */
export function getToken(interactive: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    if (!gmailApiAvailable()) return resolve(null);
    try {
      chrome.identity.getAuthToken({ interactive, scopes: SCOPES }, (result) => {
        if (chrome.runtime.lastError || !result) return resolve(null);
        // MV3 may hand back a string or a { token } object depending on Chrome version.
        resolve(typeof result === 'string' ? result : ((result as { token?: string }).token ?? null));
      });
    } catch {
      resolve(null);
    }
  });
}

/** Drop a token Chrome cached but Gmail rejected (e.g. 401), so the next getToken refreshes it. */
function forget(token: string): void {
  try {
    chrome.identity.removeCachedAuthToken({ token }, () => {});
  } catch {
    /* best-effort */
  }
}

function decodeB64Url(data: string): string {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  try {
    // Reinterpret the byte string as UTF-8 so accented text decodes correctly.
    return decodeURIComponent(
      bin
        .split('')
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join(''),
    );
  } catch {
    return bin;
  }
}

/** Depth-first concatenation of every text/plain body in a Gmail message payload. */
function plainText(part: GmailPart | undefined): string {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return decodeB64Url(part.body.data);
  return (part.parts ?? []).map(plainText).join('\n');
}

/** Pure: extract the 8-char code from one Gmail API message (body first, snippet as fallback). */
export function extractCode(msg: GmailMessage): string | null {
  return findCodeInText(plainText(msg.payload)) ?? findCodeInText(msg.snippet ?? '');
}

async function api<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    forget(token);
    throw new Error('gmail token rejected');
  }
  if (!res.ok) throw new Error(`gmail api ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Return the Greenhouse security codes currently in the mailbox, NEWEST FIRST.
 * Throws on token/network failure so the caller can fall back to the tab scrape.
 */
/** Generic: codes from messages matching a Gmail search, NEWEST FIRST, via an extractor. */
export async function apiCodes(token: string, query: string, extract: (text: string) => string | null, max = 5): Promise<string[]> {
  const list = await api<{ messages?: { id: string }[] }>(`${API}?maxResults=${max}&q=${encodeURIComponent(query)}`, token);
  const codes: string[] = [];
  for (const { id } of list.messages ?? []) {
    const msg = await api<GmailMessage>(`${API}/${id}?format=full`, token);
    const code = extract(plainText(msg.payload)) ?? extract(msg.snippet ?? '');
    if (code && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

export async function apiGreenhouseCodes(token: string): Promise<string[]> {
  const list = await api<{ messages?: { id: string }[] }>(
    `${API}?maxResults=5&q=${encodeURIComponent(QUERY)}`,
    token,
  );
  const codes: string[] = [];
  const seen = new Set<string>();
  for (const { id } of list.messages ?? []) {
    const msg = await api<GmailMessage>(`${API}/${id}?format=full`, token);
    const code = extractCode(msg);
    if (code && !seen.has(code)) {
      seen.add(code);
      codes.push(code);
    }
  }
  return codes;
}

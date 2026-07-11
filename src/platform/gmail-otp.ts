// v1: read the 8-char Greenhouse code from an open Gmail tab (zero setup).
// Isolated behind getOtp() so swapping to the Gmail API later is a one-file change.

const EXACT_8 = /^[A-Za-z0-9]{8}$/;
const SENDER = 'no-reply@us.greenhouse-mail.io';

// The code is rendered on its own, bold. Naive `\b\w{8}\b` would grab decoys like "security"
// or "resubmit" (both 8 chars) that appear in the surrounding sentence — so we look for a
// standalone/emphasized 8-char token first, and only then fall back to a phrase-anchored match.
function findCode(root: Element): string | null {
  for (const sel of ['b', 'strong', 'h1', 'h2', 'h3']) {
    for (const el of Array.from(root.querySelectorAll(sel))) {
      const t = (el.textContent ?? '').trim();
      if (EXACT_8.test(t)) return t;
    }
  }
  // Fallback: the token right after the instruction phrase.
  const text = root.textContent ?? '';
  const m =
    text.match(/application[:\s]+([A-Za-z0-9]{8})\b/i) ??
    text.match(/paste this code[^A-Za-z0-9]+([A-Za-z0-9]{8})/i);
  return m?.[1] ?? null;
}

/** Runs in the Gmail content script: scrape EVERY Greenhouse code currently in the DOM. */
export function scrapeGmailCodes(doc: Document): string[] {
  const found = new Set<string>();
  const bodies = Array.from(doc.querySelectorAll<HTMLElement>('div.a3s, div.ii, span.y2'));
  for (const body of bodies) {
    const text = body.textContent ?? '';
    if (!/security code|verification code|greenhouse/i.test(text)) continue;
    const code = findCode(body);
    if (code) found.add(code);
  }
  return [...found];
}

/** Back-compat single-code read (first match). */
export function scrapeGmailCode(doc: Document): string | null {
  return scrapeGmailCodes(doc)[0] ?? null;
}

/** Ask every open Gmail tab for the codes it can see right now. */
async function queryCodes(): Promise<string[]> {
  const all: string[] = [];
  for (const tab of await chrome.tabs.query({ url: 'https://mail.google.com/*' })) {
    if (tab.id === undefined) continue;
    // Message type MUST match gmail.content.ts's listener ('getCode').
    const codes = await chrome.tabs
      .sendMessage(tab.id, { t: 'getCode' })
      .then((r: { codes?: string[] } | undefined) => r?.codes ?? [])
      .catch(() => [] as string[]);
    all.push(...codes);
  }
  return all;
}

/** Snapshot the codes already sitting in Gmail before we submit — these are stale by definition. */
export async function seenOtps(): Promise<string[]> {
  return queryCodes();
}

/**
 * Background side: poll Gmail for a FRESH code — one that wasn't already present before we
 * submitted. Old OTP emails from earlier applies linger in the tab, so returning the first
 * code we see would replay a stale (wrong) code; excluding the pre-submit snapshot guarantees
 * we wait for the email this apply just triggered.
 */
export async function getOtp(exclude: readonly string[] = [], timeoutMs = 60_000): Promise<string | null> {
  const skip = new Set(exclude);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const fresh = (await queryCodes()).find((c) => !skip.has(c));
    if (fresh) return fresh;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

export const _internal = { SENDER, findCode };

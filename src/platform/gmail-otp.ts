// v1: read the 8-char Greenhouse code from an open Gmail tab (zero setup).
// Isolated behind getOtp() so swapping to the Gmail API later is a one-file change.

const EXACT_8 = /^[A-Za-z0-9]{8}$/;
const SENDER = 'no-reply@us.greenhouse-mail.io';

const RELEVANT = /security code|verification code|greenhouse/i;

// Pull the code out of a chunk of text: the token right after the instruction phrase. Used for
// list-row snippets (no bold markup) and as the body fallback.
function findCodeInText(text: string): string | null {
  const m =
    text.match(/application[:\s]+([A-Za-z0-9]{8})\b/i) ??
    text.match(/paste this code[^A-Za-z0-9]+([A-Za-z0-9]{8})/i) ??
    text.match(/(?:security|verification) code[^A-Za-z0-9]+([A-Za-z0-9]{8})\b/i);
  return m?.[1] ?? null;
}

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
  return findCodeInText(root.textContent ?? '');
}

/**
 * Runs in the Gmail content script: scrape every Greenhouse code the tab shows, NEWEST FIRST.
 *
 * Getting the freshest code right is the whole game — a stale leftover from an earlier apply is a
 * valid 8-char string that silently fails at Greenhouse. Two view shapes, two orderings:
 *  - Inbox LIST: rows (`tr.zA`) render newest-at-top, and a just-arrived OTP is UNREAD (`.zE`).
 *    Read the snippet (`.y2`), and float unread rows to the front — that's the code we just got.
 *  - Open CONVERSATION: message bodies (`.a3s`) render oldest-at-top, so the newest is the LAST one.
 * We concatenate unread rows → open bodies (reversed) → read rows, dedup, and return newest-first,
 * so callers can exclude the pre-submit snapshot and take the first survivor.
 */
export function scrapeGmailCodes(doc: Document): string[] {
  const unreadRow: string[] = [];
  const readRow: string[] = [];
  for (const row of Array.from(doc.querySelectorAll<HTMLElement>('tr.zA'))) {
    if (!RELEVANT.test(row.textContent ?? '')) continue;
    const code = findCodeInText(row.querySelector('.y2')?.textContent ?? row.textContent ?? '');
    if (code) (row.classList.contains('zE') ? unreadRow : readRow).push(code);
  }

  const bodies: string[] = [];
  for (const body of Array.from(doc.querySelectorAll<HTMLElement>('div.a3s, div.ii'))) {
    if (!RELEVANT.test(body.textContent ?? '')) continue;
    const code = findCode(body);
    if (code) bodies.push(code);
  }
  bodies.reverse(); // newest thread message is last in the DOM

  const seen = new Set<string>();
  const out: string[] = [];
  for (const code of [...unreadRow, ...bodies, ...readRow]) {
    if (!seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
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

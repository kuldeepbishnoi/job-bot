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

/** Runs in the Gmail content script: scrape newest Greenhouse code from the DOM. */
export function scrapeGmailCode(doc: Document): string | null {
  const bodies = Array.from(doc.querySelectorAll<HTMLElement>('div.a3s, div.ii, span.y2'));
  for (const body of bodies) {
    const text = body.textContent ?? '';
    if (!/security code|verification code|greenhouse/i.test(text)) continue;
    const code = findCode(body);
    if (code) return code;
  }
  return null;
}

/** Background side: find a Gmail tab and ask it for the code, polling briefly. */
export async function getOtp(timeoutMs = 60_000): Promise<string | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const tab of await chrome.tabs.query({ url: 'https://mail.google.com/*' })) {
      if (tab.id === undefined) continue;
      // Message type MUST match gmail.content.ts's listener ('getCode').
      const code = await chrome.tabs
        .sendMessage(tab.id, { t: 'getCode' })
        .then((r: { code: string | null } | undefined) => r?.code ?? null)
        .catch(() => null);
      if (code) return code;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

export const _internal = { SENDER, findCode };

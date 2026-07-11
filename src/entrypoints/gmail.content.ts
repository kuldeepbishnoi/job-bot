import { defineContentScript } from 'wxt/sandbox';
import { scrapeGmailCodes } from '@/platform/gmail-otp';
import type { Msg } from '@/platform/messaging';

// Runs in the user's open Gmail tab. Reads every Greenhouse code on request so the
// background can tell a fresh code from the stale ones left by earlier applies.
export default defineContentScript({
  matches: ['https://mail.google.com/*'],
  main() {
    chrome.runtime.onMessage.addListener((msg: Msg, _s, respond) => {
      if (msg.t !== 'getCode') return false;
      respond({ codes: scrapeGmailCodes(document) });
      return true;
    });
  },
});

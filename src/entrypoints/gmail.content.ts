import { defineContentScript } from 'wxt/sandbox';
import { scrapeGmailCode } from '@/platform/gmail-otp';
import type { Msg } from '@/platform/messaging';

// Runs in the user's open Gmail tab. Only reads the newest Greenhouse code on request.
export default defineContentScript({
  matches: ['https://mail.google.com/*'],
  main() {
    chrome.runtime.onMessage.addListener((msg: Msg, _s, respond) => {
      if (msg.t !== 'getCode') return false;
      respond({ code: scrapeGmailCode(document) });
      return true;
    });
  },
});

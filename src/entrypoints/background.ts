import { defineBackground } from 'wxt/sandbox';
import { siteById } from '@/sites';
import { run } from '@/app/runner';
import { chromePorts } from '@/app/ports';
import { loadProfileAndResume } from '@/platform/fs-config';
import type { Msg } from '@/platform/messaging';

// Main: wires concrete ports to the pure runner and triggers runs. Owns nothing else.
export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
    if (msg.t !== 'run') return;
    (async () => {
      const site = siteById(msg.siteId);
      if (!site) return sendResponse({ ok: false, error: `unknown site ${msg.siteId}` });
      try {
        const { profile, resume } = await loadProfileAndResume();
        await run(site, profile, resume, chromePorts());
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String((e as Error).message) });
      }
    })();
    return true; // async response
  });
});

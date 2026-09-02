import { defineContentScript } from 'wxt/sandbox';
import * as pp from '@/ats/passport';
import { waitFor } from '@/ats/dom';
import { dlog } from '@/platform/debug-log';
import type { LoginOutcome, Msg } from '@/platform/messaging';

// Runs on passport.amazon.jobs during account rotation. Walks email → password → (code) and
// reports what it sees. A successful login NAVIGATES to amazon.jobs, which kills this script —
// the background reads the tab URL to confirm (same pattern as a successful submit).
const log = (...a: unknown[]) => dlog('passport', ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default defineContentScript({
  matches: ['https://passport.amazon.jobs/*'],
  main() {
    chrome.runtime.onMessage.addListener((msg: Msg, _s, respond) => {
      if (msg.t === 'ping') {
        respond({ pong: true });
        return true;
      }
      if (msg.t === 'login') {
        login(msg.email, msg.password).then(respond);
        return true;
      }
      if (msg.t === 'otp') {
        code(msg.code).then(respond);
        return true;
      }
      return false;
    });
  },
});

async function login(email: string, password: string): Promise<LoginOutcome> {
  try {
    await waitFor(() => (pp.screen(document) !== 'unknown' ? true : null), 15_000).catch(() => {});
    let s = pp.screen(document);
    log('start', s, location.href);
    if (s === 'email') {
      pp.enterEmail(document, email);
      s = await waitFor(() => { const n = pp.screen(document); return n !== 'email' ? n : null; }, 15_000).catch(() => 'unknown' as const);
      log('after email', s);
    }
    if (s === 'password') {
      pp.enterPassword(document, email, password);
      await sleep(1500);
      s = await waitFor(() => { const n = pp.screen(document); return n !== 'password' ? n : null; }, 20_000).catch(() => pp.screen(document));
      log('after password', s, pp.errorText(document));
    }
    if (s === 'code') return { status: 'needs_code' };
    if (s === 'captcha') return { status: 'captcha' };
    if (s === 'error' || pp.errorText(document)) return { status: 'error', note: pp.errorText(document) || 'login error' };
    // Still here and no known screen: the navigation to amazon.jobs may be in flight.
    return { status: 'pending' };
  } catch (e) {
    return { status: 'error', note: String((e as Error).message) };
  }
}

async function code(c: string): Promise<LoginOutcome> {
  try {
    pp.enterCode(document, c);
    await sleep(2000);
    const err = pp.errorText(document);
    if (err) return { status: 'error', note: err };
    return { status: 'pending' };
  } catch (e) {
    return { status: 'error', note: String((e as Error).message) };
  }
}

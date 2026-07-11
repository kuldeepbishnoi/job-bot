import { defineContentScript } from 'wxt/sandbox';
import { withIntent } from '@/engine/matcher';
import { resolve } from '@/engine/resolver';
import * as gh from '@/ats/greenhouse';
import { click, waitFor } from '@/ats/dom';
import { deserializeFile } from '@/platform/serialized-file';
import type { ApplyOutcome, Msg, OtpOutcome } from '@/platform/messaging';

// Runs inside the Greenhouse application iframe. Does all the DOM work.
export default defineContentScript({
  matches: ['https://job-boards.greenhouse.io/embed/*', 'https://boards.greenhouse.io/embed/*'],
  allFrames: true,
  main() {
    chrome.runtime.onMessage.addListener((msg: Msg, _s, respond) => {
      if (msg.t === 'ping') {
        respond({ pong: true }); // readiness handshake for the background orchestrator
        return true;
      }
      if (msg.t === 'apply') {
        applyForm(msg).then(respond);
        return true;
      }
      if (msg.t === 'otp') {
        doOtp(msg.code, msg.autoSubmit).then(respond);
        return true;
      }
      return false;
    });
  },
});

async function applyForm(msg: Extract<Msg, { t: 'apply' }>): Promise<ApplyOutcome> {
  try {
    await waitFor(() => gh.submitButton(document), 8000); // form rendered?
    const resume = deserializeFile(msg.resume);
    const fields = gh.extract(document).map(withIntent);

    for (const field of fields) {
      const options = await gh.optionsFor(document, field);
      const answer = resolve(field, msg.profile, msg.job, options);
      if (answer.kind === 'unknown') {
        if (field.required && msg.profile.on_unknown === 'park') {
          return { status: 'parked', note: `No answer for required: "${field.label}"` };
        }
        continue; // skip optional/unknown
      }
      await gh.fill(document, field, answer, resume);
    }

    click(gh.submitButton(document)!);
    return await afterSubmit();
  } catch (e) {
    return { status: 'error', note: String((e as Error).message) };
  }
}

async function doOtp(code: string, autoSubmit: boolean): Promise<OtpOutcome> {
  try {
    gh.fillOtp(document, code);
    if (!autoSubmit) return { status: 'ready' };
    click(gh.submitButton(document)!);
    const ok = await waitForConfirm();
    return ok ? { status: 'submitted' } : { status: 'error', note: 'no confirmation after OTP submit' };
  } catch (e) {
    return { status: 'error', note: String((e as Error).message) };
  }
}

/** After clicking submit#1: either the OTP step appears, or it's confirmed. */
async function afterSubmit(): Promise<ApplyOutcome> {
  const outcome = await waitFor(() => {
    if (gh.needsOtp(document)) return 'needs_otp' as const;
    if (gh.confirmed(document)) return 'submitted' as const;
    return null;
  }, 15_000).catch(() => null);
  return outcome ? { status: outcome } : { status: 'error', note: 'no OTP prompt or confirmation' };
}

function waitForConfirm(): Promise<boolean> {
  return waitFor(() => (gh.confirmed(document) ? true : null), 15_000)
    .then(() => true)
    .catch(() => false);
}

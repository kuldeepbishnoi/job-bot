import { defineContentScript } from 'wxt/sandbox';
import { withIntent } from '@/engine/matcher';
import { resolve, guessAnswer } from '@/engine/resolver';
import * as gh from '@/ats/greenhouse';
import { click, waitFor, describeAnswer } from '@/ats/dom';
import { deserializeFile } from '@/platform/serialized-file';
import type { ApplyOutcome, Msg, OtpOutcome } from '@/platform/messaging';
import type { AppliedField, Answer, Field } from '@/engine/types';
import { dlog } from '@/platform/debug-log';

// Runs inside the Greenhouse application form — the cross-origin iframe a company embeds
// (Datadog: /embed/job_app) OR the hosted job page (/<board>/jobs/<id>, the Greenhouse-boards
// pack). Same React form either way, so one script does all the DOM work.
//
// #regression (2026-09-15): `matches` used to be the bare hosts with allFrames:true, so the script
// injected into EVERY same-host frame in the tab, not just the real form. Scoped back to the three
// URL shapes that are ever actually the form.
//
// That alone was NOT the whole story. Datadog has failed 100% of the time on every run since
// 2026-09-03 (41 records, 0 successes), most of them "the message channel closed before a response
// was received" ~7s after apply, with 0 fields filled. `chrome.tabs.sendMessage` carries no
// frameId (app/ports.ts), so the FIRST frame to answer 'ping' also receives 'apply' — and a frame
// that has no application form in it will happily answer 'pong', take the apply, then be torn down
// (or simply never find a form), killing its execution context before it can respond. The ping is
// now a real readiness check: a frame answers ONLY when the form is actually present in it, so the
// frame that wins is the frame that can do the work.
export default defineContentScript({
  matches: ['https://job-boards.greenhouse.io/embed/*', 'https://boards.greenhouse.io/embed/*', 'https://job-boards.greenhouse.io/*/jobs/*'],
  allFrames: true,
  main() {
    chrome.runtime.onMessage.addListener((msg: Msg, _s, respond) => {
      if (msg.t === 'ping') {
        // `ready` is the point of the handshake: the embed's bootstrap document answers a ping too,
        // and it is replaced moments later. Only a document that actually holds the form can be
        // filled, so say which one this is rather than just "a script is here".
        respond({ pong: true, ready: gh.submitButton(document) !== null, confirmed: gh.confirmed(document), why: location.href });
        return true;
      }
      if (msg.t === 'apply') {
        // ALWAYS answer. A rejection that never responds reaches the background as Chrome's opaque
        // "message channel closed", which is what hid this failure for a whole run.
        applyForm(msg).then(respond, (e: Error) => respond({ status: 'error', note: `apply threw: ${e.message}` }));
        return true;
      }
      if (msg.t === 'otp') {
        doOtp(msg.code, msg.autoSubmit).then(respond, (e: Error) => respond({ status: 'error', note: `otp threw: ${e.message}` }));
        return true;
      }
      return false;
    });
  },
});

/** One line describing what this frame actually is — for a ping refusal and for park/error notes. */
function describeFrame(): string {
  const forms = document.querySelectorAll('form').length;
  const labels = document.querySelectorAll('label[for]').length;
  return `url=${location.pathname} forms=${forms} labels=${labels} submit=${!!gh.submitButton(document)} otp=${gh.needsOtp(document)} confirmed=${gh.confirmed(document)}`;
}

async function applyForm(msg: Extract<Msg, { t: 'apply' }>): Promise<ApplyOutcome> {
  // dlog, NOT console.log. Until 2026-09-15 this was console.log, so NONE of this script's
  // diagnostics reached the persisted log or the on-disk record — which is exactly why Datadog
  // could fail 41 times across three separate days with every record reading "filled 0" and no
  // explanation of what the page actually did. Amazon and LinkedIn already logged this way.
  const log = (...args: unknown[]) => dlog('greenhouse', `[${msg.job.id}]`, ...args);
  try {
    log('apply start', { url: location.href, job: msg.job.title });
    await waitFor(() => gh.submitButton(document), 8000); // form rendered?
    const resume = deserializeFile(msg.resume);
    // Dump the form HTML to storage so we can inspect it later from the SW DevTools console:
    //   chrome.storage.local.get('lastFormHtml').then((r) => copy(r.lastFormHtml))
    const form = document.querySelector('form');
    if (form) {
      try {
        await chrome.storage.local.set({ lastFormHtml: form.outerHTML, lastFormUrl: location.href });
        log('saved form HTML to chrome.storage.local.lastFormHtml (' + form.outerHTML.length + ' chars)');
      } catch (e) {
        log('could not save form HTML', (e as Error).message);
      }
    } else {
      log('no <form> element found in document');
    }
    const filled: { field: Field; answer: Answer }[] = [];
    const failed: { field: Field; note: string }[] = [];
    const handledIds = new Set<string>();
    const records = (): AppliedField[] =>
      filled.map(({ field, answer }) => ({ id: field.id, label: field.label, value: describeAnswer(answer, msg.resume.name) }));

    // Resolve + fill one field. Returns a park reason if a REQUIRED field has no answer;
    // otherwise fills (or records a failure to retry) and returns null. Used by both the
    // initial pass and the pre-submit sweep for late-rendered fields.
    const processField = async (field: Field): Promise<string | null> => {
      handledIds.add(field.id);
      const options = await gh.optionsFor(document, field);
      let answer = resolve(field, msg.profile, msg.job, options);
      if (answer.kind === 'unknown' && field.required && msg.profile.on_unknown === 'guess') answer = guessAnswer(field, options, msg.profile) ?? answer;
      log('field', { id: field.id, label: field.label, kind: field.kind, intent: field.intent, options, answer });
      if (answer.kind === 'unknown') {
        if (field.required && msg.profile.on_unknown !== 'skip') return `No answer for required: "${field.label}"`;
        return null; // skip optional/unknown
      }
      try {
        await gh.fill(document, field, answer, resume);
        filled.push({ field, answer });
        log('filled', field.id);
      } catch (e) {
        // Don't let one stubborn field abort the rest — keep filling, decide at the end.
        log('fill FAILED', field.id, (e as Error).message);
        failed.push({ field, note: (e as Error).message });
      }
      return null;
    };

    const fields = gh.extract(document).map(withIntent);
    log('extracted', fields.length, 'fields', fields.map((f) => ({ id: f.id, label: f.label, kind: f.kind, required: f.required, intent: f.intent })));
    for (const field of fields) {
      const park = await processField(field);
      if (park) {
        log('parking — unknown required field', field.label);
        return { status: 'parked', note: park, filled: records() };
      }
    }

    // Second pass: the résumé upload remounts the form and blanks text inputs we set earlier.
    // That upload finishes asynchronously (variable timing), so poll for a few seconds and
    // re-assert any text field that reverted to empty. Also retry fields that failed the
    // first time (e.g. a react-select that wasn't interactive yet). Stop once all hold.
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise((r) => setTimeout(r, 600));
      const reverted = filled.filter(({ field, answer }) => !gh.textFilled(document, field, answer));
      for (const { field, answer } of reverted) {
        log('re-filling reverted field', field.id);
        try {
          await gh.fill(document, field, answer, resume);
        } catch (e) {
          log('re-fill FAILED', field.id, (e as Error).message);
        }
      }
      for (let i = failed.length - 1; i >= 0; i--) {
        const { field } = failed[i]!;
        const answer = resolve(field, msg.profile, msg.job, await gh.optionsFor(document, field));
        if (answer.kind === 'unknown') continue;
        try {
          await gh.fill(document, field, answer, resume);
          filled.push({ field, answer });
          failed.splice(i, 1);
          log('recovered previously-failed field', field.id);
        } catch (e) {
          log('retry still failing', field.id, (e as Error).message);
        }
      }
      if (reverted.length === 0 && failed.length === 0) break;
    }

    // Pre-submit sweep: some sections mount a second or two AFTER the main fields settle — notably
    // the demographic-data consent checkbox, a REQUIRED gate Greenhouse won't let you submit
    // without. A single re-extract races that mount and can miss it (→ "please accept the terms").
    // So poll: re-extract, handle anything new, and only stop once the field set has held steady
    // for a few ticks (or we exhaust the time budget). This guarantees the late checkbox is caught.
    let stableTicks = 0;
    for (let tick = 0; tick < 16 && stableTicks < 3; tick++) {
      await new Promise((r) => setTimeout(r, 400));
      let sawNew = false;
      for (const field of gh.extract(document).map(withIntent)) {
        if (handledIds.has(field.id)) continue;
        sawNew = true;
        log('late-rendered field', { id: field.id, label: field.label, kind: field.kind, required: field.required });
        const park = await processField(field);
        if (park) {
          log('parking — late required field', field.label);
          return { status: 'parked', note: park, filled: records() };
        }
      }
      stableTicks = sawNew ? 0 : stableTicks + 1;
    }

    // If a REQUIRED field still couldn't be filled, park rather than submit an invalid form.
    const stuck = failed.find(({ field }) => field.required);
    if (stuck) {
      log('parking — required field never filled', stuck.field.label, stuck.note);
      return { status: 'parked', note: `Could not fill required "${stuck.field.label}": ${stuck.note}`, filled: records() };
    }

    if (msg.dryRun) {
      log('dry run — filled + verified, NOT submitting');
      return { status: 'parked', note: 'dry run: filled, not submitted', filled: records() };
    }

    log('all fields processed, clicking submit');
    click(gh.submitButton(document)!);
    return { ...(await afterSubmit(msg.job.id)), filled: records() };
  } catch (e) {
    dlog('greenhouse', `[${msg.job.id}]`, 'apply error', (e as Error).message, '—', describeFrame());
    return { status: 'error', note: String((e as Error).message) };
  }
}

async function doOtp(code: string, autoSubmit: boolean): Promise<OtpOutcome> {
  try {
    await gh.fillOtp(document, code);
    if (!autoSubmit) return { status: 'ready' };
    click(gh.submitButton(document)!);
    const ok = await waitForConfirm();
    return ok ? { status: 'submitted' } : { status: 'error', note: 'no confirmation after OTP submit' };
  } catch (e) {
    return { status: 'error', note: String((e as Error).message) };
  }
}

/** After clicking submit#1: either the OTP step appears, or it's confirmed. */
async function afterSubmit(jobId: string): Promise<ApplyOutcome> {
  // Validation counts as an outcome, not as "nothing happened". A submit the form rejects leaves
  // the page exactly where it was, so waiting the full 15s for an OTP step that is never coming
  // just delays a failure whose cause was on screen the whole time.
  const outcome = await waitFor(() => {
    if (gh.needsOtp(document)) return 'needs_otp' as const;
    if (gh.confirmed(document)) return 'submitted' as const;
    if (gh.validationErrors(document).length) return 'invalid' as const;
    return null;
  }, 15_000).catch(() => null);

  if (outcome === 'needs_otp' || outcome === 'submitted') return { status: outcome };

  // Say what the page actually showed — the old note ("no OTP prompt or confirmation") was the
  // same string whether the form had rejected a field, the submit had not registered, or the page
  // was simply slower than 15s, so 41 failures across three days told us nothing.
  const errors = gh.validationErrors(document);
  const where = describeFrame();
  if (errors.length) {
    dlog('greenhouse', `[${jobId}]`, 'form rejected the submit', errors.join(' | '), '—', where);
    // The user can fix these (an answer in profile.yaml, usually) — park rather than fail.
    return { status: 'parked', note: `the form rejected the submit: ${errors.join(' | ').slice(0, 300)}` };
  }
  dlog('greenhouse', `[${jobId}]`, 'no OTP prompt or confirmation after submit —', where);
  return { status: 'error', note: `no OTP prompt or confirmation 15s after submit — ${where}` };
}

function waitForConfirm(): Promise<boolean> {
  return waitFor(() => (gh.confirmed(document) ? true : null), 15_000)
    .then(() => true)
    .catch(() => false);
}

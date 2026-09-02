import { defineContentScript } from 'wxt/sandbox';
import { withIntent } from '@/engine/matcher';
import { resolve, guessAnswer } from '@/engine/resolver';
import * as az from '@/ats/amazon';
import { waitFor, describeAnswer } from '@/ats/dom';
import type { ApplyOutcome, Msg } from '@/platform/messaging';
import type { AppliedField } from '@/engine/types';
import { dlog } from '@/platform/debug-log';

// Runs in the user's logged-in amazon.jobs tab on /applicant/jobs/<id>/apply (and the /summary
// page it redirects to). Same message contract as the Greenhouse script (ping / apply), driven by
// the background stepper — Amazon is a normal Site pack, just with its own ATS.
//
// Flow (see ats/amazon.ts for the DOM facts):
//   duplicate screen? → done ("already applied")
//   loop over active forms: fill every EMPTY question we can answer → Continue → wait for the next
//   form (or review mode) → … → review mode: Submit application (auto_submit) or park for the user.
//   Submit success navigates away; the background reads that as success (ports.ts).

const MAX_FORMS = 15; // Amazon shows ~9; a runaway loop must never spin forever
const STEP_TIMEOUT_MS = 15_000; // save round-trip + re-render after Continue
const SUBMIT_TIMEOUT_MS = 25_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the form's control count has held still for 3 ticks (React finished mounting). */
async function settle(form: Element): Promise<void> {
  let prev = -1;
  let stable = 0;
  for (let i = 0; i < 25 && stable < 3; i++) {
    const n = az.controlCount(form);
    stable = n === prev ? stable + 1 : 0;
    prev = n;
    await sleep(300);
  }
}
const log = (...a: unknown[]) => dlog('amazon', ...a);

export default defineContentScript({
  matches: ['https://www.amazon.jobs/applicant/jobs/*', 'https://www.amazon.jobs/*/applicant/jobs/*'],
  main() {
    chrome.runtime.onMessage.addListener((msg: Msg, _s, respond) => {
      if (msg.t === 'ping') {
        respond({ pong: true });
        return true;
      }
      if (msg.t === 'apply') {
        applyForm(msg).then(respond);
        return true;
      }
      return false;
    });
  },
});

async function applyForm(msg: Extract<Msg, { t: 'apply' }>): Promise<ApplyOutcome> {
  const filled: AppliedField[] = [];
  const parked = (note: string): ApplyOutcome => ({ status: 'parked', note, filled });
  try {
    log('apply start', { url: location.href, job: msg.job.title });
    if (az.isDuplicate(document) || /result=duplicate/.test(location.href)) {
      return { status: 'submitted', note: 'already applied (Amazon showed the duplicate-application screen)', filled };
    }
    if (/result=application_limit_reach/.test(location.href)) return { status: 'error', note: 'Amazon application limit reached' };

    // The apply app is a shell until its forms XHR lands (and the shell already carries the
    // `reviewing` flag) — wait for the progress rail, then for an active form / real review mode.
    await waitFor(() => (az.formsLoaded(document) ? true : null), 30_000).catch(() => {
      throw new Error(`forms never loaded (30s) — ${az.describeState(document)}`);
    });
    log('forms loaded', az.describeState(document));
    await waitFor(() => az.activeForm(document) ?? (az.reviewMode(document) ? true : null), 20_000).catch(() => {
      throw new Error(`no active form or review mode after 20s — ${az.describeState(document)}`);
    });
    // Snapshot the rendered app for offline debugging (read it back from the SW console with
    //   chrome.storage.local.get('lastAmazonHtml').then((r) => copy(r.lastAmazonHtml))
    // or straight from the extension's LevelDB on disk).
    const app = document.querySelector('.application-questions') ?? document.body;
    void chrome.storage.local.set({ lastAmazonHtml: app.outerHTML.slice(0, 400_000), lastAmazonUrl: location.href, lastAmazonState: az.describeState(document) }).catch(() => {});
    log('state', az.describeState(document));

    const consent = msg.profile.amazon?.ai_consent ?? false;
    let reachedReview = false;
    for (let i = 0; i < MAX_FORMS; i++) {
      // (a not-yet-rendered form burns one iteration — MAX_FORMS has slack for that)
      if (az.reviewMode(document) && !az.activeForm(document)) {
        reachedReview = true;
        break;
      }
      const form = az.activeForm(document);
      if (!form) {
        await sleep(500);
        continue;
      }
      const key = az.formKey(form);
      await settle(form); // React mounts a section's controls a beat after the wrapper (seen live)
      log('form', key, az.progress(document));
      log('questions', az.describeQuestions(form));

      // Fill in passes: answering one question can reveal dependents (export-control follow-ups),
      // so re-scan until a pass finds nothing left to fill.
      for (let pass = 0; pass < 5; pass++) {
      const todo = az.extract(form).map(withIntent).filter((f) => !az.isAnswered(document, f));
      if (todo.length === 0) break;
      log('pass', pass, 'unanswered', todo.map((f) => f.id));
      for (const field of todo) {
        if (az.isAnswered(document, field)) continue; // reused from the last application — leave it
        if (field.kind === 'select' || field.kind === 'multiselect') {
          // Options for a dependent question mount after the question it depends on is answered.
          await waitFor(() => (az.optionsFor(document, field).length ? true : null), 4000).catch(() => {});
        }
        const options = az.optionsFor(document, field);
        let answer = resolve(field, msg.profile, msg.job, options);
        let guessed = false;
        if (answer.kind === 'unknown' && field.required && msg.profile.on_unknown === 'guess') {
          const g = guessAnswer(field, options, msg.profile);
          if (g) {
            answer = g;
            guessed = true;
          }
        }
        log('field', { id: field.id, label: field.label, kind: field.kind, intent: field.intent, options, answer, guessed });
        if (answer.kind === 'unknown') {
          if (field.required && msg.profile.on_unknown !== 'skip') return parked(`No answer for required: "${field.label}" (options: ${options.join(' | ').slice(0, 200)})`);
          continue;
        }
        try {
          try {
            az.fill(document, field, answer);
          } catch (first) {
            // React may still be mounting the control — one retry after a beat.
            log('fill retry', field.id, (first as Error).message);
            await sleep(400);
            az.fill(document, field, answer);
          }
          filled.push({ id: field.id, label: field.label, value: describeAnswer(answer) + (guessed ? ' (guessed)' : '') });
        } catch (e) {
          log('fill FAILED', field.id, (e as Error).message, az.describeQuestions(form));
          if (field.required && msg.profile.on_unknown !== 'guess') return parked(`Could not fill required "${field.label}": ${(e as Error).message}`);
          // guess policy = never stop here: press on; Amazon's own validation will say what's missing.
        }
        await sleep(150);
      }
      await settle(form); // dependents revealed by this pass mount before the next scan
      }

      const next = await waitFor(() => az.continueButton(form), 5000).catch(() => null);
      if (!next) {
        log('no continue button; form buttons:', [...form.querySelectorAll('button, a.btn')].map((b) => b.textContent?.trim()).join(' | '));
        return parked(`No Continue button on form ${key} — ${az.describeState(document)}`);
      }
      log('continue', key, 'filled so far', filled.length);
      next.click();

      const moved = await waitFor(() => {
        if (az.validationErrors(form).length) return 'errors' as const;
        const now = az.activeForm(document);
        if (!now) return az.reviewMode(document) ? ('review' as const) : null;
        return az.formKey(now) !== key ? ('next' as const) : null;
      }, STEP_TIMEOUT_MS).catch(() => 'stuck' as const);
      log('after continue', key, '→', moved, az.describeState(document));
      if (moved === 'errors') return parked(`Amazon rejected form ${key}: ${az.validationErrors(form).join('; ')}`);
      if (moved === 'stuck') return parked(`Form ${key} did not advance after Continue — ${az.describeState(document)}`);
      if (moved === 'review') {
        reachedReview = true;
        break;
      }
      await sleep(600);
    }
    if (!reachedReview) return parked(`Never reached Review & submit (filled ${filled.length}) — ${az.describeState(document)}`);

    if (msg.dryRun) return parked('dry run: filled through Review & submit, not submitted');
    if (!msg.autoSubmit) return parked('Filled through Review & submit; awaiting your click on Submit application');

    const submit = await waitFor(() => az.submitButton(document), 10_000).catch(() => null);
    if (!submit) return { status: 'error', note: 'Submit application button never became enabled', filled };
    log('clicking Submit application');
    submit.click();

    // Success = the app navigates to its success page, which kills this script mid-await; the
    // background then confirms via the tab URL. So the only outcomes we can *report* from here are
    // the AI-consent modal (answer it and keep waiting) and an error that keeps us on the page.
    const handled = new Set<az.AiConsentStep>();
    const outcome = await waitFor((): ApplyOutcome | null => {
      const step = az.aiConsentStep(document);
      if (step && !handled.has(step)) {
        handled.add(step);
        log('answering AI-preference modal', step, { consent });
        az.answerAiConsent(document, consent);
        return null;
      }
      const errs = az.validationErrors(document);
      return errs.length ? { status: 'error', note: `submit failed: ${errs.join('; ')}`, filled } : null;
    }, SUBMIT_TIMEOUT_MS).catch(() => null);
    return outcome ?? { status: 'error', note: 'no confirmation after submit (still on the apply page)', filled };
  } catch (e) {
    console.error('[jobbot:amazon] apply error', e);
    return { status: 'error', note: String((e as Error).message), filled };
  }
}

import { defineContentScript } from 'wxt/sandbox';
import { withIntent } from '@/engine/matcher';
import { resolve, guessAnswer } from '@/engine/resolver';
import * as lv from '@/ats/lever';
import { click, waitFor, describeAnswer } from '@/ats/dom';
import { deserializeFile } from '@/platform/serialized-file';
import type { ApplyOutcome, Msg } from '@/platform/messaging';
import type { AppliedField, Answer, Field } from '@/engine/types';
import { dlog } from '@/platform/debug-log';

// Runs on jobs.lever.co/<site>/<id>/apply. Same ping/apply contract as the Greenhouse script,
// driven by the background stepper. No OTP. Submit navigates to /thanks (kills this script) —
// the background reads the closed port + Site.submittedUrl as success (ports.ts), using the
// field list stashed under pending_fields:<jobId> right before the click.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let currentJobId = '';
const log = (...a: unknown[]) => dlog('lever', currentJobId ? `[${currentJobId}]` : '', ...a);

export default defineContentScript({
  matches: ['https://jobs.lever.co/*'],
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
  const filled: { field: Field; answer: Answer }[] = [];
  const failed: { field: Field; note: string }[] = [];
  const records = (): AppliedField[] => filled.map(({ field, answer }) => ({ id: field.id, label: field.label, value: describeAnswer(answer, msg.resume.name) }));
  const parked = (note: string): ApplyOutcome => ({ status: 'parked', note, filled: records() });
  try {
    currentJobId = msg.job.id;
    log('apply start', { url: location.href, job: msg.job.title });
    if (lv.confirmed(document)) return { status: 'submitted', note: 'already on the thanks page', filled: [] };
    await waitFor(() => lv.submitButton(document), 10_000).catch(() => {
      throw new Error('Lever form never rendered (no #btn-submit)');
    });
    const resume = deserializeFile(msg.resume);
    void chrome.storage.local.set({ lastFormHtml: document.querySelector('#application-form')?.outerHTML.slice(0, 400_000) ?? '', lastFormUrl: location.href }).catch(() => {});

    const fields = lv.extract(document).map(withIntent);
    log('extracted', fields.length, 'fields', fields.map((f) => ({ id: f.id, label: f.label, kind: f.kind, required: f.required, intent: f.intent })));
    for (const field of fields) {
      const options = lv.optionsFor(document, field);
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
        if (field.required && msg.profile.on_unknown !== 'skip') return parked(`No answer for required: "${field.label}"${options.length ? ` (options: ${options.join(' | ').slice(0, 200)})` : ''}`);
        continue;
      }
      try {
        await lv.fill(document, field, answer, resume);
        filled.push({ field, answer });
      } catch (e) {
        log('fill FAILED', field.id, (e as Error).message);
        failed.push({ field, note: (e as Error).message });
      }
    }
    await sleep(500);
    const stuck = failed.find(({ field }) => field.required);
    if (stuck) return parked(`Could not fill required "${stuck.field.label}": ${stuck.note}`);
    const reverted = filled.filter(({ field, answer }) => !lv.textFilled(document, field, answer));
    for (const { field, answer } of reverted) await lv.fill(document, field, answer, resume).catch(() => {});

    if (msg.dryRun || !msg.autoSubmit) {
      log(msg.dryRun ? 'dry run — filled, NOT submitting' : 'auto_submit off — filled, parked for your click');
      return parked(msg.dryRun ? 'dry run: filled, not submitted' : 'Filled; awaiting your submit (auto_submit: false)');
    }

    // Stash what we filled: a successful submit navigates away before we can answer.
    await chrome.storage.local.set({ [`pending_fields:${msg.job.id}`]: records() }).catch(() => {});
    log('clicking submit');
    click(lv.submitButton(document)!);
    const outcome = await waitFor(() => {
      if (lv.confirmed(document)) return 'submitted' as const;
      if (lv.captchaShown(document)) return 'captcha' as const;
      const err = lv.validationError(document);
      if (err) return `error:${err}` as const;
      return null;
    }, 20_000).catch(() => null);
    if (outcome === 'submitted') return { status: 'submitted', filled: records() };
    if (outcome === 'captcha') return parked('hCaptcha challenge shown — solve it and click Submit yourself');
    if (outcome?.startsWith('error:')) return parked(`Lever rejected the form: ${outcome.slice(6)}`);
    // No signal within the wait: the navigation usually killed us before this point; if we are
    // still here, tell the orchestrator so it checks the tab URL.
    return { status: 'error', note: 'no confirmation after submit (still on the apply page)', filled: records() };
  } catch (e) {
    log('apply error', (e as Error).message);
    return { status: 'error', note: String((e as Error).message), filled: records() };
  }
}

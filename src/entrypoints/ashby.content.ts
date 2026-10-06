import { defineContentScript } from 'wxt/sandbox';
import { withIntent } from '@/engine/matcher';
import { resolve, guessAnswer } from '@/engine/resolver';
import * as ab from '@/ats/ashby';
import { fetchAshbyForm, parseApplicationUrl, type AshbyFormField } from '@/sources/ashby';
import { materialize, click, waitFor, describeAnswer } from '@/ats/dom';
import { deserializeFile } from '@/platform/serialized-file';
import type { ApplyOutcome, Msg } from '@/platform/messaging';
import type { AppliedField, Answer, Field } from '@/engine/types';
import { dlog } from '@/platform/debug-log';

// Runs on jobs.ashbyhq.com/<org>/<id>/application. Same ping/apply contract as the Greenhouse
// script, driven by the background stepper. No OTP, no navigation on submit: Ashby swaps the
// form for a success (or failure) container in place.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let currentJobId = '';
const log = (...a: unknown[]) => dlog('ashby', currentJobId ? `[${currentJobId}]` : '', ...a);
const SAVE_QUIET_MS = 5000; // well past Ashby's ~1.5 s field / résumé save latency (measured 2026-10-06)

export default defineContentScript({
  matches: ['https://jobs.ashbyhq.com/*'],
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

/** Wait until the rendered field count has held still for 3 ticks (React finished mounting). */
async function settle(doc: Document): Promise<void> {
  let prev = -1;
  let stable = 0;
  for (let i = 0; i < 25 && stable < 3; i++) {
    const n = doc.querySelectorAll('[data-field-path]').length;
    stable = n === prev ? stable + 1 : 0;
    prev = n;
    await sleep(300);
  }
}

async function applyForm(msg: Extract<Msg, { t: 'apply' }>): Promise<ApplyOutcome> {
  const filled: { field: Field; answer: Answer }[] = [];
  const failed: { field: Field; note: string }[] = [];
  const records = (): AppliedField[] => filled.map(({ field, answer }) => ({ id: field.id, label: field.label, value: describeAnswer(answer, msg.resume.name) }));
  const parked = (note: string): ApplyOutcome => ({ status: 'parked', note, filled: records() });
  try {
    currentJobId = msg.job.id;
    log('apply start', { url: location.href, job: msg.job.title });
    if (ab.confirmed(document)) return { status: 'submitted', note: 'success container already shown', filled: [] };
    await waitFor(() => (ab.formLoaded(document) ? true : null), 30_000).catch(() => {
      throw new Error(`Ashby form never rendered (30s) — ${ab.describeState(document)}`);
    });
    await settle(document);
    const blocked = ab.blockedMessage(document);
    if (blocked) return parked(`Ashby blocked the application: ${blocked.slice(0, 200)}`);

    // The question schema is the oracle for type/required/options; the DOM is where we fill.
    let schema: AshbyFormField[] = [];
    const ref = parseApplicationUrl(location.href);
    if (ref) {
      try {
        schema = await fetchAshbyForm(ref.org, ref.jobId);
      } catch (e) {
        log('form schema unavailable, DOM only', (e as Error).message);
      }
    }
    const byPath = new Map(schema.map((f) => [f.path, f]));
    const resume = deserializeFile(msg.resume);
    void chrome.storage.local.set({ lastFormHtml: document.querySelector('.ashby-application-form-container')?.outerHTML.slice(0, 400_000) ?? '', lastFormUrl: location.href }).catch(() => {});

    const fields = ab.extract(document, schema).map(withIntent);
    log('extracted', fields.length, 'fields', fields.map((f) => ({ id: f.id, label: f.label, kind: f.kind, required: f.required, intent: f.intent, type: byPath.get(f.id)?.type })));
    for (const field of fields) {
      const options = ab.optionsFor(document, field, byPath.get(field.id));
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
        await ab.fill(document, field, materialize(answer), resume);
        filled.push({ field, answer });
      } catch (e) {
        log('fill FAILED', field.id, (e as Error).message);
        failed.push({ field, note: (e as Error).message });
      }
    }
    // The résumé upload can take a moment and Ashby's autofill-from-résumé may rewrite text
    // fields — re-assert anything that reverted.
    await sleep(1500);
    for (const { field, answer } of filled.filter(({ field, answer }) => !ab.textFilled(document, field, answer))) {
      log('re-filling reverted field', field.id);
      await ab.fill(document, field, materialize(answer), resume).catch(() => {});
    }
    const stuck = failed.find(({ field }) => field.required);
    if (stuck) return parked(`Could not fill required "${stuck.field.label}": ${stuck.note}`);

    if (msg.dryRun || !msg.autoSubmit) {
      log(msg.dryRun ? 'dry run — filled, NOT submitting' : 'auto_submit off — filled, parked for your click');
      return parked(msg.dryRun ? 'dry run: filled, not submitted' : 'Filled; awaiting your submit (auto_submit: false)');
    }

    const btn = ab.submitButton(document);
    if (!btn) return parked(`no submit button — ${ab.describeState(document)}`);
    // Ashby saves each field to its server ~0.5-1.5 s after it changes (the résumé ~1.5 s after its
    // upload) and SUBMITS WHAT THE SERVER HOLDS. Clicking sooner got "Missing entry for required
    // field: Name | Email | Phone…" for fields we had filled (every Ashby job, 2026-10-05/06). The
    // network timing list is not visible from a content script, so wait on what IS: the résumé shown
    // as attached, then a quiet period well past Ashby's save latency.
    const resumeExpected = filled.some(({ answer }) => answer.kind === 'file');
    if (resumeExpected) await waitFor(() => (ab.resumeAttached(document) ? true : null), 30_000).catch(() => null);
    await sleep(SAVE_QUIET_MS);
    log('saves settled', ab.describeState(document));
    const verdict = (): string | null => {
      if (ab.confirmed(document)) return 'submitted';
      const f = ab.failureMessage(document);
      if (f) return `failure:${f}`;
      const fix = ab.correctionsNeeded(document);
      if (fix) return `corrections:${fix.join(' | ')}`;
      if (ab.captchaChallenge(document)) return 'captcha';
      return null;
    };
    const filledLabels = new Set(filled.map(({ field }) => field.label.trim().toLowerCase()));
    // Click; if Ashby says a field WE filled is missing, its save had not landed yet — re-type those
    // fields (a fresh save), wait, and submit again. Up to 4 attempts.
    let outcome: string | null = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      log('clicking submit, attempt', attempt);
      click(ab.submitButton(document) ?? btn);
      await sleep(1500); // let a stale alert from the previous attempt be replaced
      outcome = await waitFor(verdict, 40_000).catch(() => null);
      if (!outcome?.startsWith('corrections:') || attempt === 4) break;
      const missing = outcome.slice(12).split(' | ').map((m) => m.replace(/^missing entry for required field:\s*/i, '').trim().toLowerCase());
      const ours = missing.filter((m) => [...filledLabels].some((l) => l.startsWith(m.slice(0, 40)) || m.startsWith(l.slice(0, 40))));
      if (!ours.length) break; // Ashby wants something we never had an answer for — a real gap
      log('Ashby had not saved', ours.length, 'filled field(s) yet — re-saving and retrying');
      for (const { field, answer } of filled.filter(({ field }) => ours.some((m) => field.label.trim().toLowerCase().startsWith(m.slice(0, 40))))) {
        if (answer.kind !== 'file') await ab.fill(document, field, materialize(answer), resume).catch(() => {});
      }
      await sleep(SAVE_QUIET_MS);
    }
    if (outcome === 'captcha') {
      log('reCAPTCHA challenge after Submit —', ab.describeState(document));
      return parked('reCAPTCHA challenge after Submit — solve it in the JobBot window, then click Submit');
    }
    if (outcome === 'submitted') return { status: 'submitted', filled: records() };
    if (outcome?.startsWith('corrections:')) {
      log('Ashby rejected the submit', outcome.slice(12));
      return parked(`Ashby rejected the submit: ${outcome.slice(12, 400)}`);
    }
    if (outcome?.startsWith('failure:')) return parked(`Ashby could not submit: ${outcome.slice(8, 300)}`);
    return { status: 'error', note: `no success container after submit — ${ab.describeState(document)}`, filled: records() };
  } catch (e) {
    log('apply error', (e as Error).message);
    return { status: 'error', note: String((e as Error).message), filled: records() };
  }
}

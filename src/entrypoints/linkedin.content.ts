import { defineContentScript } from 'wxt/sandbox';
import * as li from '@/ats/linkedin';
import { describeAnswer, waitFor } from '@/ats/dom';
import { withIntent } from '@/engine/matcher';
import { guessAnswer, resolve } from '@/engine/resolver';
import { titleWanted } from '@/engine/select-jobs';
import type { AppliedField, ApplyStatus, Field, Job } from '@/engine/types';
import type { Profile } from '@/config/schema';
import { deserializeFile } from '@/platform/serialized-file';
import type { LinkedinJob, LinkedinPageEnd, Msg } from '@/platform/messaging';
import { dlog } from '@/platform/debug-log';

// Runs in the user's logged-in LinkedIn jobs tab. One `linkedin-apply` message = work through every
// unseen card on the CURRENT results page (the background pages on). Per card:
//   card → details pane → "Easy Apply" → modal steps: fill every empty question we can answer
//   (intent → profile answer; on_unknown:guess never leaves a required box empty) → Next/Review →
//   fix whatever LinkedIn's inline validation names → Submit (auto_submit) → dismiss the
//   "application sent" dialog → report → next card.
// Everything is verified by reading the DOM back; every step is logged (Logs page) and every
// attempt — applied, parked, failed — is recorded with the exact values typed.

const MAX_STEPS = 15; // Easy Apply is 2–6 steps; a runaway loop must never spin forever
const MAX_PAGES_IN_PAGE = 40; // LinkedIn caps search results at 40 pages anyway
const MAX_ERROR_RETRIES = 2; // per step, after LinkedIn's validation named what's wrong
const MODAL_WAIT_MS = 12_000;
const SUBMIT_WAIT_MS = 15_000;
const PACE_BACKOFF_MS = 150_000; // LinkedIn's "applying at a fast pace" pause

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Human-ish pause: base ±. LinkedIn pauses accounts that click at machine cadence. */
const pause = (base: number) => sleep(Math.round(base * (0.8 + Math.random() * 0.6)));
const report = (msg: Msg) => chrome.runtime.sendMessage(msg).catch(() => {});

let running = false;
let stopRequested = false;
let currentJob = '';
const log = (...a: unknown[]) => dlog('linkedin', currentJob ? `[${currentJob}]` : '', ...a);

export default defineContentScript({
  matches: ['https://www.linkedin.com/jobs/*'],
  main() {
    chrome.runtime.onMessage.addListener((msg: Msg, _s, respond) => {
      if (msg.t === 'ping') {
        respond({ pong: true });
        return true;
      }
      if (msg.t === 'linkedin-apply') {
        if (running) {
          respond({ ok: false, busy: true });
          return true;
        }
        respond({ ok: true });
        void runPage(msg);
        return true;
      }
      if (msg.t === 'linkedin-stop') {
        stopRequested = true;
        respond({ ok: true });
        return true;
      }
      if (msg.t === 'linkedin-status') {
        respond({ running });
        return true;
      }
      return false;
    });
  },
});

type CardOutcome =
  | { kind: 'skip'; note: string } // not attempted (filtered / not Easy Apply / already applied) — logged, not recorded
  | { kind: 'result'; status: ApplyStatus; note?: string; fields: AppliedField[]; halt?: boolean; end?: LinkedinPageEnd };

async function runPage(msg: Extract<Msg, { t: 'linkedin-apply' }>): Promise<void> {
  running = true;
  stopRequested = false;
  const handled = new Set(msg.exclude);
  const skippedIds: string[] = [];
  let applied = 0;
  let skipped = 0;
  let newCards = 0;
  let pages = 1;
  let reason: LinkedinPageEnd = 'exhausted';
  let note: string | undefined;
  try {
    log('page start', li.describeState(document));
    if (!li.isResultsPage(location.href)) {
      reason = 'lost';
      note = `not a results page: ${location.href.slice(0, 120)}`;
      return;
    }
    await waitFor(() => (li.jobCards(document).length ? true : null), 20_000).catch(() => {});
    await pause(1500);
    for (;;) {
      if (stopRequested) {
        reason = 'stopped';
        break;
      }
      if (li.limitReached(document)) {
        reason = 'limit';
        break;
      }
      if (applied >= msg.budget) {
        reason = 'budget';
        break;
      }
      let card = await nextCard(handled);
      if (!card && pages < MAX_PAGES_IN_PAGE && (await nextPage())) {
        pages++;
        card = await nextCard(handled);
      }
      if (!card) break; // exhausted
      const id = li.cardJobId(card);
      handled.add(id);
      newCards++;
      currentJob = id;
      const outcome = await applyToCard(card, msg.profile, msg.resume);
      if (outcome.kind === 'skip') {
        log('skip', outcome.note);
        skippedIds.push(id);
        if (skippedIds.length % 5 === 0) void report({ t: 'linkedin-handled', runId: msg.runId, ids: skippedIds.splice(0) });
        await pause(600);
        continue;
      }
      const info = li.cardInfo(card);
      const pane = li.paneJob(document);
      const job: LinkedinJob = { id, title: pane.title || info.title || 'LinkedIn job', company: pane.company || info.company || '', url: `https://www.linkedin.com/jobs/view/${id}/` };
      log('outcome', outcome.status, outcome.note ?? '', 'fields', outcome.fields.length);
      void report({ t: 'linkedin-result', runId: msg.runId, job, status: outcome.status, note: outcome.note, fields: outcome.fields });
      if (outcome.status === 'applied') applied++;
      else skipped++;
      if (outcome.end) {
        reason = outcome.end;
        note = outcome.note;
        break;
      }
      if (outcome.halt) {
        reason = 'halt';
        note = outcome.note;
        break;
      }
      await pause(4000); // between jobs — politeness + LinkedIn's pace detector
    }
  } catch (e) {
    reason = 'error';
    note = String((e as Error).message);
    log('page loop error', note, li.describeState(document));
  } finally {
    currentJob = '';
    running = false;
    if (skippedIds.length) void report({ t: 'linkedin-handled', runId: msg.runId, ids: skippedIds });
    const cards = li.jobCards(document).length;
    log('page done', { reason, applied, skipped, cards, newCards, pages, note });
    void report({ t: 'linkedin-page-done', runId: msg.runId, reason, applied, skipped, cards, newCards, pages, note });
  }
}

/** LinkedIn's own pager (an SPA transition — this script survives it). True once new cards render. */
async function nextPage(): Promise<boolean> {
  const btn = li.nextPageButton(document);
  if (!btn) return false;
  const before = li.jobCards(document).map((c) => li.cardJobId(c)).join(',');
  log('next page (in-page pager)');
  li.click(btn);
  const changed = await waitFor(() => (li.jobCards(document).length && li.jobCards(document).map((c) => li.cardJobId(c)).join(',') !== before ? true : null), 10_000).catch(() => false);
  await pause(1500);
  return changed === true;
}

/** The next card not yet handled; scrolls the list to hydrate/load more before giving up. */
async function nextCard(handled: Set<string>): Promise<HTMLElement | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const card = li.jobCards(document).find((c) => !handled.has(li.cardJobId(c)));
    if (card) {
      card.scrollIntoView({ block: 'center' });
      await pause(500);
      return card;
    }
    // Legacy list virtualizes: cards below the fold hold nothing until scrolled into view.
    const list = document.querySelector<HTMLElement>('.jobs-search-results-list, .scaffold-layout__list > div, .scaffold-layout__list-container, .jobs-search-results__list');
    if (list) list.scrollTo({ top: list.scrollHeight });
    else window.scrollTo({ top: document.body.scrollHeight });
    await pause(1500);
  }
  return null;
}

async function applyToCard(card: HTMLElement, profile: Profile, resume: Extract<Msg, { t: 'linkedin-apply' }>['resume']): Promise<CardOutcome> {
  const info = li.cardInfo(card);
  log('card', info);
  if (info.applied) return { kind: 'skip', note: 'already applied (card badge)' };
  if (info.easyApply === false) log('card shows no Easy Apply badge (f_AL is forced, so the pane decides)');
  if ((profile.linkedin?.filter_titles ?? true) && info.title && !titleWanted(info.title, profile.want)) return { kind: 'skip', note: `title filtered: "${info.title}"` };

  // Open the details pane: success = the URL's currentJobId becomes this job; fallback (URL not
  // updated by this layout) = the pane title CHANGED to this card's title.
  const before = { url: location.href, title: li.paneJob(document).title };
  const isOpen = (): true | null => {
    const id = li.currentJobIdFromUrl(location.href);
    if (id === info.id) return true;
    if (id && id !== li.currentJobIdFromUrl(before.url)) return null; // some other job opened
    const title = li.paneJob(document).title;
    return info.title && title === info.title && title !== before.title ? true : null;
  };
  // LinkedIn pre-selects the first card (currentJobId already in the URL): don't click it again.
  if (li.currentJobIdFromUrl(location.href) !== info.id) {
    li.openCard(card);
    const opened = await waitFor(isOpen, 8000).catch(() => false);
    if (!opened) {
      li.openCard(card); // one retry — the list may have re-rendered under us
      const again = await waitFor(isOpen, 5000).catch(() => false);
      if (!again) return { kind: 'skip', note: `card did not open (url ${li.currentJobIdFromUrl(location.href) || 'no currentJobId'})` };
    }
  }
  if (!li.isResultsPage(location.href)) throw new Error(`navigated away while opening the card: ${location.href.slice(0, 120)}`);
  await pause(1500);
  if (!info.title && li.paneJob(document).title && (profile.linkedin?.filter_titles ?? true) && !titleWanted(li.paneJob(document).title, profile.want)) {
    return { kind: 'skip', note: `title filtered: "${li.paneJob(document).title}"` };
  }
  if (li.alreadyAppliedPane(document)) return { kind: 'skip', note: 'already applied (details pane)' };
  const closed = li.jobClosedMessage(document);
  if (closed) return { kind: 'skip', note: `closed: ${closed}` };

  const btn = await waitFor(() => li.easyApplyButton(document), 6000).catch(() => null);
  if (!btn) return { kind: 'skip', note: li.externalApplyOnly(document) ? 'external Apply (company site)' : `no Easy Apply button — ${li.describeState(document)}` };
  li.click(btn);
  let m = await waitFor(() => li.modal(document) ?? li.safetyContinueButton(document), MODAL_WAIT_MS).catch(() => null);
  if (m && !li.modal(document)) {
    log('safety reminder — continuing');
    li.click(m);
    m = await waitFor(() => li.modal(document), MODAL_WAIT_MS).catch(() => null);
  }
  if (!m) {
    if (li.limitReached(document)) return { kind: 'result', status: 'failed', note: "LinkedIn's daily Easy Apply limit reached", fields: [], end: 'limit' };
    if (li.rateLimited(document)) {
      log('pace warning from LinkedIn instead of the modal — backing off 2.5 min');
      await sleep(PACE_BACKOFF_MS);
      return { kind: 'result', status: 'parked', note: 'LinkedIn paused Easy Apply (pace) — backed off, not attempted', fields: [] };
    }
    if (btn.tagName === 'A') {
      btn.click(); // the new layout's <a> sometimes needs a native click
      m = await waitFor(() => li.modal(document), MODAL_WAIT_MS).catch(() => null);
    }
    if (!m) return { kind: 'result', status: 'failed', note: `Easy Apply modal never opened — ${li.describeState(document)}`, fields: [] };
  }
  return driveModal(profile, resume);
}

/** Fill → Next … → Submit inside the open modal. Always leaves the page modal-free. */
async function driveModal(profile: Profile, resume: Extract<Msg, { t: 'linkedin-apply' }>['resume']): Promise<CardOutcome> {
  const filled: AppliedField[] = [];
  const fail = async (note: string, status: ApplyStatus = 'failed', end?: LinkedinPageEnd): Promise<CardOutcome> => {
    log('FAIL', note, li.describeState(document));
    await discard();
    return { kind: 'result', status, note, fields: filled, end };
  };
  const job: Job = { id: currentJob, title: li.paneJob(document).title, team: '', department: '', url: location.href, locations: [], seniority: [] };
  const seen = new Map<string, number>(); // step signature → times seen (stuck guard)
  let errorRetries = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    const m = li.modal(document);
    if (!m) {
      if (li.applicationSent(document)) break; // submitted on the previous iteration
      return fail('modal vanished mid-application');
    }
    if (li.limitReached(document)) return fail("LinkedIn's daily Easy Apply limit reached", 'failed', 'limit');
    if (li.rateLimited(document)) {
      log('pace warning from LinkedIn — backing off 2.5 min');
      await discard();
      await sleep(PACE_BACKOFF_MS);
      return { kind: 'result', status: 'parked', note: 'LinkedIn paused Easy Apply (pace); retried later', fields: filled };
    }
    await settle(m);
    const progress = li.progress(m);
    log('step', step, 'progress', progress, li.describeQuestions(m).slice(0, 1200));

    // Résumé step: reuse the pre-selected card; attach ours only when nothing is selected.
    if (li.resumeInput(m) || li.resumeSelected(m)) {
      if (!li.resumeSelected(m) && li.attachResume(m, deserializeFile(resume))) {
        log('resume attached', resume.name);
        filled.push({ id: 'resume', label: 'Résumé', value: resume.name });
        await pause(3500); // LinkedIn uploads + renders the card
      } else if (!filled.some((f) => f.id === 'resume')) {
        filled.push({ id: 'resume', label: 'Résumé', value: 'LinkedIn\'s selected résumé (pre-filled)' });
      }
    }

    await fillStep(m, profile, job, filled);

    const action = li.actionButton(m);
    if (!action) return fail(`no Next/Review/Submit button on step ${step} — ${li.describeState(document)}`);
    const signature = `${action.kind}:${progress}:${li.extract(m).map((f) => f.id).join(',')}`;
    seen.set(signature, (seen.get(signature) ?? 0) + 1);
    if ((seen.get(signature) ?? 0) > 3) return fail(`stuck on the same step (${action.kind}, progress ${progress}) — errors: ${li.validationErrors(m).join('; ') || 'none'}`);

    if (action.kind === 'submit') {
      if (li.uncheckFollowCompany(m)) log('unchecked "Follow company"');
      recordPrefilled(m, filled);
      if (!profile.auto_submit) {
        log('auto_submit off — leaving the modal open for the user');
        return { kind: 'result', status: 'parked', note: 'Filled through Review; auto_submit is off — click "Submit application" yourself (run halted)', fields: filled, halt: true };
      }
      await pause(800);
      log('clicking Submit application', 'fields', filled.length);
      li.click(action.el);
      const done = await waitFor(() => (li.applicationSent(document) || !li.modal(document) ? 'sent' : li.validationErrors(li.modal(document)!).length ? 'errors' : null), SUBMIT_WAIT_MS).catch(() => 'timeout' as const);
      if (done === 'errors') return fail(`submit rejected: ${li.validationErrors(li.modal(document)!).join('; ')}`);
      if (done === 'timeout') return fail(`no confirmation ${SUBMIT_WAIT_MS / 1000}s after Submit — ${li.describeState(document)}`);
      await pause(1200);
      await dismissAll();
      return { kind: 'result', status: 'applied', fields: filled };
    }

    log('click', action.kind);
    li.click(action.el);
    await pause(1200);
    const after = li.modal(document);
    const errors = after ? li.validationErrors(after) : [];
    if (errors.length) {
      log('validation errors', errors);
      if (errorRetries++ >= MAX_ERROR_RETRIES) return fail(`LinkedIn rejected the step: ${errors.join('; ')}`);
      await fixErrors(after!, profile, job, filled, errors);
      continue; // same step re-evaluated: fill anything still empty, click again
    }
    errorRetries = 0;
    await pause(600);
  }
  if (li.applicationSent(document) || !li.modal(document)) {
    await dismissAll();
    return { kind: 'result', status: 'applied', fields: filled };
  }
  return fail(`never reached Submit within ${MAX_STEPS} steps`);
}

/** Wait until the modal's control count has held still for 3 ticks (Ember/React finished). */
async function settle(m: Element): Promise<void> {
  let prev = -1;
  let stable = 0;
  for (let i = 0; i < 20 && stable < 3; i++) {
    const n = m.querySelectorAll('input, select, textarea, button').length;
    stable = n === prev ? stable + 1 : 0;
    prev = n;
    await sleep(250);
  }
}

/** Answer every EMPTY question on this step (LinkedIn pre-fills from the last application —
 *  those are kept). Passes: answering one question can reveal dependents. */
async function fillStep(m: Element, profile: Profile, job: Job, filled: AppliedField[]): Promise<void> {
  for (let pass = 0; pass < 3; pass++) {
    const todo = li.extract(m).map(withIntent).filter((f) => f.kind !== 'file' && !li.isAnswered(m, f));
    if (!todo.length) return;
    for (const field of todo) {
      if (li.isAnswered(m, field)) continue;
      await answerField(m, field, profile, job, filled, '');
      await pause(350);
    }
    await sleep(400);
  }
}

/** Decide + put one answer; records what was typed (and whether it was guessed / coerced). */
async function answerField(m: Element, field: Field, profile: Profile, job: Job, filled: AppliedField[], hint: string): Promise<boolean> {
  const options = li.optionsFor(m, field);
  const numeric = li.isNumeric(m, field);
  let answer = resolve(field, profile, job, options);
  let guessed = false;
  if (answer.kind === 'unknown' && profile.on_unknown === 'guess') {
    const g = guessAnswer(field, options, profile);
    if (g) {
      answer = g;
      guessed = true;
    }
  }
  if (answer.kind === 'text' && (numeric || /number|numeric|decimal/i.test(hint))) {
    const coerced = coerceNumber(answer.value, field, profile, hint);
    if (coerced !== answer.value) {
      guessed = guessed || !/^\d/.test(answer.value);
      answer = { kind: 'text', value: coerced };
    }
  }
  // The contact step splits the phone: a country-code select + the national number box. Strip the
  // dial code the country option names ("India (+91)"), else any "+NN " prefix.
  if (answer.kind === 'text' && field.intent === 'identity.phone') {
    const country = li.extract(m).map(withIntent).find((f) => f.intent === 'identity.phone_country');
    if (country) {
      const chosen = li.currentAnswer(m, country) || (() => { const r = resolve(country, profile, job, li.optionsFor(m, country)); return r.kind === 'choice' ? (r.values[0] ?? '') : ''; })();
      const code = /\+(\d{1,3})/.exec(chosen)?.[1];
      const digits = answer.value.replace(/[^\d+]/g, '');
      const national = code && digits.startsWith(`+${code}`) ? digits.slice(code.length + 1) : digits.replace(/^\+\d{1,3}(?=\d{6,})/, '');
      answer = { kind: 'text', value: national.replace(/\D/g, '') };
    }
  }
  log('field', { id: field.id.slice(-40), label: field.label, kind: field.kind, numeric, intent: field.intent, options: options.slice(0, 8), answer, guessed, hint });
  if (answer.kind === 'unknown' || answer.kind === 'file') {
    if (field.required && profile.on_unknown !== 'guess') log('no answer for required question', field.label);
    return false;
  }
  try {
    let shownValue = describeAnswer(answer);
    if (li.isTypeaheadField(m, field)) {
      shownValue = await li.fillTypeahead(m, field, answer.kind === 'choice' ? (answer.values[0] ?? '') : answer.kind === 'text' ? answer.value : '');
    } else {
      li.fill(m, field, answer);
      if (!li.isAnswered(m, field)) {
        await sleep(300);
        if (!li.isAnswered(m, field)) li.fill(m, field, answer);
      }
    }
    if (!li.isAnswered(m, field)) throw new Error('value did not stick');
    const idx = filled.findIndex((f) => f.id === field.id);
    const rec = { id: field.id, label: field.label, value: `${shownValue}${guessed ? ' (guessed)' : ''}` };
    if (idx >= 0) filled[idx] = rec;
    else filled.push(rec);
    return true;
  } catch (e) {
    log('fill FAILED', field.label, (e as Error).message);
    return false;
  }
}

/** LinkedIn's numeric boxes reject anything but a number ("Enter a whole number between 0 and
 *  99", "decimal number larger than 0.0"). Turn whatever we resolved into one it accepts. */
function coerceNumber(value: string, field: Field, profile: Profile, hint: string): string {
  const decimal = /decimal/i.test(hint);
  let n = Number.parseFloat(value.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) {
    const years = profile.answers['years_of_experience'];
    if (field.intent === 'answers.years_of_experience' || /year|experience/i.test(field.label)) n = typeof years === 'number' ? years : 10;
    else if (field.intent === 'answers.notice_period') n = 30;
    else if (/salary|ctc|compensation/i.test(field.label)) n = 0;
    else n = 1; // "never stuck": a positive number passes every LinkedIn numeric rule
  }
  if (!decimal) n = Math.max(0, Math.round(n));
  if (/between 0 and 99/i.test(hint)) n = Math.min(99, n);
  if (decimal && n <= 0) n = 1;
  return decimal ? n.toFixed(1) : String(n);
}

/** LinkedIn named what's wrong: re-answer the questions that carry an error, then anything empty. */
async function fixErrors(m: Element, profile: Profile, job: Job, filled: AppliedField[], errors: string[]): Promise<void> {
  const hint = errors.join(' ');
  // Re-answer with the guess policy regardless of on_unknown: an empty required box blocks the
  // whole run, and the record shows "(guessed)" so it can be reviewed.
  const forced: Profile = { ...profile, on_unknown: 'guess' };
  for (const field of li.fieldsInError(m).map(withIntent)) {
    log('fixing', field.label, 'error hint', hint.slice(0, 120));
    await answerField(m, field, forced, job, filled, hint);
  }
  await fillStep(m, { ...profile, on_unknown: 'guess' }, job, filled);
}

/** Every question the step shows that we did NOT set (LinkedIn pre-filled) — for the record. */
function recordPrefilled(m: Element, filled: AppliedField[]): void {
  for (const f of li.extract(m)) {
    if (filled.some((x) => x.id === f.id)) continue;
    const v = li.currentAnswer(m, f);
    if (v) filled.push({ id: f.id, label: f.label, value: `${v} (pre-filled)` });
  }
}

/** Close the post-submit dialog(s). */
async function dismissAll(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const x = li.dismissButton(document);
    if (!x) return;
    li.click(x);
    await pause(700);
    const d = li.discardButton(document);
    if (d) {
      li.click(d);
      await pause(700);
    }
  }
}

/** Abandon an unfinished application: × → "Discard". Never leaves a modal behind. */
async function discard(): Promise<void> {
  for (let i = 0; i < 3 && li.modal(document); i++) {
    const x = li.dismissButton(document);
    if (x) li.click(x);
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    await pause(800);
    const d = li.discardButton(document);
    if (d) {
      li.click(d);
      await pause(800);
    }
  }
  if (li.modal(document)) log('WARNING: modal still open after discard', li.describeState(document));
}

import { defineContentScript } from 'wxt/sandbox';
import * as li from '@/ats/linkedin';
import { describeAnswer, waitFor } from '@/ats/dom';
import { withIntent } from '@/engine/matcher';
import { guessAnswer, resolve } from '@/engine/resolver';
import { fitNumber, fitText, maxFromHint } from '@/engine/fit-answer';
import { titleWanted } from '@/engine/select-jobs';
import type { Answer, AppliedField, ApplyStatus, Capture, Field, FieldSource, Job } from '@/engine/types';
import type { Profile } from '@/config/schema';
import { deserializeFile } from '@/platform/serialized-file';
import type { LinkedinJob, LinkedinPageEnd, Msg } from '@/platform/messaging';
import { dlog, formatLine } from '@/platform/debug-log';

// Runs in the user's logged-in LinkedIn jobs tab. One `linkedin-apply` message = work through every
// unseen card on the CURRENT results page (the background pages on). Per card:
//   card → details pane → "Easy Apply" → modal steps: fill every empty question we can answer
//   (intent → profile answer; on_unknown:guess never leaves a required box empty) → Next/Review →
//   fix whatever LinkedIn's inline validation names → Submit (auto_submit) → dismiss the
//   "application sent" dialog → report → next card.
// Everything is verified by reading the DOM back. OBSERVABILITY IS THE PRODUCT: every attempt —
// applied, parked, failed — is reported with every field (value + where it came from + the options
// offered + any validation error), that job's complete log lines, the résumé used, the listing's
// location + description, and a capture (screenshot + HTML) of the review step or the failure.

const MAX_STEPS = 15; // Easy Apply is 2–6 steps; a runaway loop must never spin forever
const MAX_PAGES_IN_PAGE = 40; // LinkedIn caps search results at 40 pages anyway
const MAX_ERROR_RETRIES = 2; // per step, after LinkedIn's validation named what's wrong
const MODAL_WAIT_MS = 12_000;
const SUBMIT_WAIT_MS = 15_000;
const PACE_BACKOFF_MS = 150_000; // LinkedIn's "applying at a fast pace" pause
// Questions where a GUESS would put a false statement about the applicant in front of an employer.
// The owner's "never stuck" policy covers decline/No/first-option choices, not fabricated numbers:
// the previous build typed `0` into "What is your current fixed salary?". These park the job with
// a note naming the profile key to add, and the review file lists them.
const NEVER_GUESS = new Set(['answers.current_salary', 'answers.current_fixed_salary', 'answers.current_variable_salary', 'answers.total_ctc', 'answers.expected_salary', 'answers.current_company', 'answers.current_title']);
const OPEN_ATTEMPTS = 4; // ats/linkedin.ts#openCard strategies: native link click → pointer → inner → Enter

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Human-ish pause: base ±. LinkedIn pauses accounts that click at machine cadence. */
const pause = (base: number) => sleep(Math.round(base * (0.8 + Math.random() * 0.6)));
const report = (msg: Msg) => chrome.runtime.sendMessage(msg).catch(() => {});

let running = false;
let stopRequested = false;
let currentJob = '';
let jobLog: string[] = []; // every line logged while `currentJob` is set — travels with the record
const log = (...a: unknown[]): void => {
  const args = currentJob ? [`[${currentJob}]`, ...a] : a;
  if (currentJob) jobLog.push(formatLine('linkedin', args));
  dlog('linkedin', ...args);
};

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

type Resume = Extract<Msg, { t: 'linkedin-apply' }>['resume'];

/** A required question we refuse to guess (see NEVER_GUESS): park the job, name the profile key. */
class NeedsProfileAnswer extends Error {}

type CardOutcome =
  | { kind: 'skip'; note: string } // not attempted (filtered / not Easy Apply / already applied) — logged, not recorded
  | { kind: 'result'; status: ApplyStatus; note?: string; fields: AppliedField[]; resume?: string; capture?: Capture; halt?: boolean; end?: LinkedinPageEnd };

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
    const conflicts = li.conflictingExtensions(document);
    if (conflicts.length) {
      const detail = `${conflicts.join(' and ')} ${conflicts.length > 1 ? 'are' : 'is'} also running on this page — disable ${conflicts.length > 1 ? 'them' : 'it'} at chrome://extensions, or both bots click the same buttons`;
      log('WARNING conflicting extension:', detail);
      void report({ t: 'linkedin-warning', runId: msg.runId, code: 'conflicting-extension', detail });
    }
    if (li.loggedOut(document)) {
      const detail = 'LinkedIn is showing the signed-out page — log in in this tab, then start the run again';
      log('WARNING not logged in');
      void report({ t: 'linkedin-warning', runId: msg.runId, code: 'not-logged-in', detail });
      reason = 'error';
      note = detail;
      return;
    }
    if (!li.isResultsPage(location.href)) {
      reason = 'lost';
      note = `not a results page: ${location.href.slice(0, 120)}`;
      return;
    }
    await clearStrayDialogs('page start');
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
      jobLog = [];
      // Tell the background this card is taken BEFORE touching it: if opening the card navigates
      // the tab, this script dies mid-flight and the recovery would otherwise reopen the same card
      // forever (bounded only by MAX_RECOVERIES, which ends the run with nothing applied).
      void report({ t: 'linkedin-handled', runId: msg.runId, ids: [id] });
      const outcome = await applyToCard(card, msg.profile, msg.resume, msg.runId);
      if (outcome.kind === 'skip') {
        log('skip', outcome.note);
        skippedIds.push(id);
        if (skippedIds.length % 5 === 0) void report({ t: 'linkedin-handled', runId: msg.runId, ids: skippedIds.splice(0) });
        currentJob = '';
        await pause(600);
        continue;
      }
      const info = li.cardInfo(card);
      const pane = li.paneJob(document);
      const job: LinkedinJob = { id, title: pane.title || info.title || 'LinkedIn job', company: pane.company || info.company || '', url: `https://www.linkedin.com/jobs/view/${id}/` };
      log('outcome', outcome.status, outcome.note ?? '', 'fields', outcome.fields.length, 'sources', summarizeSources(outcome.fields));
      void report({
        t: 'linkedin-result',
        runId: msg.runId,
        job,
        status: outcome.status,
        note: outcome.note,
        fields: outcome.fields,
        log: jobLog.slice(-400),
        resume: outcome.resume,
        location: li.paneLocation(document) || info.location,
        description: li.paneDescription(document),
        capture: outcome.capture,
      });
      currentJob = '';
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

function summarizeSources(fields: readonly AppliedField[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of fields) out[f.source ?? 'unknown'] = (out[f.source ?? 'unknown'] ?? 0) + 1;
  return out;
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

/** A dialog that is not the Easy Apply modal blocks every click on the page: LinkedIn's "Save this
 *  application?" (Discard / Save) after a closed modal, a modal that never finished loading, the
 *  post-submit dialog, a safety reminder. Discard wins over dismiss wins over Escape. Seen live
 *  2026-09-14: the run sat on "Save this application?" for hours because the old discard() only
 *  ran while the (empty, spinner-only) modal counted as open. */
async function clearStrayDialogs(where: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const stray = li.strayDialog(document);
    if (!stray) return;
    const d = li.discardButton(document);
    const x = d ?? li.safetyContinueButton(document) ?? li.dismissButton(document);
    log('stray dialog at', where, JSON.stringify(stray.textContent?.trim().slice(0, 100)), '→', d ? 'Discard' : x ? 'dismiss' : 'Escape');
    if (x) li.click(x);
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    await pause(900);
  }
  if (li.strayDialog(document)) log('WARNING: a dialog is still up after 5 tries', li.describeState(document));
}

async function applyToCard(card: HTMLElement, profile: Profile, resume: Resume, runId: string): Promise<CardOutcome> {
  await clearStrayDialogs('before card');
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
    let opened = false;
    for (let attempt = 0; attempt < OPEN_ATTEMPTS && !opened; attempt++) {
      if (attempt) log('card did not open, retrying with strategy', attempt);
      li.openCard(card, attempt);
      opened = (await waitFor(isOpen, attempt === 0 ? 6000 : 3500).catch(() => false)) === true;
      if (!li.isResultsPage(location.href)) throw new Error(`navigated away while opening the card: ${location.href.slice(0, 120)}`);
    }
    if (!opened) return { kind: 'skip', note: `card did not open after ${OPEN_ATTEMPTS} strategies (url currentJobId=${li.currentJobIdFromUrl(location.href) || 'none'}, pane="${li.paneJob(document).title.slice(0, 50)}")` };
  }
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
      void report({ t: 'linkedin-warning', runId, code: 'pace', detail: `LinkedIn briefly paused Easy Apply (applying too fast) — backing off ${PACE_BACKOFF_MS / 60_000} min, then continuing` });
      await sleep(PACE_BACKOFF_MS);
      return { kind: 'result', status: 'parked', note: 'LinkedIn paused Easy Apply (pace) — backed off, not attempted', fields: [] };
    }
    if (btn.tagName === 'A') {
      btn.click(); // the new layout's <a> sometimes needs a native click
      m = await waitFor(() => li.modal(document), MODAL_WAIT_MS).catch(() => null);
    }
    if (!m) {
      const capture = await captureNow('no-modal');
      await clearStrayDialogs('no modal');
      return { kind: 'result', status: 'failed', note: `Easy Apply modal never opened — ${li.describeState(document)}`, fields: [], capture };
    }
  }
  return driveModal(profile, resume, runId);
}

/** Fill → Next … → Submit inside the open modal. Always leaves the page modal-free. */
async function driveModal(profile: Profile, resume: Resume, runId: string): Promise<CardOutcome> {
  const filled: AppliedField[] = [];
  let resumeUsed = '';
  const fail = async (note: string, status: ApplyStatus = 'failed', end?: LinkedinPageEnd): Promise<CardOutcome> => {
    log('FAIL', note, li.describeState(document));
    const m = li.modal(document);
    if (m) {
      recordPrefilled(m, filled);
      recordUnanswered(m, filled);
    }
    const capture = await captureNow(status);
    await discard();
    return { kind: 'result', status, note, fields: filled, resume: resumeUsed, capture, end };
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
      void report({ t: 'linkedin-warning', runId, code: 'pace', detail: `LinkedIn briefly paused Easy Apply (applying too fast) — backing off ${PACE_BACKOFF_MS / 60_000} min, then continuing` });
      await discard();
      await sleep(PACE_BACKOFF_MS);
      return { kind: 'result', status: 'parked', note: 'LinkedIn paused Easy Apply (pace); retried later', fields: filled, resume: resumeUsed };
    }
    void report({ t: 'linkedin-alive', runId, where: `step ${step}` }); // the watchdog must not reload a tab mid-application
    await settle(m);
    const progress = li.progress(m);
    log('step', step, 'progress', progress, li.describeQuestions(m).slice(0, 1500));

    // Résumé step: reuse the pre-selected card; attach ours only when nothing is selected.
    if (li.resumeInput(m) || li.resumeSelected(m)) {
      if (!li.resumeSelected(m) && li.attachResume(m, deserializeFile(resume))) {
        log('resume attached', resume.name);
        resumeUsed = resume.name;
        upsert(filled, { id: 'resume', label: 'Résumé', value: resume.name, source: 'profile', intent: 'resume', kind: 'file' });
        await pause(3500); // LinkedIn uploads + renders the card
      } else if (!filled.some((f) => f.id === 'resume')) {
        resumeUsed = li.resumeName(m) || "LinkedIn's selected résumé";
        upsert(filled, { id: 'resume', label: 'Résumé', value: `${resumeUsed} (pre-filled)`, source: 'prefilled', intent: 'resume', kind: 'file' });
      }
    }

    try {
      await fillStep(m, profile, job, filled);
    } catch (e) {
      if (!(e instanceof NeedsProfileAnswer)) throw e;
      recordPrefilled(m, filled);
      recordUnanswered(m, filled);
      const capture = await captureNow('needs-profile-answer');
      log('parking:', (e as Error).message);
      await discard();
      return { kind: 'result', status: 'parked', note: `${(e as Error).message} — filled everything else, did not submit`, fields: filled, resume: resumeUsed, capture };
    }

    const action = li.actionButton(m);
    if (!action) return fail(`no Next/Review/Submit button on step ${step} — ${li.describeState(document)}`);
    const signature = `${action.kind}:${progress}:${li.extract(m).map((f) => f.id).join(',')}`;
    seen.set(signature, (seen.get(signature) ?? 0) + 1);
    if ((seen.get(signature) ?? 0) > 3) return fail(`stuck on the same step (${action.kind}, progress ${progress}) — errors: ${li.validationErrors(m).join('; ') || 'none'}`);

    if (action.kind === 'submit') {
      if (li.uncheckFollowCompany(m)) log('unchecked "Follow company"');
      recordPrefilled(m, filled);
      recordUnanswered(m, filled);
      // The review step IS the audit: capture exactly what is about to be submitted.
      const capture = await captureNow('review');
      if (!profile.auto_submit) {
        log('auto_submit off — leaving the modal open for the user');
        return { kind: 'result', status: 'parked', note: 'Filled through Review; auto_submit is off — click "Submit application" yourself (run halted)', fields: filled, resume: resumeUsed, capture, halt: true };
      }
      await pause(800);
      log('clicking Submit application', 'fields', filled.length);
      li.click(action.el);
      // Only a POSITIVE signal counts as submitted. "The modal disappeared" also happens when the
      // Submit click trips LinkedIn's daily cap and the cap dialog replaces the modal — recording
      // that as applied loses the job forever (it lands in the registry and is never retried).
      const done = await waitFor(() => (li.applicationSent(document) ? 'sent' : li.limitReached(document) ? 'limit' : li.modal(document) ? (li.validationErrors(li.modal(document)!).length ? 'errors' : null) : 'gone'), SUBMIT_WAIT_MS).catch(() => 'timeout' as const);
      if (done === 'errors') return fail(`submit rejected: ${li.validationErrors(li.modal(document)!).join('; ')}`);
      if (done === 'limit') return fail("LinkedIn's daily Easy Apply limit hit on Submit — this job was NOT submitted", 'failed', 'limit');
      if (done === 'timeout') return fail(`no confirmation ${SUBMIT_WAIT_MS / 1000}s after Submit — ${li.describeState(document)}`);
      if (done === 'gone') {
        // The modal vanished with no confirmation dialog. Give the dialog a moment; if nothing
        // says "sent", park rather than claim an application that may not exist.
        await pause(2500);
        if (!li.applicationSent(document)) {
          const capture = await captureNow('submit-unconfirmed');
          await clearStrayDialogs('unconfirmed submit');
          return { kind: 'result', status: 'parked', note: `clicked Submit but LinkedIn showed no confirmation — check this job by hand (${li.describeState(document)})`, fields: filled, resume: resumeUsed, capture };
        }
      }
      log('application sent', li.describeState(document));
      await pause(1200);
      await dismissAll();
      await clearStrayDialogs('after submit');
      return { kind: 'result', status: 'applied', fields: filled, resume: resumeUsed, capture };
    }

    log('click', action.kind);
    li.click(action.el);
    await pause(1200);
    const after = li.modal(document);
    const errors = after ? li.validationErrors(after) : [];
    if (errors.length) {
      log('validation errors', errors);
      if (errorRetries++ >= MAX_ERROR_RETRIES) return fail(`LinkedIn rejected the step: ${errors.join('; ')}`);
      try {
        await fixErrors(after!, profile, job, filled, errors);
      } catch (e) {
        if (!(e instanceof NeedsProfileAnswer)) throw e;
        const capture = await captureNow('needs-profile-answer');
        log('parking:', (e as Error).message);
        await discard();
        return { kind: 'result', status: 'parked', note: `${(e as Error).message} — filled everything else, did not submit`, fields: filled, resume: resumeUsed, capture };
      }
      continue; // same step re-evaluated: fill anything still empty, click again
    }
    errorRetries = 0;
    await pause(600);
  }
  if (li.applicationSent(document)) {
    await dismissAll();
    return { kind: 'result', status: 'applied', fields: filled, resume: resumeUsed };
  }
  return fail(`never reached Submit within ${MAX_STEPS} steps`);
}

/** Screenshot (via the background — needs the optional <all_urls> grant) + HTML of the modal and
 *  every open dialog. Best-effort: a failed capture never fails the apply. */
async function captureNow(label: string): Promise<Capture> {
  const html = li.snapshotHtml(document);
  let screenshot: string | undefined;
  if (document.visibilityState === 'visible' && document.hasFocus() !== false) {
    // The background re-checks that the tab it captures is still THIS one: between this call and
    // the capture the user may have switched tabs, and captureVisibleTab would otherwise write a
    // screenshot of their email into the job record.
    const r = await chrome.runtime.sendMessage({ t: 'linkedin-capture' } satisfies Msg).catch((e: Error) => ({ dataUrl: null, error: e.message })) as { dataUrl: string | null; error?: string } | undefined;
    if (r?.dataUrl) screenshot = r.dataUrl;
    else log('screenshot unavailable', r?.error ?? 'no grant');
  } else log('screenshot skipped: tab not visible');
  log('capture', label, 'html', html.length, 'chars', screenshot ? `screenshot ${Math.round(screenshot.length / 1024)} KB` : 'no screenshot');
  return { label, html, ...(screenshot ? { screenshot } : {}) };
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

function upsert(filled: AppliedField[], rec: AppliedField): void {
  const idx = filled.findIndex((f) => f.id === rec.id);
  if (idx >= 0) filled[idx] = { ...filled[idx], ...rec };
  else filled.push(rec);
}

/** Answer every EMPTY question on this step (LinkedIn pre-fills from the last application —
 *  those are kept), plus any ticked opt-in checkbox the profile says to leave off ("Mark job as a
 *  top choice"). Passes: answering one question can reveal (or remove) dependents. */
async function fillStep(m: Element, profile: Profile, job: Job, filled: AppliedField[]): Promise<void> {
  for (let pass = 0; pass < 3; pass++) {
    const todo = li.extract(m).map(withIntent).filter((f) => f.kind !== 'file' && (!li.isAnswered(m, f) || wantsUncheck(m, f, profile, job)));
    if (!todo.length) return;
    for (const field of todo) {
      if (li.isAnswered(m, field) && !wantsUncheck(m, field, profile, job)) continue;
      await answerField(m, field, profile, job, filled, ''); // NeedsProfileAnswer propagates → park
      await pause(350);
    }
    await sleep(400);
  }
}

function wantsUncheck(m: Element, field: Field, profile: Profile, job: Job): boolean {
  if (field.kind !== 'checkbox' || !li.isAnswered(m, field)) return false;
  const a = resolve(field, profile, job, []);
  return a.kind === 'check' && a.value === false;
}

/** Decide + put one answer; records what was typed and where it came from. */
async function answerField(m: Element, field: Field, profile: Profile, job: Job, filled: AppliedField[], hint: string): Promise<boolean> {
  const options = li.optionsFor(m, field);
  const numeric = li.isNumeric(m, field);
  const kind = `${field.kind}${numeric ? '#' : ''}`;
  let answer: Answer = resolve(field, profile, job, options);
  let source: FieldSource = profile.overrides[field.label.trim()] !== undefined ? 'override' : 'profile';
  if (answer.kind === 'unknown' && field.intent && NEVER_GUESS.has(field.intent) && field.required) {
    const key = field.intent.replace(/^answers\./, '');
    log('WILL NOT GUESS', JSON.stringify(field.label), `— add \`answers.${key}\` to profile.yaml`);
    upsert(filled, { id: field.id, label: field.label, value: '', source: 'unanswered', intent: field.intent, options: options.slice(0, 12), kind, error: `no answer: add answers.${key} to profile.yaml (a guess here would misstate your compensation/employer)` });
    throw new NeedsProfileAnswer(`"${field.label}" needs \`answers.${key}\` in profile.yaml`);
  }
  if (answer.kind === 'unknown' && profile.on_unknown === 'guess') {
    const g = guessAnswer(field, options, profile);
    if (g) {
      answer = g;
      source = 'guessed';
    }
  }
  if (answer.kind === 'text') {
    const shaped = shapeText(answer.value, field, profile, hint, numeric);
    if (shaped !== answer.value) {
      log('coerced', JSON.stringify(answer.value.slice(0, 60)), '→', JSON.stringify(shaped.slice(0, 60)), 'hint', hint.slice(0, 80));
      source = source === 'guessed' ? 'guessed' : 'coerced';
      answer = { kind: 'text', value: shaped };
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
  log('field', { id: field.id.slice(-40), label: field.label, kind, intent: field.intent, options: options.slice(0, 8), answer, source, hint });
  const base = { id: field.id, label: field.label, intent: field.intent, options: options.slice(0, 12), kind, ...(hint ? { error: hint.slice(0, 160) } : {}) };
  if (answer.kind === 'unknown' || answer.kind === 'file') {
    log('NO ANSWER', field.required ? 'for REQUIRED question' : 'for optional question', JSON.stringify(field.label), 'intent', field.intent ?? 'none', 'options', options.slice(0, 8));
    upsert(filled, { ...base, value: '', source: 'unanswered' });
    return false;
  }
  try {
    let shownValue = describeAnswer(answer);
    if (li.isTypeaheadField(m, field)) {
      shownValue = await li.fillTypeahead(m, field, answer.kind === 'choice' ? (answer.values[0] ?? '') : answer.kind === 'text' ? answer.value : '');
    } else {
      li.fill(m, field, answer);
      if (!li.isAnswered(m, field) && !(answer.kind === 'check' && !answer.value)) {
        await sleep(300);
        if (!li.isAnswered(m, field)) li.fill(m, field, answer);
      }
    }
    const stuck = answer.kind === 'check' && !answer.value ? li.isAnswered(m, field) : !li.isAnswered(m, field);
    if (stuck) throw new Error('value did not stick');
    upsert(filled, { ...base, value: answer.kind === 'check' && !answer.value ? 'unchecked' : shownValue, source });
    return true;
  } catch (e) {
    log('fill FAILED', field.label, (e as Error).message);
    upsert(filled, { ...base, value: describeAnswer(answer), source: 'unanswered', error: `fill failed: ${(e as Error).message}` });
    return false;
  }
}

/** Reshape a text answer so the box accepts it — the rules are pure and tested in
 *  engine/fit-answer.ts. A number that cannot be made to fit honestly (a salary the box's ceiling
 *  cannot express in any unit) parks the job instead of being clamped into a false figure. */
function shapeText(value: string, field: Field, profile: Profile, hint: string, numeric: boolean): string {
  if (numeric || /whole number|numeric|decimal|enter a number|valid number/i.test(hint)) {
    const fitted = fitNumber(value, field, profile, hint);
    if (fitted === null) {
      const max = maxFromHint(hint);
      throw new NeedsProfileAnswer(`"${field.label}" will not take ${JSON.stringify(value)}${max !== null ? ` (it caps at ${max})` : ''} — answer this one by hand`);
    }
    return fitted;
  }
  return fitText(value, profile, hint);
}

/** LinkedIn named what's wrong: re-answer the questions that carry an error, then anything empty. */
async function fixErrors(m: Element, profile: Profile, job: Job, filled: AppliedField[], errors: string[]): Promise<void> {
  const hint = errors.join(' ');
  // Honour the user's policy: with on_unknown 'park' they asked NOT to have answers invented, and
  // an invented answer to a question LinkedIn just rejected is the most likely one to be wrong.
  const forced: Profile = profile.on_unknown === 'guess' ? { ...profile, on_unknown: 'guess' } : profile;
  for (const field of li.fieldsInError(m).map(withIntent)) {
    const own = li.validationErrors(li.extract(m).length ? (m.querySelector(`[id="${CSS.escape(field.id)}"]`)?.closest('[data-test-form-element], .fb-dash-form-element, fieldset') ?? m) : m).join(' ') || hint;
    log('fixing', field.label, 'error', own.slice(0, 120));
    await answerField(m, field, forced, job, filled, own); // NeedsProfileAnswer propagates → park
  }
  await fillStep(m, forced, job, filled);
}

/** Every question the step shows that we did NOT set (LinkedIn pre-filled) — for the record. */
function recordPrefilled(m: Element, filled: AppliedField[]): void {
  for (const f of li.extract(m).map(withIntent)) {
    if (filled.some((x) => x.id === f.id)) continue;
    const v = li.currentAnswer(m, f);
    if (v) filled.push({ id: f.id, label: f.label, value: `${v} (pre-filled)`, source: 'prefilled', intent: f.intent, options: li.optionsFor(m, f).slice(0, 12), kind: f.kind });
  }
}

/** Required questions still empty at this point (the form may refuse them) — for the review file. */
function recordUnanswered(m: Element, filled: AppliedField[]): void {
  for (const f of li.extract(m).map(withIntent)) {
    if (f.kind === 'file' || li.isAnswered(m, f)) continue;
    if (filled.some((x) => x.id === f.id && x.source === 'unanswered')) continue;
    upsert(filled, { id: f.id, label: f.label, value: '', source: 'unanswered', intent: f.intent, options: li.optionsFor(m, f).slice(0, 12), kind: f.kind });
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

/** Abandon an unfinished application: × → "Discard" (or "Save this application?" → Discard).
 *  Never leaves a modal or a confirm behind — not even a spinner-only one. */
async function discard(): Promise<void> {
  for (let i = 0; i < 3 && (li.modal(document) || li.openDialogs(document).length); i++) {
    const d = li.discardButton(document);
    if (d) {
      li.click(d);
      await pause(800);
      continue;
    }
    const x = li.dismissButton(document);
    if (x) li.click(x);
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    await pause(800);
    const confirm = li.discardButton(document);
    if (confirm) {
      li.click(confirm);
      await pause(800);
    }
  }
  await clearStrayDialogs('after discard');
  if (li.modal(document)) log('WARNING: modal still open after discard', li.describeState(document));
}

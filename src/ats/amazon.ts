import { labelText, setReactValue } from './dom';
import type { Answer, Field, FieldKind } from '../engine/types';

// Amazon apply adapter — pure DOM, no chrome/network, so it unit-tests in happy-dom.
//
// amazon.jobs applies through its own React app at /applicant/jobs/<id>/apply (NOT Greenhouse).
// Everything below was read out of the app's bundle (static.account.amazon.jobs …/apply-*.js)
// and its /api/apply/forms response, captured 2026-09-02:
//   - The page is a list of "forms" (Contact info, General questions, Education, Job-specific
//     questions, Work eligibility, Resume, Acknowledgement, Voluntary self-ID ×2). Exactly ONE is
//     active/editable at a time: `.card.question-form.active`; the rest render read-only
//     (`.input-display-mode`). Clicking the active form's Continue saves it (POST forms/save) and
//     activates the next incomplete one; once none is left the page enters review mode
//     (`.question-forms.reviewing`) and shows `.submit-application-button button.submit`.
//   - Every question sits in `div.question[data-questionId=<id>]`, label in `.question-label`
//     (`.required` when mandatory). Input by question type:
//       DROPDOWN             native <select> inside .drop-down-menu, enhanced by select2 — the app
//                            listens to jQuery `change`, so set .value + dispatch change.
//       MULTISELECT_DROPDOWN native <select multiple> inside .multiselect-drop-down-menu.
//       RADIO_BUTTON         input[type=radio][name=<id>][value=<optionKey>] + label (title).
//       BOOLEAN              one checkbox in .check-box (question text is the checkbox label).
//       CHECK_LIST           checkbox per option, data-testid="<id>-<key>".
//       TEXT/TEXTAREA        plain React-controlled inputs.
//     Dependent questions ("If Other, please specify") are simply not rendered until triggered.
//   - Answers from a previous application are reused, so most forms arrive pre-filled; only the
//     per-job "Job-specific questions" (ids ending in -AQ) are reliably empty.
//   - Already applied → /apply redirects to /summary?result=duplicate (ApplicationDuplicateScreen).
//     Submit success → the app *navigates* to a success link (the content script dies mid-answer;
//     the background treats the closed port + new URL as success, see app/ports.ts).
//   - A one-time "may we use AI to recommend jobs" modal (#aiPreferenceModal) can gate submit.
// This module only locates/reads/sets controls; the content script drives the form→form loop.

/** Visible = actually laid out (offsetParent) and not under a [hidden] ancestor. */
export function shown(el: Element | null): el is HTMLElement {
  if (!el) return false;
  if (el.closest('[hidden]')) return false;
  const h = el as HTMLElement;
  return h.offsetParent !== null || h.getClientRects().length > 0;
}

/** The one form currently open for editing. */
export function activeForm(doc: Document): HTMLElement | null {
  return [...doc.querySelectorAll<HTMLElement>('.question-form.active')].find(shown) ?? null;
}

/** Stable identity for a form card (its `formN` index class + heading), to notice when Continue
 *  actually advanced to the next form. */
export function formKey(form: Element): string {
  const idx = [...form.classList].find((c) => /^form\d+$/.test(c)) ?? '';
  const heading = form.querySelector('.card-header, h1, h2, h3, h4');
  return `${idx}:${heading ? labelText(heading).slice(0, 60) : ''}`;
}

/** Review mode = every form saved. The bundle renders `.submit-application-button` ONLY when
 *  activeFormIndex === NO_ACTIVE_FORM (never as a disabled placeholder earlier), so its presence
 *  is as good a signal as the `reviewing` class. */
export function reviewMode(doc: Document): boolean {
  return !!doc.querySelector('.question-forms.reviewing') || !!doc.querySelector('.submit-application-button');
}

export function questionNodes(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-questionid]')].filter(shown);
}

function questionNode(doc: Document, id: string): HTMLElement | null {
  return doc.querySelector<HTMLElement>(`[data-questionid="${id}"]`);
}

function kindOf(node: HTMLElement): FieldKind | null {
  if (node.querySelector('select[multiple]')) return 'multiselect';
  if (node.querySelector('select')) return 'select';
  if (node.querySelector('input[type="radio"]')) return 'select';
  const boxes = node.querySelectorAll('input[type="checkbox"]');
  if (boxes.length === 1) return 'checkbox';
  if (boxes.length > 1) return 'multiselect';
  if (node.querySelector('textarea')) return 'text';
  const input = node.querySelector<HTMLInputElement>('input');
  if (!input) return null;
  const t = (input.getAttribute('type') || 'text').toLowerCase();
  if (t === 'email' || t === 'tel') return t;
  if (t === 'text' || t === 'number') return 'text';
  return null; // date pickers, file inputs, hidden — not ours to fill
}

function toField(node: HTMLElement): Field | null {
  const id = node.getAttribute('data-questionid') ?? '';
  const kind = kindOf(node);
  if (!id || !kind) return null;
  const labelBox = node.querySelector('.question-label');
  // BOOLEAN questions render no .question-label; their text is the checkbox's own label.
  const labelEl = labelBox?.querySelector('label') ?? labelBox ?? node.querySelector('.check-box .question-text') ?? node.querySelector('label');
  const label = (labelEl ? labelText(labelEl) : '').replace(/^Q\.\s*/, '').trim();
  const required =
    !!labelBox?.classList.contains('required') || !!node.querySelector('[aria-required="true"], [required]');
  return { id, label, kind, required };
}

/** Every fillable question rendered in `root` (the active form, normally). */
export function extract(root: ParentNode): Field[] {
  return questionNodes(root).flatMap((n) => {
    const f = toField(n);
    return f ? [f] : [];
  });
}

function optionLabel(node: Element, input: HTMLInputElement): string {
  const byFor = input.id ? node.querySelector(`label[for="${input.id}"]`) : null;
  const el = byFor ?? input.closest('.custom-control')?.querySelector('label') ?? input.parentElement;
  return el ? labelText(el) : '';
}

function choiceInputs(node: Element): HTMLInputElement[] {
  return [...node.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]')];
}

/** The choices a select/radio/check-list question offers, as the user sees them. */
export function optionsFor(doc: Document, field: Field): string[] {
  const node = questionNode(doc, field.id);
  if (!node) return [];
  const select = node.querySelector<HTMLSelectElement>('select');
  if (select) return [...select.options].map((o) => o.text.trim()).filter(Boolean);
  return choiceInputs(node).map((i) => optionLabel(node, i)).filter(Boolean);
}

/** True when the question already holds a value (reused from a previous application). */
export function isAnswered(doc: Document, field: Field): boolean {
  const node = questionNode(doc, field.id);
  if (!node) return false;
  const select = node.querySelector<HTMLSelectElement>('select');
  if (select) return [...select.options].some((o) => o.selected && o.value !== '');
  const boxes = choiceInputs(node);
  if (boxes.length) return boxes.some((b) => b.checked);
  const text = node.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
  return !!text && text.value.trim() !== '';
}

function findOption<T>(items: readonly T[], text: (t: T) => string, wanted: string): T | undefined {
  const w = wanted.trim().toLowerCase();
  return (
    items.find((i) => text(i).trim().toLowerCase() === w) ??
    items.find((i) => {
      const t = text(i).trim().toLowerCase();
      return t !== '' && (t.includes(w) || w.includes(t));
    })
  );
}

function fillSelect(select: HTMLSelectElement, values: readonly string[]): void {
  const opts = [...select.options];
  const picked = values.map((v) => {
    const o = findOption(opts, (x) => x.text, v);
    if (!o) throw new Error(`no option "${v}" (have: ${opts.map((x) => x.text).filter(Boolean).join(' | ')})`);
    return o;
  });
  if (select.multiple) for (const o of opts) o.selected = picked.includes(o);
  else select.value = picked[0]!.value;
  // select2 + the app's jQuery listener both hang off the native change event.
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function fillChoices(node: HTMLElement, values: readonly string[]): void {
  const inputs = choiceInputs(node);
  if (inputs.length === 0) throw new Error('no options rendered');
  for (const v of values) {
    const input = findOption(inputs, (i) => optionLabel(node, i), v);
    if (!input) throw new Error(`no option "${v}" (have: ${inputs.map((i) => optionLabel(node, i)).join(' | ')})`);
    if (!input.checked) input.click(); // a real click: sets checked + fires React's onChange
  }
}

/** Put an answer into a question. Throws when the DOM offers no matching control/option. */
export function fill(doc: Document, field: Field, answer: Answer): void {
  const node = questionNode(doc, field.id);
  if (!node) throw new Error(`question ${field.id} not in DOM`);
  switch (answer.kind) {
    case 'choice': {
      const select = node.querySelector<HTMLSelectElement>('select');
      if (select) fillSelect(select, answer.values);
      else fillChoices(node, answer.values);
      return;
    }
    case 'check': {
      const box = node.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (!box) throw new Error('no checkbox');
      if (box.checked !== answer.value) box.click();
      return;
    }
    case 'text': {
      const input = node.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
      if (!input) throw new Error('no text input');
      setReactValue(input, answer.value);
      return;
    }
    default:
      throw new Error(`cannot fill ${field.id} with a ${answer.kind} answer`);
  }
}

const CONTINUE = /continue|^next$|start questionnaire/i;

/** The active form's save-and-advance control. Desktop renders a <button> in .submit-button,
 *  narrow layouts an <a.btn>; a "Skip & continue" also exists on optional forms — never that. */
export function continueButton(form: Element): HTMLElement | null {
  const all = [...form.querySelectorAll<HTMLElement>('button, a.btn')];
  return all.find((b) => shown(b) && CONTINUE.test(labelText(b)) && !/skip/i.test(labelText(b))) ?? null;
}

/** The final "Submit application" button, only once enabled. */
export function submitButton(doc: Document): HTMLButtonElement | null {
  const b = doc.querySelector<HTMLButtonElement>('.submit-application-button button');
  return b && shown(b) && !b.disabled ? b : null;
}

/** Inline validation / server errors currently visible under `root`. */
export function validationErrors(root: ParentNode): string[] {
  return [...root.querySelectorAll<HTMLElement>('.invalid-feedback.show-invalid, .show-invalid, .form-error, .alert-danger, .toast-error, .consent-error')]
    .filter(shown)
    .map(labelText)
    .filter(Boolean);
}

/** "You have already applied for this position" — the apply URL redirected to the summary. */
export function isDuplicate(doc: Document): boolean {
  return !!doc.querySelector('[data-react-class="ApplicationDuplicateScreen"]');
}

export function isApplyPage(url: string): boolean {
  return /amazon\.jobs\/(?:[a-z-]+\/)?applicant\/jobs\/\d+\/apply/i.test(url);
}

/** Did the tab leave the apply page for a post-submit page? (Not duplicate/limit screens.) */
export function submittedByNavigation(url: string): boolean {
  if (!/^https:\/\/(www\.)?amazon\.jobs\//i.test(url)) return false;
  if (isApplyPage(url)) return false;
  if (/result=(duplicate|application_limit_reach)/.test(url)) return false;
  return /\/applicant\//i.test(url);
}

// --- AI-preference modal (#aiPreferenceModal): step 1 asks Yes/No (radios #consent-yes/#consent-no
// + a submit button); saying No opens step 2 "Are you sure?" (#decline-confirm/#decline-change).

export type AiConsentStep = 'choice' | 'confirm';

export function aiConsentStep(doc: Document): AiConsentStep | null {
  const modal = doc.querySelector<HTMLElement>('#aiPreferenceModal');
  if (!modal || !shown(modal)) return null;
  if (modal.querySelector('#decline-confirm')) return 'confirm';
  if (modal.querySelector('#consent-yes')) return 'choice';
  return null;
}

/** Answer whichever step is showing: consent → Yes; no consent → No, then confirm the decline. */
export function answerAiConsent(doc: Document, consent: boolean): void {
  const modal = doc.querySelector<HTMLElement>('#aiPreferenceModal');
  const step = aiConsentStep(doc);
  if (!modal || !step) return;
  const radio = modal.querySelector<HTMLInputElement>(step === 'confirm' ? '#decline-confirm' : consent ? '#consent-yes' : '#consent-no');
  if (radio && !radio.checked) radio.click();
  modal.querySelector<HTMLElement>('.modal-footer button[type="submit"], button[type="submit"]')?.click();
}

/** The "My progress" rail, for logs/records: which forms are done, which is active. */
export function progress(doc: Document): { id: string; title: string; state: 'active' | 'finished' | 'pending' }[] {
  return [...doc.querySelectorAll<HTMLElement>('li.form-list-item')].map((li) => ({
    id: (li.id || '').replace(/^NAV_/, ''),
    title: labelText(li.querySelector('.form-link') ?? li).slice(0, 80),
    state: li.classList.contains('active') ? 'active' : /finished/.test(li.className) ? 'finished' : 'pending',
  }));
}

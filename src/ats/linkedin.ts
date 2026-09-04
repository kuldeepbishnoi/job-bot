import type { Answer, Field } from '../engine/types';
import { click, setFile, setReactValue } from './dom';

// LinkedIn Easy Apply adapter — pure DOM, no chrome/network, so it unit-tests in happy-dom.
//
// Ground truth (from two shipping auto-apply extensions' adapters, 2026-09; see CLAUDE.md):
//   - Two layouts. Legacy `/jobs/search/` (+ `/jobs/collections/*`): cards are
//     `li[data-occludable-job-id]`, the details pane holds `button.jobs-apply-button` ("Easy Apply"),
//     the modal is `.jobs-easy-apply-modal` in the light DOM. New `/jobs/search-results/`: cards are
//     `div[componentkey="job-card-component-ref-<id>"][role=button]`, the Easy Apply control is an
//     `<a aria-label="Easy Apply to this job">` and the modal is mounted in an OPEN shadow root at
//     `#interop-outlet` — plain querySelector never sees it. Every lookup here searches both.
//   - Modal steps: each question is a `[data-test-form-element]` block: text/number input
//     (`.artdeco-text-input--input`, numeric ids end in `-numeric`), native `<select>`
//     (`[data-test-text-entity-list-form-select]`, first option "Select an option"), radio fieldset
//     (`[data-test-form-builder-radio-button-form-component]`, option text in
//     `data-test-text-selectable-option__input`), checkbox fieldset (`[data-test-checkbox-form-component]`),
//     city typeahead (`input[role=combobox]` + `[role=listbox] [role=option]`), résumé
//     (`.jobs-document-upload-redesign-card__container--selected` or `input[type=file]`).
//   - Footer buttons by aria-label: "Continue to next step" / "Review your application" /
//     "Submit application" (also `data-live-test-easy-apply-*-button`). `#follow-company-checkbox`
//     is pre-checked. Errors: `.artdeco-inline-feedback--error .artdeco-inline-feedback__message`.
//   - After Submit a "Your application was sent" dialog appears (`button[aria-label=Dismiss]`).
//     Dismissing an unfinished modal pops a Discard confirm (`discard_application_confirm_btn`).
//   - Limits: "You've reached today's Easy Apply limit" dialog; "applying at a fast pace" pause.
// This module only locates controls, reads questions and fills them; the content script drives
// the card → modal → submit loop and the pacing.

// ---------- roots (light DOM + the new layout's open shadow root) ----------

export function roots(doc: Document): ParentNode[] {
  const out: ParentNode[] = [doc];
  const sr = doc.getElementById('interop-outlet')?.shadowRoot;
  if (sr) out.push(sr);
  return out;
}

function qa<T extends Element = HTMLElement>(doc: Document, selector: string): T[] {
  const seen = new Set<Element>();
  const out: T[] = [];
  for (const r of roots(doc)) for (const el of r.querySelectorAll<T>(selector)) if (!seen.has(el)) (seen.add(el), out.push(el));
  return out;
}

/** Visible = laid out (happy-dom has no layout, so tests give nodes a rect) and not aria-hidden. */
export function shown(el: Element | null | undefined): el is HTMLElement {
  if (!el) return false;
  if (el.closest('[hidden], [aria-hidden="true"]')) return false;
  const h = el as HTMLElement;
  return h.offsetParent !== null || el.getClientRects().length > 0;
}

const firstShown = (doc: Document, selector: string): HTMLElement | null => qa(doc, selector).find((e) => shown(e)) ?? null;

/** Text with a space between elements (`textContent` glues "…agoEasy Apply" together, which
 *  breaks every word-boundary regex below; `innerText` needs layout, which happy-dom lacks). */
function text(el: Element | null | undefined): string {
  if (!el) return '';
  const parts: string[] = [];
  const walk = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) parts.push(n.textContent ?? '');
    else for (const c of n.childNodes) walk(c);
  };
  walk(el);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// ---------- job list ----------

export interface CardInfo {
  readonly id: string;
  readonly title: string;
  readonly company: string;
  readonly location: string;
  /** true/false when the card says so; null when the card isn't hydrated yet (legacy virtual list). */
  readonly easyApply: boolean | null;
  readonly applied: boolean;
}

const CARD_SELECTORS = [
  'li[data-occludable-job-id]',
  'div[componentkey^="job-card-component-ref-"]',
  '.job-card-container[data-job-id]',
  '.jobs-search-results__list-item',
].join(', ');

/** Every job card on the current results page, in list order (unhydrated legacy cards included). */
export function jobCards(doc: Document): HTMLElement[] {
  const cards = qa(doc, CARD_SELECTORS).filter((c) => !c.parentElement?.closest(CARD_SELECTORS));
  return cards.filter((c) => cardJobId(c) !== '');
}

export function cardJobId(card: Element): string {
  const direct = card.getAttribute('data-occludable-job-id') ?? card.getAttribute('data-job-id');
  if (direct) return direct;
  const key = card.getAttribute('componentkey') ?? '';
  const fromKey = /(\d{6,})/.exec(key)?.[1];
  if (fromKey) return fromKey;
  const inner = card.querySelector('[data-job-id]')?.getAttribute('data-job-id');
  if (inner) return inner;
  const href = card.querySelector<HTMLAnchorElement>('a[href*="/jobs/view/"], a[href*="currentJobId="]')?.getAttribute('href') ?? '';
  return /\/jobs\/view\/(\d{6,})/.exec(href)?.[1] ?? /[?&]currentJobId=(\d{6,})/.exec(href)?.[1] ?? '';
}

const EASY_APPLY = /\beasy\s*apply\b/i;
const APPLIED_CARD = /\bapplied\b\s*[·•|]|\bapplication submitted\b|\bapplied\s+\d+\s*(?:minute|hour|day|week|month)s?\s+ago/i;

/** Title / company / location + the Easy Apply and Applied badges, from the card alone. */
export function cardInfo(card: Element): CardInfo {
  const id = cardJobId(card);
  const body = text(card);
  // Legacy: LinkedIn renders the title twice (visible + a11y copy) — take the first link/strong.
  let title = text(
    card.querySelector('.job-card-list__title--link strong, .job-card-list__title strong, .job-card-container__link strong, .artdeco-entity-lockup__title strong, .job-card-list__title, .artdeco-entity-lockup__title, a[href*="/jobs/view/"]'),
  );
  let company = text(card.querySelector('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle, .job-card-container__company-name'));
  let location = text(card.querySelector('.job-card-container__metadata-item, .artdeco-entity-lockup__caption, .job-card-container__metadata-wrapper li'));
  if (!title) {
    // New layout: positional paragraphs — title, company, location.
    const ps = [...card.querySelectorAll('p')].map((p) => text(p)).filter(Boolean);
    title = dedupeDoubled(ps[0] ?? '');
    company = company || (ps[1] ?? '');
    location = location || (ps[2] ?? '');
  }
  title = dedupeDoubled(title.replace(/\s+with verification\b.*$/i, '')).trim();
  const hydrated = body.length >= 20;
  const easyApply = !hydrated
    ? null
    : EASY_APPLY.test(body) ||
      !!card.querySelector('.job-card-container__apply-method, [class*="apply-method"], li-icon[type*="linkedin-bug"], svg[data-test-icon*="linkedin-bug"]');
  return { id, title, company, location, easyApply, applied: APPLIED_CARD.test(body) };
}

/** "Data Analyst Data Analyst" (a11y duplicate glued to the visible title) → "Data Analyst". */
function dedupeDoubled(s: string): string {
  const t = s.trim();
  if (t.length % 2 === 1) {
    const half = t.slice(0, (t.length - 1) / 2);
    if (t === `${half} ${half}`) return half;
  }
  return t;
}

/** The card's clickable link (legacy) or the card itself (new layout). */
export function cardLink(card: Element): HTMLElement {
  return (card.querySelector<HTMLElement>('a.job-card-container__link, a.job-card-list__title--link, a[href*="/jobs/view/"], a') as HTMLElement | null) ?? (card as HTMLElement);
}

export function currentJobIdFromUrl(url: string): string {
  return /[?&]currentJobId=(\d{6,})/.exec(url)?.[1] ?? /\/jobs\/view\/(\d{6,})/.exec(url)?.[1] ?? '';
}

/** The list's own "next page" control (legacy pager / new-layout page buttons). */
export function nextPageButton(doc: Document): HTMLElement | null {
  const explicit = firstShown(doc, '.jobs-search-pagination__button--next, button[aria-label="View next page"], [class*="pagination"] button[aria-label="Next"]');
  if (explicit && !(explicit as HTMLButtonElement).disabled) return explicit;
  const pages = qa<HTMLButtonElement>(doc, 'button[aria-label^="Page "]').filter((b) => shown(b));
  const active = pages.find((b) => b.getAttribute('aria-current') === 'true' || b.classList.contains('active'));
  if (!active) return null;
  const n = Number(/Page (\d+)/.exec(active.getAttribute('aria-label') ?? '')?.[1] ?? 0);
  return pages.find((b) => b.getAttribute('aria-label') === `Page ${n + 1}`) ?? null;
}

// ---------- job details pane ----------

const DETAIL_SCOPE = '.jobs-search__job-details, .scaffold-layout__detail, .job-view-layout, .jobs-details, .jobs-unified-top-card, .job-details-jobs-unified-top-card__container--two-pane';

/** The Easy Apply control for the job shown in the details pane — never the "Easy Apply filter"
 *  chip, never an external "Apply" link. */
export function easyApplyButton(doc: Document): HTMLElement | null {
  const inScope = (el: Element): boolean => !!el.closest(DETAIL_SCOPE) || !el.closest('.search-reusables__filter-list, .jobs-search-box, header');
  const isFilter = (el: Element): boolean => /filter/i.test(el.getAttribute('aria-label') ?? '') || !!el.closest('[class*="filter"]');
  const candidates = qa<HTMLElement>(doc, 'button.jobs-apply-button, a[aria-label*="Easy Apply" i], button[aria-label*="Easy Apply" i], a[href*="openSDUIApplyFlow=true"], .jobs-apply-button--top-card button, .jobs-s-apply button');
  for (const el of candidates) {
    if (!shown(el) || isFilter(el) || !inScope(el)) continue;
    const aria = el.getAttribute('aria-label') ?? '';
    const href = el.getAttribute('href') ?? '';
    if (EASY_APPLY.test(aria) || EASY_APPLY.test(text(el)) || /openSDUIApplyFlow=true/.test(href)) return el;
  }
  // Text fallback, scoped to the details pane so a sidebar "Easy Apply" never matches.
  for (const el of qa<HTMLElement>(doc, `${DETAIL_SCOPE.split(', ').map((s) => `${s} button, ${s} a`).join(', ')}`)) {
    if (shown(el) && !isFilter(el) && /^\s*easy\s*apply\s*$/i.test(text(el))) return el;
  }
  return null;
}

/** The details pane shows an external "Apply" (company site) instead of Easy Apply. */
export function externalApplyOnly(doc: Document): boolean {
  if (easyApplyButton(doc)) return false;
  return qa<HTMLElement>(doc, 'button.jobs-apply-button, .jobs-apply-button--top-card button, a.jobs-apply-button').some((el) => shown(el) && /^\s*apply\b/i.test(text(el)) && !EASY_APPLY.test(text(el) + (el.getAttribute('aria-label') ?? '')));
}

const CLOSED = /no longer accepting|unable to apply|position filled|no longer available|not accepting applications/i;

/** "No longer accepting applications" and friends, from the details pane. */
export function jobClosedMessage(doc: Document): string {
  for (const el of qa(doc, '.jobs-unavailable__text, .jobs-apply-button--blocked, .jobs-details-top-card__apply-error, .jobs-apply-button-extensions__error-text, [data-test-top-banner-message], .artdeco-inline-feedback__message, [role="alert"]')) {
    const t = text(el);
    if (shown(el) && CLOSED.test(t)) return t.slice(0, 120);
  }
  return '';
}

/** The pane says we already applied ("Applied 3 days ago" / "Application submitted"). */
export function alreadyAppliedPane(doc: Document): boolean {
  const pane = qa(doc, DETAIL_SCOPE).find((p) => shown(p));
  const t = text(pane ?? null);
  return /application status[\s\S]{0,40}application submitted|you applied[\s\S]{0,30}ago|application sent[\s\S]{0,30}ago|applied\s+\d+\s*(?:minute|hour|day|week|month)s?\s+ago/i.test(t);
}

/** Title + company of the job in the details pane (falls back to the card info the loop keeps). */
export function paneJob(doc: Document): { title: string; company: string } {
  const title = text(firstShown(doc, '.job-details-jobs-unified-top-card__job-title h1, .job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title, .t-24.job-details-jobs-unified-top-card__job-title, h1.t-24, .jobs-details-top-card__job-title'));
  const company = text(firstShown(doc, '.job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name, .job-details-jobs-unified-top-card__primary-description-container a, .jobs-details-top-card__company-url'));
  return { title, company };
}

// ---------- modal ----------

const MODAL_SELECTORS = [
  '.jobs-easy-apply-modal',
  '[data-test-modal-id="easy-apply-modal"]',
  '[data-test-modal-container][data-test-modal-id*="easy-apply"]',
  '.jobs-easy-apply-two-pane',
  'dialog[data-testid="dialog"][open]',
  '[role="dialog"]',
  '[aria-modal="true"]',
].join(', ');

/** The open Easy Apply modal (light DOM or the new layout's shadow root), or null. A generic
 *  dialog counts only when it carries the Easy Apply fingerprint (form controls / step buttons). */
export function modal(doc: Document): HTMLElement | null {
  for (const el of qa<HTMLElement>(doc, MODAL_SELECTORS)) {
    if (!shown(el)) continue;
    if (el.matches('.jobs-easy-apply-modal, [data-test-modal-id="easy-apply-modal"], .jobs-easy-apply-two-pane') || el.closest('.jobs-easy-apply-modal')) return el;
    if (el.querySelector('.jobs-easy-apply-modal, .jobs-easy-apply-content')) return el.querySelector<HTMLElement>('.jobs-easy-apply-modal') ?? el;
    if (el.querySelector('[data-sdui-screen*="EasyApply"], [class*="easy-apply" i], [class*="jobs-apply" i], button[data-live-test-easy-apply-submit-button], form input[type="file"][name*="resume" i]')) return el;
    if (/^(dialog content start\.\s*)?apply to\b/i.test(text(el)) || /^apply to\b/i.test(text(el.querySelector('h1, h2, h3')))) return el;
    if (actionButton(el)) return el;
  }
  return null;
}

/** "Job safety reminder" interstitial — click its "Continue applying". */
export function safetyContinueButton(doc: Document): HTMLElement | null {
  const dialog = qa<HTMLElement>(doc, '.job-trust-pre-apply-safety-tips-modal__content, [data-sdui-screen*="PreApplySafetyTipsModal"], [role="dialog"], .artdeco-modal').find((d) => shown(d) && /safety reminder|safety tips|continue applying/i.test(text(d)));
  if (!dialog) return null;
  const root = dialog.closest<HTMLElement>('dialog[open], [role="dialog"], .artdeco-modal') ?? dialog;
  return [...root.querySelectorAll<HTMLElement>('button, a')].find((b) => shown(b) && /continue applying|^continue$/i.test(text(b))) ?? null;
}

/** 0-100 from the modal's completeness meter, or -1 when it has none. */
export function progress(m: Element): number {
  const bar = m.querySelector<HTMLElement>('progress, [role="progressbar"], .artdeco-completeness-meter-linear__progress-element');
  if (!bar) return -1;
  const v = bar.getAttribute('aria-valuenow') ?? bar.getAttribute('value');
  return v === null || v === '' ? -1 : Number(v);
}

export type ActionKind = 'next' | 'review' | 'submit';

/** The modal's one footer action: Submit wins over Review wins over Next. */
export function actionButton(m: Element): { kind: ActionKind; el: HTMLButtonElement } | null {
  const find = (selectors: string, re: RegExp): HTMLButtonElement | null => {
    const bySel = [...m.querySelectorAll<HTMLButtonElement>(selectors)].find((b) => shown(b));
    if (bySel) return bySel;
    return [...m.querySelectorAll<HTMLButtonElement>('button')].find((b) => shown(b) && re.test(text(b))) ?? null;
  };
  const submit = find('button[aria-label="Submit application"], button[data-easy-apply-submit-button], button[data-live-test-easy-apply-submit-button]', /^submit( application)?$/i);
  if (submit) return { kind: 'submit', el: submit };
  const review = find('button[aria-label="Review your application"], button[data-easy-apply-review-button], button[data-live-test-easy-apply-review-button]', /^review( your application)?$/i);
  if (review) return { kind: 'review', el: review };
  const next = find('button[aria-label="Continue to next step"], button[data-easy-apply-next-button], button[data-live-test-easy-apply-next-button]', /^next$/i);
  if (next) return { kind: 'next', el: next };
  return null;
}

/** The pre-checked "Follow <company>" box on the review step. */
export function followCompanyCheckbox(m: Element): HTMLInputElement | null {
  return m.querySelector<HTMLInputElement>('#follow-company-checkbox, input[type="checkbox"][id*="follow-company"], input[type="checkbox"][name*="followCompany"], input[data-test-follow-company-checkbox]');
}

/** Uncheck "Follow company" via its label (React's tracker ignores `.checked = false`). */
export function uncheckFollowCompany(m: Element): boolean {
  const box = followCompanyCheckbox(m);
  if (!box || !box.checked) return false;
  const label = box.id ? m.querySelector<HTMLElement>(`label[for="${box.id}"]`) : null;
  click(label ?? box);
  return true;
}

/** Visible validation messages inside the modal ("Enter a whole number between 0 and 99"). */
export function validationErrors(m: Element): string[] {
  const out = new Set<string>();
  for (const el of m.querySelectorAll('.artdeco-inline-feedback--error .artdeco-inline-feedback__message, .artdeco-inline-feedback--error, .fb-dash-form-element__error, [data-test-form-element-error-messages], [role="alert"]')) {
    const t = text(el);
    if (t && shown(el)) out.add(t.slice(0, 160));
  }
  return [...out];
}

// ---------- questions ----------

/** Question blocks on the current step, in order. Legacy tags them; the SDUI layout does not,
 *  so fall back to "the closest ancestor that also holds the control's label". */
export function questionBlocks(m: Element): HTMLElement[] {
  const tagged = [...m.querySelectorAll<HTMLElement>('[data-test-form-element], .fb-dash-form-element, .jobs-easy-apply-form-element')].filter((b) => !b.parentElement?.closest('[data-test-form-element], .fb-dash-form-element'));
  if (tagged.length) return tagged.filter((b) => shown(b));
  const blocks: HTMLElement[] = [];
  for (const c of m.querySelectorAll<HTMLElement>('select, textarea, input:not([type="hidden"])')) {
    if (c.id === 'follow-company-checkbox') continue;
    const fs = c.closest<HTMLElement>('fieldset');
    let block: HTMLElement | null = fs?.parentElement ?? null;
    if (!block) {
      let cur: HTMLElement | null = c.parentElement;
      while (cur && cur !== m && !(c.id && cur.querySelector(`label[for="${c.id}"]`))) cur = cur.parentElement;
      block = cur && cur !== m ? cur : c.parentElement;
    }
    if (block && !blocks.includes(block) && shown(block)) blocks.push(block);
  }
  return blocks;
}

const PLACEHOLDER = /^(select an option|select|choose|please select|--)\b/i;

function blockLabel(block: Element): string {
  const el = block.querySelector('legend, .artdeco-text-input--label, .fb-dash-form-element__label, [data-test-text-entity-list-form-title], [data-test-checkbox-form-title], [data-test-form-builder-radio-button-form-component] legend, label');
  let t = text(el);
  if (!t) t = text(block.querySelector('p, span'));
  return dedupeDoubled(t.replace(/\s*\*?\s*required\s*$/i, '')).slice(0, 200);
}

function controlOf(block: Element): HTMLElement | null {
  return block.querySelector<HTMLElement>('input[role="combobox"], input[aria-autocomplete="list"], select, textarea, input[type="text"], input[type="number"], input[type="tel"], input[type="email"], input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="file"]), input[type="file"]');
}

function radios(block: Element): HTMLInputElement[] {
  return [...block.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
}
function checkboxes(block: Element): HTMLInputElement[] {
  return [...block.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].filter((c) => c.id !== 'follow-company-checkbox');
}
function optionLabel(input: HTMLInputElement, block: Element): string {
  return (
    input.getAttribute('data-test-text-selectable-option__input') ??
    text(input.id ? block.querySelector(`label[for="${input.id}"]`) : null) ??
    ''
  ) || text(input.closest('label') ?? input.parentElement?.querySelector('label') ?? null) || input.value;
}

/** Every question on the current step as a Field. Ids are stable per job (LinkedIn's urn-based
 *  element ids) so the loop can dedupe and verify. Radios → `select`; checkbox groups →
 *  `multiselect`; a lone checkbox → `checkbox`; typeahead → `select` with no options (typed). */
export function extract(m: Element): Field[] {
  const out: Field[] = [];
  for (const block of questionBlocks(m)) {
    const label = blockLabel(block);
    const required = /\*|required/i.test(text(block.querySelector('legend, label, .fb-dash-form-element__label, .artdeco-text-input--label'))) || !!block.querySelector('[required], [aria-required="true"]');
    const r = radios(block);
    if (r.length) {
      out.push({ id: r[0]!.name || r[0]!.id, label, kind: 'select', required: true, intent: undefined });
      continue;
    }
    const cb = checkboxes(block);
    if (cb.length > 1) {
      out.push({ id: cb[0]!.name || cb[0]!.id, label, kind: 'multiselect', required, intent: undefined });
      continue;
    }
    if (cb.length === 1) {
      const c = cb[0]!;
      out.push({ id: c.id || c.name, label: label || optionLabel(c, block), kind: 'checkbox', required, intent: undefined });
      continue;
    }
    const c = controlOf(block);
    if (!c) continue;
    if (c instanceof HTMLInputElement && c.type === 'file') {
      out.push({ id: c.id || 'resume', label: label || 'Resume', kind: 'file', required, intent: 'resume' });
      continue;
    }
    if (c instanceof HTMLSelectElement) {
      out.push({ id: c.id, label, kind: 'select', required: true, intent: undefined });
      continue;
    }
    if (isTypeahead(c)) {
      out.push({ id: c.id, label, kind: 'select', required: true, intent: undefined });
      continue;
    }
    const kind = c instanceof HTMLInputElement && c.type === 'email' ? 'email' : c instanceof HTMLInputElement && c.type === 'tel' ? 'tel' : 'text';
    // LinkedIn treats every text question as required in practice (Next refuses empties).
    out.push({ id: c.id, label, kind, required: true, intent: undefined });
  }
  return out;
}

function isTypeahead(el: Element): boolean {
  return el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list' || !!el.closest('[data-test-single-typeahead-entity-form-component]');
}

function blockFor(m: Element, field: Field): HTMLElement | null {
  for (const block of questionBlocks(m)) {
    const r = radios(block);
    if (r.length && (r[0]!.name === field.id || r[0]!.id === field.id)) return block;
    const cb = checkboxes(block);
    if (cb.length && (cb[0]!.name === field.id || cb[0]!.id === field.id)) return block;
    const c = controlOf(block);
    if (c && (c.id === field.id || (field.kind === 'file' && c instanceof HTMLInputElement && c.type === 'file'))) return block;
  }
  return null;
}

/** The questions whose block currently shows a validation message — what to re-answer. */
export function fieldsInError(m: Element): Field[] {
  const bad = questionBlocks(m).filter((b) => validationErrors(b).length > 0);
  return extract(m).filter((f) => {
    const b = blockFor(m, f);
    return !!b && bad.includes(b);
  });
}

/** The choices a select / radio / checkbox question offers (placeholder dropped). */
export function optionsFor(m: Element, field: Field): string[] {
  const block = blockFor(m, field);
  if (!block) return [];
  const r = radios(block);
  if (r.length) return r.map((i) => optionLabel(i, block)).filter(Boolean);
  const cb = checkboxes(block);
  if (cb.length > 1) return cb.map((i) => optionLabel(i, block)).filter(Boolean);
  const sel = block.querySelector('select');
  if (sel) return [...sel.options].map((o) => o.text.trim()).filter((t) => t && !PLACEHOLDER.test(t));
  return []; // typeahead: options exist only after typing
}

/** True when the input is a whole-number box (LinkedIn: id ends in `-numeric`, or type=number). */
export function isNumeric(m: Element, field: Field): boolean {
  const c = blockFor(m, field) ? controlOf(blockFor(m, field)!) : null;
  if (!c) return false;
  return /-numeric$/.test(c.id) || c.getAttribute('type') === 'number' || c.getAttribute('inputmode') === 'numeric';
}

/** What the control currently holds (LinkedIn pre-fills from the last application). */
export function currentAnswer(m: Element, field: Field): string {
  const block = blockFor(m, field);
  if (!block) return '';
  const r = radios(block);
  if (r.length) return r.filter((i) => i.checked).map((i) => optionLabel(i, block)).join(', ');
  const cb = checkboxes(block);
  if (cb.length > 1) return cb.filter((i) => i.checked).map((i) => optionLabel(i, block)).join(', ');
  if (cb.length === 1) return cb[0]!.checked ? 'checked' : '';
  const c = controlOf(block);
  if (!c) return '';
  if (c instanceof HTMLSelectElement) {
    const t = c.options[c.selectedIndex]?.text.trim() ?? '';
    return PLACEHOLDER.test(t) ? '' : t;
  }
  if (c instanceof HTMLInputElement && c.type === 'file') return resumeSelected(m) ? 'selected' : '';
  return (c as HTMLInputElement | HTMLTextAreaElement).value.trim();
}

export function isAnswered(m: Element, field: Field): boolean {
  return currentAnswer(m, field) !== '';
}

/** A résumé card is already selected on the upload step (don't re-upload — duplicates pile up). */
export function resumeSelected(m: Element): boolean {
  return !!m.querySelector('.jobs-document-upload-redesign-card__container--selected, [data-test-document-upload-item][aria-selected="true"], [class*="document-upload"][aria-selected="true"], input[type="radio"][name*="resume" i]:checked, [class*="resume-card"][class*="selected"]');
}

export function resumeInput(m: Element): HTMLInputElement | null {
  return m.querySelector<HTMLInputElement>('input[type="file"]');
}

/** Attach the résumé when no card is selected; LinkedIn uploads it itself. */
export function attachResume(m: Element, file: File): boolean {
  if (resumeSelected(m)) return false;
  const first = m.querySelector<HTMLElement>('.jobs-document-upload-redesign-card__container:not(.jobs-document-upload-redesign-card__container--selected) input[type="radio"], .jobs-document-upload-redesign-card__container:not(.jobs-document-upload-redesign-card__container--selected) label');
  if (first) {
    click(first);
    return true;
  }
  const input = resumeInput(m);
  if (!input) return false;
  setFile(input, file);
  return true;
}

/** Put an answer in a question. Throws when the control can't take it (caller logs + parks). */
export function fill(m: Element, field: Field, answer: Answer): void {
  const block = blockFor(m, field);
  if (!block) throw new Error(`question "${field.label}" not on this step`);
  const r = radios(block);
  if (r.length) {
    if (answer.kind !== 'choice') throw new Error('radio needs a choice');
    const want = answer.values[0]?.toLowerCase().trim() ?? '';
    const hit = r.find((i) => optionLabel(i, block).toLowerCase().trim() === want) ?? r.find((i) => optionLabel(i, block).toLowerCase().includes(want));
    if (!hit) throw new Error(`no radio option "${answer.values[0]}"`);
    click(hit.id ? block.querySelector(`label[for="${hit.id}"]`) ?? hit : hit);
    if (!hit.checked) hit.click();
    return;
  }
  const cb = checkboxes(block);
  if (cb.length > 1) {
    if (answer.kind !== 'choice') throw new Error('checkbox group needs choices');
    const wanted = answer.values.map((v) => v.toLowerCase().trim());
    for (const box of cb) {
      const on = wanted.some((w) => optionLabel(box, block).toLowerCase().trim() === w);
      if (on !== box.checked) click(box.id ? block.querySelector(`label[for="${box.id}"]`) ?? box : box);
    }
    return;
  }
  if (cb.length === 1) {
    const box = cb[0]!;
    const on = answer.kind === 'check' ? answer.value : true;
    if (on !== box.checked) click(box.id ? block.querySelector(`label[for="${box.id}"]`) ?? box : box);
    return;
  }
  const c = controlOf(block);
  if (!c) throw new Error('no control');
  if (c instanceof HTMLSelectElement) {
    if (answer.kind !== 'choice') throw new Error('select needs a choice');
    const want = answer.values[0]?.toLowerCase().trim() ?? '';
    const opt = [...c.options].find((o) => o.text.trim().toLowerCase() === want) ?? [...c.options].find((o) => o.text.trim().toLowerCase().includes(want) && !PLACEHOLDER.test(o.text));
    if (!opt) throw new Error(`no option "${answer.values[0]}"`);
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(c, opt.value);
    c.dispatchEvent(new Event('input', { bubbles: true }));
    c.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if (c instanceof HTMLInputElement || c instanceof HTMLTextAreaElement) {
    const value = answer.kind === 'text' ? answer.value : answer.kind === 'choice' ? (answer.values[0] ?? '') : '';
    setReactValue(c, value);
    return;
  }
  throw new Error(`unsupported control <${c.tagName.toLowerCase()}>`);
}

export function isTypeaheadField(m: Element, field: Field): boolean {
  const block = blockFor(m, field);
  const c = block ? controlOf(block) : null;
  return !!c && isTypeahead(c);
}

/** City-style typeahead: type, wait for the listbox, pick the best match (else the first). */
export async function fillTypeahead(m: Element, field: Field, value: string, waitMs = 6000): Promise<string> {
  const block = blockFor(m, field);
  const input = block ? (controlOf(block) as HTMLInputElement | null) : null;
  if (!input) throw new Error('typeahead input missing');
  input.focus();
  setReactValue(input, value);
  const listSel = [input.getAttribute('aria-controls') ? `#${CSS.escape(input.getAttribute('aria-controls')!)}` : '', '.basic-typeahead__triggered-content', '.basic-typeahead_triggered-content', '.fb-single-typeahead-entitytriggered-content', '[role="listbox"]'].filter(Boolean).join(', ');
  const root = (m.getRootNode() as ParentNode) ?? document;
  const end = Date.now() + waitMs;
  let options: HTMLElement[] = [];
  while (Date.now() < end) {
    const lists = [...root.querySelectorAll<HTMLElement>(listSel), ...m.querySelectorAll<HTMLElement>(listSel)];
    options = lists.flatMap((l) => [...l.querySelectorAll<HTMLElement>('[role="option"], .basic-typeahead__selectable, [data-test-single-typeahead-entity-form-search-result]')]).filter((o) => shown(o));
    if (options.length) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!options.length) {
    // No suggestions rendered: accept whatever LinkedIn does with ArrowDown + Enter.
    for (const key of ['ArrowDown', 'Enter']) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
    }
    return input.value;
  }
  const want = value.toLowerCase().trim();
  const pick = options.find((o) => text(o).toLowerCase() === want) ?? options.find((o) => text(o).toLowerCase().startsWith(want)) ?? options.find((o) => text(o).toLowerCase().includes(want)) ?? options[0]!;
  click(pick);
  return text(pick);
}

// ---------- after Submit / on failure ----------

/** The post-submit "Your application was sent to <company>" dialog is showing. */
export function applicationSent(doc: Document): boolean {
  // A dialog that still carries a step button / questions is the application itself (its review
  // text may say "applied to"); the sent view — separate dialog or swapped-in modal body — has neither.
  return qa<HTMLElement>(doc, '[role="dialog"], .artdeco-modal, dialog[open], .artdeco-toast-item').some(
    (d) => shown(d) && /application (was )?sent|application submitted|your application was sent/i.test(text(d)) && !actionButton(d) && questionBlocks(d).length === 0,
  );
}

/** Close whatever dialog is up (post-submit "Done"/×, or the in-progress modal's ×). */
export function dismissButton(doc: Document): HTMLElement | null {
  const dialogs = qa<HTMLElement>(doc, '[role="dialog"], .artdeco-modal, dialog[open]').filter((d) => shown(d));
  for (const d of dialogs.reverse()) {
    const x = [...d.querySelectorAll<HTMLElement>('button')].find((b) => shown(b) && (b.matches('.artdeco-modal__dismiss, [aria-label="Dismiss"], [aria-label="Close"], [data-test-modal-close-btn]') || /^(done|close|dismiss|got it|ok)$/i.test(text(b))));
    if (x) return x;
  }
  return null;
}

/** "Discard" confirm after closing an unfinished application. */
export function discardButton(doc: Document): HTMLElement | null {
  return (
    firstShown(doc, 'button[data-control-name="discard_application_confirm_btn"], [data-test-modal-id*="discard"] button[data-test-dialog-primary-btn]') ??
    qa<HTMLElement>(doc, '[role="dialog"] button, [role="alertdialog"] button, .artdeco-modal button, dialog[open] button').find((b) => shown(b) && /^discard$/i.test(text(b))) ??
    null
  );
}

const LIMIT = /reached today.{0,3}s easy apply limit|easy apply limit|exceeded the daily application limit|continue applying tomorrow|great effort applying today|limit daily submissions|linkedin apply limit/i;
const PACE = /applying at a fast pace|paused easy apply|safeguard against automated|automation tools may put your account|briefly paused|you can continue shortly/i;

/** LinkedIn's daily Easy Apply cap dialog — the run must end for today. */
export function limitReached(doc: Document): boolean {
  return qa<HTMLElement>(doc, 'dialog, [role="dialog"], [role="alert"], [role="alertdialog"], .artdeco-modal__content, .artdeco-toast-item, .artdeco-inline-feedback, [data-sdui-screen*="FuseLimit"]').some((d) => shown(d) && LIMIT.test(text(d)));
}

/** LinkedIn's "you're applying too fast" pause — back off, then continue. */
export function rateLimited(doc: Document): boolean {
  return qa<HTMLElement>(doc, 'dialog, [role="dialog"], [role="alert"], [role="alertdialog"], .artdeco-modal__content, .artdeco-toast-item, .artdeco-inline-feedback').some((d) => shown(d) && PACE.test(text(d)));
}

// ---------- observability ----------

export function describeState(doc: Document): string {
  const m = modal(doc);
  const parts = [
    `url=${doc.location?.href ?? ''}`.slice(0, 160),
    `cards=${jobCards(doc).length}`,
    `easyApply=${!!easyApplyButton(doc)}`,
    `modal=${!!m}`,
    m ? `progress=${progress(m)}` : '',
    m ? `action=${actionButton(m)?.kind ?? 'none'}` : '',
    m ? `errors=${JSON.stringify(validationErrors(m))}` : '',
    `sent=${applicationSent(doc)}`,
    `limit=${limitReached(doc)}`,
    `closed=${jobClosedMessage(doc) || 'no'}`,
  ];
  return parts.filter(Boolean).join(' ');
}

export function describeQuestions(m: Element): string {
  return extract(m)
    .map((f) => `${f.kind}${isNumeric(m, f) ? '#' : ''} "${f.label.slice(0, 70)}" ${f.required ? '*' : ''}[${optionsFor(m, f).slice(0, 6).join(' | ').slice(0, 120)}] =${currentAnswer(m, f).slice(0, 40)}`)
    .join(' ; ');
}

export { click };

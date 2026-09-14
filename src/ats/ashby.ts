import type { Answer, Field, FieldKind, Intent } from '../engine/types';
import { click, labelText, setFile, setReactValue } from './dom';
import type { AshbyFormField } from '../sources/ashby';

// Ashby hosted application form (jobs.ashbyhq.com/<org>/<id>/application).
// Ground truth from Ashby's own front-end bundle (2026-09-14): every control is wrapped in a
// component that publishes a STABLE class name (their "usageNotes" design system, meant for
// customers' custom CSS), and every field sits in `[data-field-path=<path>]` — the same `path`
// the form-schema GraphQL call returns (sources/ashby.ts#fetchAshbyForm, the offline oracle).
//   text       .ashby-application-form-input-text input           (React-controlled)
//   textarea   .ashby-application-form-input-textarea textarea
//   yes/no     .ashby-application-form-input-yesno [data-option=yes|no]   (buttons, aria-pressed)
//   dropdown   .ashby-application-form-input-dropdown-select select       (NATIVE select)
//   radios     .ashby-application-form-input-radio-group-option  input[type=radio] + label
//   checkboxes .ashby-application-form-input-checkbox-group-option input[type=checkbox] + label
//   file       .ashby-application-form-input-file input[type=file]  (dropzone; hidden input)
//   location   .ashby-application-form-input-autocomplete input → …-autocomplete-popup-result
//   submit     .ashby-application-form-submit-button button ("Submit Application")
//   after      .ashby-application-form-success-container | …-failure-container |
//              …-blocked-application-container (application limits)
// Not yet a live page capture — the first real run reads the Logs page and fixes what differs.

const C = {
  container: '.ashby-application-form-container',
  entry: '[data-field-path]',
  title: '.ashby-application-form-question-title',
  text: '.ashby-application-form-input-text input',
  textarea: '.ashby-application-form-input-textarea textarea',
  yesno: '.ashby-application-form-input-yesno',
  yesnoOption: '[data-option]',
  select: '.ashby-application-form-input-dropdown-select select',
  radio: '.ashby-application-form-input-radio-group-option',
  checkbox: '.ashby-application-form-input-checkbox-group-option',
  file: '.ashby-application-form-input-file input[type="file"]',
  autocomplete: '.ashby-application-form-input-autocomplete input',
  autocompleteResult: '.ashby-application-form-input-autocomplete-popup-result',
  submit: '.ashby-application-form-submit-button button, .ashby-application-form-submit-button',
  success: '.ashby-application-form-success-container',
  failure: '.ashby-application-form-failure-container',
  blocked: '.ashby-application-form-blocked-application-container',
} as const;

const SYSTEM_INTENTS: Record<string, Intent> = {
  _systemfield_name: 'identity.full_name',
  _systemfield_email: 'identity.email',
  _systemfield_resume: 'resume',
  _systemfield_location: 'identity.city',
};

export function entryFor(doc: Document, path: string): Element | null {
  return doc.querySelector(`[data-field-path="${path}"]`);
}

function kindOf(entry: Element, schema?: AshbyFormField): FieldKind {
  if (entry.querySelector(C.file)) return 'file';
  if (entry.querySelector(C.yesno)) return 'select';
  if (entry.querySelector(C.select)) return 'select';
  if (entry.querySelector(C.radio)) return 'select';
  if (entry.querySelector(C.checkbox)) return 'multiselect';
  if (schema?.type === 'MultiValueSelect') return 'multiselect';
  if (schema?.type === 'Boolean' || schema?.type === 'ValueSelect') return 'select';
  if (schema?.type === 'Email') return 'email';
  if (schema?.type === 'Phone') return 'tel';
  return 'text';
}

function titleOf(entry: Element): string {
  const t = entry.querySelector(C.title) ?? entry.querySelector('label');
  return labelText(t ?? entry).replace(/\*+$/, '').replace(/\s*\*\s*$/, '').trim();
}

/** Read every rendered field. The schema (when given) supplies required/type; the DOM the rest.
 *  Field.id = the data-field-path. Pure DOM read. */
export function extract(doc: Document, schema: readonly AshbyFormField[] = []): Field[] {
  const byPath = new Map(schema.map((f) => [f.path, f]));
  const fields: Field[] = [];
  for (const entry of Array.from(doc.querySelectorAll(C.entry))) {
    const path = entry.getAttribute('data-field-path')!;
    const s = byPath.get(path);
    const label = titleOf(entry) || s?.title || path;
    const required = s ? s.required : /\*\s*$/.test(labelText(entry.querySelector(C.title) ?? entry));
    const kind = kindOf(entry, s);
    const intent = SYSTEM_INTENTS[path] ?? (s?.type === 'Phone' ? 'identity.phone' : undefined);
    fields.push({ id: path, label, kind, required, ...(intent ? { intent } : {}) });
  }
  return fields;
}

function groupOptions(entry: Element, sel: string): { input: HTMLInputElement; label: string }[] {
  return Array.from(entry.querySelectorAll(sel)).flatMap((opt) => {
    const input = opt.querySelector<HTMLInputElement>('input');
    if (!input) return [];
    const label = opt.querySelector('label');
    return [{ input, label: labelText(label ?? opt) || input.value }];
  });
}

/** The choices a field offers, read from the DOM (schema options are the fallback). */
export function optionsFor(doc: Document, field: Field, schema?: AshbyFormField): string[] {
  const entry = entryFor(doc, field.id);
  if (!entry) return schema?.options.slice() ?? [];
  if (entry.querySelector(C.yesno)) return ['Yes', 'No'];
  const select = entry.querySelector<HTMLSelectElement>(C.select);
  if (select) return Array.from(select.options).filter((o) => o.value !== '' && !o.hidden).map((o) => labelText(o));
  const radios = groupOptions(entry, C.radio);
  if (radios.length) return radios.map((r) => r.label);
  const boxes = groupOptions(entry, C.checkbox);
  if (boxes.length) return boxes.map((b) => b.label);
  return schema?.options.slice() ?? [];
}

const pickOne = <T extends { label: string }>(items: T[], value: string): T | undefined => {
  const lc = value.toLowerCase().trim();
  return items.find((i) => i.label.toLowerCase().trim() === lc) ?? items.find((i) => i.label.toLowerCase().includes(lc));
};

function setSelect(select: HTMLSelectElement, value: string, fieldId: string): void {
  const opts = Array.from(select.options).map((o) => ({ label: labelText(o), o }));
  const hit = pickOne(opts, value);
  if (!hit) throw new Error(`option "${value}" not found for ${fieldId}`);
  // React-controlled <select>: go through the native setter so React's value tracker sees it.
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, hit.o.value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Type into the Location autocomplete and take the first suggestion. Effectful. */
async function fillAutocomplete(doc: Document, input: HTMLInputElement, value: string): Promise<void> {
  setReactValue(input, value);
  input.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
  for (let i = 0; i < 25; i++) {
    const result = doc.querySelector<HTMLElement>(`${C.autocompleteResult} [role="option"], ${C.autocompleteResult}`);
    if (result) {
      click(result);
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  // No suggestion came back — leave the typed text (Ashby validates on submit; we'll see it).
}

/** Put a resolved answer into a field. Effectful (fires DOM events). */
export async function fill(doc: Document, field: Field, answer: Answer, resume?: File): Promise<void> {
  const entry = entryFor(doc, field.id);
  if (!entry) throw new Error(`field not found: ${field.id}`);
  if (answer.kind === 'unknown') return;

  if (answer.kind === 'file') {
    const input = entry.querySelector<HTMLInputElement>(C.file) ?? entry.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error(`no file input in ${field.id}`);
    if (resume) setFile(input, resume);
    return;
  }

  const yesno = entry.querySelector(C.yesno);
  if (yesno) {
    const want = answer.kind === 'check' ? answer.value : /^(yes|true)$/i.test((answer.kind === 'choice' ? answer.values[0] : answer.value) ?? '');
    const btn = yesno.querySelector<HTMLElement>(`${C.yesnoOption}="${want ? 'yes' : 'no'}"]`.replace('[data-option]="', '[data-option="'));
    if (!btn) throw new Error(`yes/no option missing in ${field.id}`);
    if (btn.getAttribute('aria-pressed') !== 'true') click(btn);
    return;
  }

  if (answer.kind === 'check') {
    const box = entry.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!box) throw new Error(`no checkbox in ${field.id}`);
    if (box.checked !== answer.value) click(box);
    return;
  }

  const wanted = answer.kind === 'choice' ? answer.values : [answer.value];
  const select = entry.querySelector<HTMLSelectElement>(C.select);
  if (select) return setSelect(select, wanted[0] ?? '', field.id);

  const radios = groupOptions(entry, C.radio);
  if (radios.length) {
    const hit = pickOne(radios, wanted[0] ?? '');
    if (!hit) throw new Error(`option "${wanted[0]}" not found for ${field.id}`);
    if (!hit.input.checked) click(hit.input);
    return;
  }
  const boxes = groupOptions(entry, C.checkbox);
  if (boxes.length) {
    for (const v of wanted) {
      const hit = pickOne(boxes, v);
      if (!hit) throw new Error(`option "${v}" not found for ${field.id}`);
      if (!hit.input.checked) click(hit.input);
    }
    return;
  }

  const text = wanted.join(', ');
  const auto = entry.querySelector<HTMLInputElement>(C.autocomplete);
  if (auto) return fillAutocomplete(doc, auto, text);
  const area = entry.querySelector<HTMLTextAreaElement>(C.textarea) ?? entry.querySelector<HTMLTextAreaElement>('textarea');
  if (area) return setReactValue(area, text);
  const input = entry.querySelector<HTMLInputElement>(C.text) ?? entry.querySelector<HTMLInputElement>('input:not([type="file"]):not([type="radio"]):not([type="checkbox"])');
  if (!input) throw new Error(`no input found in ${field.id}`);
  setReactValue(input, text);
}

export function textFilled(doc: Document, field: Field, answer: Answer): boolean {
  if (answer.kind !== 'text' || !answer.value.trim()) return true;
  const entry = entryFor(doc, field.id);
  const input = entry?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input:not([type="file"]):not([type="radio"]):not([type="checkbox"]), textarea');
  return !input || input.value.trim().length > 0;
}

export function formLoaded(doc: Document): boolean {
  return !!doc.querySelector(C.container) && doc.querySelectorAll(C.entry).length > 0;
}

export function submitButton(doc: Document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(C.submit);
}

export function confirmed(doc: Document): boolean {
  return !!doc.querySelector(C.success);
}

export function failureMessage(doc: Document): string | null {
  const el = doc.querySelector(C.failure);
  return el ? labelText(el) : null;
}

/** Ashby's application-limits disclosure (already applied / too many applications). */
export function blockedMessage(doc: Document): string | null {
  const el = doc.querySelector(C.blocked);
  return el ? labelText(el) : null;
}

/** One line for logs/park notes: what the page looks like right now. */
export function describeState(doc: Document): string {
  return `container=${!!doc.querySelector(C.container)} fields=${doc.querySelectorAll(C.entry).length} submit=${!!submitButton(doc)} success=${confirmed(doc)} failure=${!!doc.querySelector(C.failure)} blocked=${!!doc.querySelector(C.blocked)}`;
}

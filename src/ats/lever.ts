import type { Answer, Field, FieldKind, Intent } from '../engine/types';
import { click, labelText, setFile, setReactValue } from './dom';

// Lever hosted application form (jobs.lever.co/<site>/<id>/apply).
// Verified against fixtures/lever-apply.html (a real page capture, 2026-09-14). Ground truth:
//   - Server-rendered plain HTML: `form#application-form`, one `.application-question` per field,
//     label in `.application-label` (a trailing ✱ marks required), controls named — not id'd:
//     name / email / phone / location (+ hidden selectedLocation) / org / urls[LinkedIn] /
//     resume (file) / cards[<uuid>][field<n>] (custom: radio group, checkbox group, select,
//     textarea, text) / eeo[gender|race|veteran] (selects) / consent[marketing] (checkbox).
//   - No React: set .value + input/change is enough. Radios/checkboxes are clicked.
//   - `#btn-submit` (type=button) runs hCaptcha first, then posts through the hidden
//     `#hcaptchaSubmitBtn`. Success = navigation to <hostedUrl>/thanks (content script dies →
//     ports.ts#outcomeAfterPortClosed + Site.submittedUrl). A visible hCaptcha challenge = park.
//   - Field.id carries the control's `name` (unique per question) — never a DOM id.

const FORM = '#application-form';

const KNOWN: Record<string, { intent: Intent; kind: FieldKind }> = {
  name: { intent: 'identity.full_name', kind: 'text' },
  email: { intent: 'identity.email', kind: 'email' },
  phone: { intent: 'identity.phone', kind: 'tel' },
  location: { intent: 'identity.city', kind: 'text' },
  org: { intent: 'answers.current_company', kind: 'text' },
  resume: { intent: 'resume', kind: 'file' },
};

function form(doc: Document): Element | null {
  return doc.querySelector(FORM);
}

function questionBlocks(doc: Document): Element[] {
  return Array.from(form(doc)?.querySelectorAll('.application-question') ?? []);
}

function questionLabel(block: Element): string {
  const el = block.querySelector('.application-label') ?? block.querySelector('label');
  return labelText(el ?? block).replace(/[✱*]/g, '').trim();
}

/** The user-facing controls of one question block (hidden inputs and helper buttons excluded). */
function controls(block: Element): (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[] {
  return Array.from(block.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')).filter(
    (c) => !(c instanceof HTMLInputElement && c.type === 'hidden') && !!c.getAttribute('name'),
  );
}

export function controlsNamed(doc: Document, name: string): (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[] {
  const f = form(doc);
  if (!f) return [];
  return Array.from(f.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')).filter((c) => c.getAttribute('name') === name);
}

/** Read every field out of the form. Pure DOM read — safe to run in tests. */
export function extract(doc: Document): Field[] {
  const fields: Field[] = [];
  const seen = new Set<string>();
  for (const block of questionBlocks(doc)) {
    const ctrls = controls(block);
    const first = ctrls[0];
    if (!first) continue; // e.g. the "Apply with LinkedIn" button row
    const name = first.getAttribute('name')!;
    if (seen.has(name)) continue;
    seen.add(name);
    const label = questionLabel(block);
    const required = /[✱*]/.test(labelText(block.querySelector('.application-label') ?? block)) || ctrls.some((c) => c.hasAttribute('required'));
    const known = KNOWN[name];
    let kind: FieldKind = known?.kind ?? 'text';
    if (!known) {
      if (first instanceof HTMLInputElement && first.type === 'file') kind = 'file';
      else if (first instanceof HTMLInputElement && first.type === 'radio') kind = 'select';
      else if (first instanceof HTMLInputElement && first.type === 'checkbox') kind = ctrls.length > 1 ? 'multiselect' : 'checkbox';
      else if (first instanceof HTMLSelectElement) kind = first.multiple ? 'multiselect' : 'select';
      else if (first instanceof HTMLInputElement && first.type === 'email') kind = 'email';
      else if (first instanceof HTMLInputElement && first.type === 'tel') kind = 'tel';
    }
    fields.push({ id: name, label, kind, required, ...(known ? { intent: known.intent } : {}) });
  }
  return fields;
}

function optionLabel(input: HTMLInputElement): string {
  const wrapped = input.closest('label');
  if (wrapped) return labelText(wrapped);
  const id = input.id;
  const forLabel = id ? input.ownerDocument.querySelector(`label[for="${id}"]`) : null;
  return forLabel ? labelText(forLabel) : input.value;
}

/** The choices a select / radio group / checkbox group offers (placeholder rows excluded). */
export function optionsFor(doc: Document, field: Field): string[] {
  const ctrls = controlsNamed(doc, field.id);
  const first = ctrls[0];
  if (!first) return [];
  if (first instanceof HTMLSelectElement) {
    return Array.from(first.options)
      .map((o) => labelText(o))
      .filter((t) => t && !/^(select|choose|please select|--)/i.test(t));
  }
  if (first instanceof HTMLInputElement && (first.type === 'radio' || first.type === 'checkbox')) {
    return ctrls.filter((c): c is HTMLInputElement => c instanceof HTMLInputElement).map(optionLabel);
  }
  return [];
}

function pick(ctrls: HTMLInputElement[], wanted: readonly string[], fieldId: string): void {
  for (const value of wanted) {
    const lc = value.toLowerCase().trim();
    const hit = ctrls.find((c) => optionLabel(c).toLowerCase().trim() === lc) ?? ctrls.find((c) => optionLabel(c).toLowerCase().includes(lc));
    if (!hit) throw new Error(`option "${value}" not found for ${fieldId}`);
    if (!hit.checked) click(hit);
    if (!hit.checked) hit.checked = true; // plain HTML: no framework value tracker to trip
  }
}

/** Lever's "Current location" is a typeahead: typing triggers a lookup, and picking a result fills
 *  the hidden selectedLocation. Type, wait for results, take the first; the typed text stays if
 *  nothing comes back (Lever accepts free text). Effectful. */
async function fillLocation(doc: Document, input: HTMLInputElement, value: string): Promise<void> {
  setReactValue(input, value);
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
  for (let i = 0; i < 20; i++) {
    const result = doc.querySelector<HTMLElement>('.dropdown-results > *');
    if (result) {
      click(result);
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Put a resolved answer into a field. Effectful (fires DOM events). */
export async function fill(doc: Document, field: Field, answer: Answer, resume?: File): Promise<void> {
  const ctrls = controlsNamed(doc, field.id);
  const first = ctrls[0];
  if (!first) throw new Error(`field not found: ${field.id}`);

  if (answer.kind === 'file') {
    if (resume && first instanceof HTMLInputElement) setFile(first, resume);
    return;
  }
  if (answer.kind === 'check') {
    if (!(first instanceof HTMLInputElement)) throw new Error(`not a checkbox: ${field.id}`);
    if (first.checked !== answer.value) click(first);
    if (first.checked !== answer.value) first.checked = answer.value;
    return;
  }
  if (answer.kind === 'unknown') return;
  const wanted = answer.kind === 'choice' ? answer.values : [answer.value];
  if (first instanceof HTMLSelectElement) {
    const lc = (wanted[0] ?? '').toLowerCase().trim();
    const opt = Array.from(first.options).find((o) => labelText(o).toLowerCase() === lc) ?? Array.from(first.options).find((o) => labelText(o).toLowerCase().includes(lc));
    if (!opt) throw new Error(`option "${wanted[0]}" not found for ${field.id}`);
    first.value = opt.value;
    first.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if (first instanceof HTMLInputElement && (first.type === 'radio' || first.type === 'checkbox')) {
    pick(ctrls.filter((c): c is HTMLInputElement => c instanceof HTMLInputElement), wanted, field.id);
    return;
  }
  const text = wanted.join(', ');
  if (field.id === 'location' && first instanceof HTMLInputElement) return fillLocation(doc, first, text);
  setReactValue(first as HTMLInputElement | HTMLTextAreaElement, text);
}

/** Did a text answer land? (Nothing remounts here, but the content script's re-check is shared.) */
export function textFilled(doc: Document, field: Field, answer: Answer): boolean {
  if (answer.kind !== 'text' || !answer.value.trim()) return true;
  const el = controlsNamed(doc, field.id)[0];
  return !el || !('value' in el) || el.value.trim().length > 0;
}

export function submitButton(doc: Document): HTMLButtonElement | null {
  return doc.querySelector<HTMLButtonElement>('#btn-submit');
}

/** Lever posts inline validation under the form (`.application-form-error`, `.error-message`). */
export function validationError(doc: Document): string | null {
  const el = Array.from(doc.querySelectorAll<HTMLElement>('.application-form-error, .error-message, .error')).find((e) => labelText(e) && e.offsetParent !== null);
  return el ? labelText(el) : null;
}

/** An hCaptcha challenge that became visible = a human must solve it (we never touch it). */
export function captchaShown(doc: Document): boolean {
  return Array.from(doc.querySelectorAll<HTMLIFrameElement>('iframe[src*="hcaptcha.com"]')).some((f) => {
    const box = f.getBoundingClientRect();
    return /challenge/.test(f.src) && box.width > 100 && box.height > 100;
  });
}

export function confirmed(doc: Document): boolean {
  return /\/thanks\b/.test(doc.location?.pathname ?? '') || /application (has been )?submitted|thank you for applying|thanks for applying/i.test(doc.body?.textContent ?? '');
}

/** Lever lands on <hostedUrl>/thanks after a successful post. Declared on the Site so the closed
 *  message port after navigation is read as success (ports.ts#outcomeAfterPortClosed). */
export function submittedByNavigation(url: string): boolean {
  return /^https:\/\/jobs\.lever\.co\/[^/]+\/[^/]+\/thanks/i.test(url);
}

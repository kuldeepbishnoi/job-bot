import type { Answer, Field, FieldKind, Intent } from '../engine/types';
import { click, labelText, setFile, setReactValue } from './dom';

// Greenhouse embedded application form (job-boards.greenhouse.io iframe).
// Verified against fixtures/greenhouse-form.html.

export type SubmitResult = 'ok' | 'needs_otp' | 'error';

// Standard fields have stable ids; their intents are known up front.
const IDENTITY_IDS: Record<string, Intent> = {
  first_name: 'identity.first_name',
  last_name: 'identity.last_name',
  preferred_name: 'identity.preferred_name',
  email: 'identity.email',
  phone: 'identity.phone',
  country: 'identity.country',
};

function isFileInput(el: Element | null): el is HTMLInputElement {
  return !!el && el instanceof HTMLInputElement && el.type === 'file';
}

/**
 * Locate the react-select control for a labeled element.
 * react-select nests the labeled `<input class="select__input">` inside its OWN
 * `.select__control`, so `closest` returns exactly this field's control — never a sibling
 * question's. (A climbing querySelector would grab the first control in a shared ancestor.)
 */
function reactSelectControl(el: Element): Element | null {
  return el.closest('.select__control');
}

function kindOf(id: string, el: Element | null): FieldKind {
  if (isFileInput(el)) return 'file';
  if (el instanceof HTMLInputElement && el.type === 'checkbox') return 'checkbox';
  if (el instanceof HTMLInputElement && el.type === 'tel') return 'tel';
  if (el instanceof HTMLInputElement && el.type === 'email') return 'email';
  if (id.endsWith('[]')) return 'multiselect';
  if (el && reactSelectControl(el)) return 'select';
  return 'text';
}

/** Read every field out of the form. Pure DOM read — safe to run in tests. */
export function extract(doc: Document): Field[] {
  const fields: Field[] = [];
  for (const label of Array.from(doc.querySelectorAll('label[for]'))) {
    // Note: ids may contain "[]" for multi-selects (e.g. "question_67885030[]"). getElementById
    // matches that literally, so we always use the raw id — never strip the brackets.
    const id = label.getAttribute('for')!;
    // Alternate input modes for the resume/cover-letter file inputs — the form shows
    // paste-text and file-drop variants that share the same slot. We want the plain
    // `resume` / `cover_letter` file inputs only; the *_text variants are textareas
    // with different fill semantics we don't support yet.
    if (id === 'resume_text' || id === 'resume-dropbox' || id === 'cover_letter_text') continue;
    const el = doc.getElementById(id);
    const text = labelText(label);
    const required = text.includes('*') || el?.getAttribute('aria-required') === 'true';
    const kind = id === 'resume' ? 'file' : kindOf(id, el);
    const intent: Intent | undefined = id === 'resume' ? 'resume' : IDENTITY_IDS[id];
    fields.push({ id, label: text.replace(/\*/g, '').trim(), kind, required: !!required, intent });
  }
  return fields;
}

/**
 * Open a react-select's menu, tolerating that it may not be hydrated/interactive yet
 * (a fresh apply fires ~1s after load). Retries the open click a few times. If a menu is
 * already open (multi-select keeps it open between picks), returns that one.
 */
async function openMenu(doc: Document, control: Element): Promise<Element> {
  // react-select flips the combobox's aria-expanded to "true" while its menu is open.
  // Gate the open-click on that flag: a second click on a hydrated, already-open control
  // toggles the menu shut, and clicks fired before the widget hydrates are harmless no-ops.
  // So only click when it's not already expanded, and wait for a menu that has rendered
  // options (aria-expanded can flip before the options paint).
  const combobox = control.querySelector('[role="combobox"]');
  const openMenuEl = (): Element | null => {
    const menu = doc.querySelector('.select__menu');
    return menu?.querySelector('.select__option') ? menu : null;
  };
  for (let i = 0; i < 30; i++) {
    const menu = openMenuEl();
    if (menu) return menu;
    if (combobox?.getAttribute('aria-expanded') !== 'true') click(control);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('select menu did not open');
}

/** Read the labels a select currently offers (open it first if needed). */
export async function optionsFor(doc: Document, field: Field): Promise<string[]> {
  if (field.kind !== 'select' && field.kind !== 'multiselect') return [];
  const el = doc.getElementById(field.id);
  if (!el) return [];
  const control = reactSelectControl(el);
  if (!control) return [];
  try {
    const menu = await openMenu(doc, control);
    return Array.from(menu.querySelectorAll('.select__option')).map(labelText);
  } catch {
    return [];
  } finally {
    if (doc.querySelector('.select__menu')) click(control); // close if still open
  }
}

/**
 * Pick options in a react-select by clicking the menu entries that match `values`.
 * Prefers an exact (case-insensitive) label match, then falls back to a substring match,
 * so "India" doesn't accidentally select "British Indian Ocean Territory".
 */
async function pickOptions(
  doc: Document,
  control: Element,
  fieldId: string,
  values: readonly string[],
): Promise<void> {
  for (const value of values) {
    const menu = await openMenu(doc, control);
    const opts = Array.from(menu.querySelectorAll('.select__option'));
    const lc = value.toLowerCase();
    const opt =
      opts.find((o) => labelText(o).toLowerCase() === lc) ??
      opts.find((o) => labelText(o).toLowerCase().includes(lc));
    if (!opt) throw new Error(`option "${value}" not found for ${fieldId}`);
    click(opt);
  }
}

/** Put a resolved answer into a field. Effectful (fires DOM events). */
export async function fill(doc: Document, field: Field, answer: Answer, resume?: File): Promise<void> {
  const el = doc.getElementById(field.id) as HTMLInputElement | null;
  if (!el) throw new Error(`field not found: ${field.id}`);

  if (answer.kind === 'file') {
    if (resume) setFile(el, resume);
    return;
  }
  if (answer.kind === 'check') {
    if (el.checked === answer.value) return;
    click(el); // a click toggles the checkbox (spec activation behavior) + fires React's onChange
    if (el.checked !== answer.value) {
      // Fallback for a controlled checkbox that ignored the synthetic click: force the state via
      // the native setter and notify React with change only — NOT click, which would toggle it back.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set?.call(el, answer.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return;
  }
  if (answer.kind === 'text') {
    // A react-select (e.g. Country) is a combobox: typing filters but never commits a
    // selection, so a required field would submit empty. Route through option-picking.
    const control = reactSelectControl(el);
    if (control) {
      await pickOptions(doc, control, field.id, [answer.value]);
      return;
    }
    setReactValue(el, answer.value);
    return;
  }
  if (answer.kind === 'choice') {
    const control = reactSelectControl(el);
    if (!control) {
      setReactValue(el, answer.values[0] ?? '');
      return;
    }
    await pickOptions(doc, control, field.id, answer.values);
  }
}

/**
 * Did a text answer actually land and stick? Greenhouse remounts the form after the async
 * résumé upload, which wipes plain inputs we set earlier — so we re-check and re-fill.
 * Only plain inputs/textareas are verifiable this way; react-selects keep their value
 * elsewhere, and files/choices are checked by their own controls, so treat those as fine.
 */
export function textFilled(doc: Document, field: Field, answer: Answer): boolean {
  if (answer.kind !== 'text') return true;
  if (answer.value.trim().length === 0) return true; // nothing to assert (e.g. blank website)
  const el = doc.getElementById(field.id) as HTMLInputElement | null;
  if (!el || reactSelectControl(el)) return true;
  return el.value.trim().length > 0;
}

export function submitButton(doc: Document): HTMLButtonElement | null {
  return doc.querySelector('button[type="submit"]');
}

/** The email-verification step: 8 boxes + a "verification code" prompt. */
export function otpBoxes(doc: Document): HTMLInputElement[] {
  const wantsCode = /verification code|security code|8-character/i.test(doc.body?.textContent ?? '');
  if (!wantsCode) return [];
  const boxes = Array.from(doc.querySelectorAll<HTMLInputElement>('input')).filter(
    (i) => i.maxLength === 1 && i.type !== 'hidden',
  );
  return boxes.length === 8 ? boxes : [];
}

export function needsOtp(doc: Document): boolean {
  return otpBoxes(doc).length === 8;
}

export function fillOtp(doc: Document, code: string): void {
  const boxes = otpBoxes(doc);
  [...code].forEach((ch, i) => {
    const box = boxes[i];
    if (!box) return;
    box.focus();
    setReactValue(box, ch);
  });
}

export function confirmed(doc: Document): boolean {
  return /application (has been )?submitted|thanks for applying|confirmation/i.test(
    doc.body?.textContent ?? '',
  );
}

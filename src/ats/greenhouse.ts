import type { Answer, Field, FieldKind, Intent } from '../engine/types';
import { click, labelText, setFile, setReactValue, waitFor } from './dom';

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
    if (id === 'resume_text' || id === 'resume-dropbox') continue; // alt resume modes
    const el = doc.getElementById(id);
    const text = labelText(label);
    const required = text.includes('*') || el?.getAttribute('aria-required') === 'true';
    const kind = id === 'resume' ? 'file' : kindOf(id, el);
    const intent: Intent | undefined = id === 'resume' ? 'resume' : IDENTITY_IDS[id];
    fields.push({ id, label: text.replace(/\*/g, '').trim(), kind, required: !!required, intent });
  }
  return fields;
}

/** Read the labels a select currently offers (open it first if needed). */
export async function optionsFor(doc: Document, field: Field): Promise<string[]> {
  if (field.kind !== 'select' && field.kind !== 'multiselect') return [];
  const el = doc.getElementById(field.id);
  if (!el) return [];
  const control = reactSelectControl(el);
  if (!control) return [];
  click(control);
  try {
    const menu = await waitFor(() => doc.querySelector('.select__menu'), 2000);
    return Array.from(menu.querySelectorAll('.select__option')).map(labelText);
  } catch {
    return [];
  } finally {
    click(control); // close
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
  if (answer.kind === 'text') {
    setReactValue(el, answer.value);
    return;
  }
  if (answer.kind === 'choice') {
    const control = reactSelectControl(el);
    if (!control) {
      setReactValue(el, answer.values[0] ?? '');
      return;
    }
    for (const value of answer.values) {
      // Open only if closed: a single-select closes its menu after a pick, but a multi-select
      // keeps it open — so re-clicking the control there would TOGGLE it shut and time out.
      if (!doc.querySelector('.select__menu')) click(control);
      const menu = await waitFor(() => doc.querySelector('.select__menu'), 2000);
      const opt = Array.from(menu.querySelectorAll('.select__option')).find((o) =>
        labelText(o).toLowerCase().includes(value.toLowerCase()),
      );
      if (!opt) throw new Error(`option "${value}" not found for ${field.id}`);
      click(opt);
    }
  }
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

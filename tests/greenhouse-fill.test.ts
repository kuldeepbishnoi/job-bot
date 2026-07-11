import { describe, it, expect } from 'vitest';
import { fill, textFilled } from '@/ats/greenhouse';
import type { Answer, Field } from '@/engine/types';

// Build a minimal react-select-like widget that behaves like the real one:
//  - opens its menu on control mousedown (and won't reopen if already open)
//  - single-select closes the menu after a pick; multi-select keeps it open
function makeSelect(doc: Document, id: string, options: string[], multi: boolean): HTMLElement {
  const root = doc.createElement('div');
  const control = doc.createElement('div');
  control.className = 'select__control';
  const input = doc.createElement('input');
  input.id = id;
  input.className = 'select__input';
  control.appendChild(input);
  root.appendChild(control);

  control.addEventListener('mousedown', () => {
    if (root.querySelector('.select__menu')) return; // already open — matches react-select
    const menu = doc.createElement('div');
    menu.className = 'select__menu';
    for (const label of options) {
      const opt = doc.createElement('div');
      opt.className = 'select__option';
      opt.textContent = label;
      opt.addEventListener('click', () => {
        opt.setAttribute('data-picked', 'true');
        const prev = root.getAttribute('data-value');
        root.setAttribute('data-value', prev ? `${prev},${label}` : label); // persists after menu removal
        if (!multi) menu.remove();
      });
      menu.appendChild(opt);
    }
    root.appendChild(menu);
  });
  return root;
}

const field = (id: string, kind: Field['kind']): Field => ({ id, label: id, kind, required: true });

describe('greenhouse fill — react-select', () => {
  it('selects multiple options without toggling the open multi-menu shut (#6)', async () => {
    const doc = new DOMParser().parseFromString('<div id="root"></div>', 'text/html');
    const w = makeSelect(doc, 'cities[]', ['Paris', 'Bangalore', 'London'], true);
    doc.getElementById('root')!.appendChild(w);

    await fill(doc, field('cities[]', 'multiselect'), { kind: 'choice', values: ['Paris', 'Bangalore'] });

    const picked = [...w.querySelectorAll('.select__option[data-picked]')].map((o) => o.textContent);
    expect(picked.sort()).toEqual(['Bangalore', 'Paris']);
  });

  it('picks a react-select option for a TEXT answer (Country) instead of typing it', async () => {
    const doc = new DOMParser().parseFromString('<div id="root"></div>', 'text/html');
    // Country renders as a react-select; a text answer must open + click, not just type.
    const w = makeSelect(doc, 'country', ['British Indian Ocean Territory', 'India'], false);
    doc.getElementById('root')!.appendChild(w);

    await fill(doc, field('country', 'select'), { kind: 'text', value: 'India' });

    // Exact match wins over the substring-containing "British Indian Ocean Territory".
    expect(w.getAttribute('data-value')).toBe('India');
  });

  it('textFilled detects a reverted (blanked) text input so it gets re-filled', () => {
    const doc = new DOMParser().parseFromString(
      '<input id="first_name" type="text" value="">',
      'text/html',
    );
    const f = field('first_name', 'text');
    const ans: Answer = { kind: 'text', value: 'Kuldeep' };
    // Empty input after a remount -> needs re-fill.
    expect(textFilled(doc, f, ans)).toBe(false);
    (doc.getElementById('first_name') as HTMLInputElement).value = 'Kuldeep';
    expect(textFilled(doc, f, ans)).toBe(true);
    // Non-text answers are never re-checked this way.
    expect(textFilled(doc, field('resume', 'file'), { kind: 'file' })).toBe(true);
  });

  it('checks a required consent checkbox (a submit gate)', async () => {
    const doc = new DOMParser().parseFromString(
      '<input id="gdpr_consent" type="checkbox">',
      'text/html',
    );
    const box = doc.getElementById('gdpr_consent') as HTMLInputElement;
    expect(box.checked).toBe(false);
    await fill(doc, field('gdpr_consent', 'checkbox'), { kind: 'check', value: true });
    expect(box.checked).toBe(true);
    // Idempotent: filling again leaves it checked (doesn't toggle back off).
    await fill(doc, field('gdpr_consent', 'checkbox'), { kind: 'check', value: true });
    expect(box.checked).toBe(true);
  });

  it('fills the field’s OWN control, not a sibling’s (#7)', async () => {
    const doc = new DOMParser().parseFromString('<div id="root"></div>', 'text/html');
    const root = doc.getElementById('root')!;
    // Two widgets under one shared ancestor — a climbing querySelector would hit A first.
    root.appendChild(makeSelect(doc, 'qA', ['Yes', 'No'], false));
    const wB = makeSelect(doc, 'qB', ['Green', 'Blue'], false);
    root.appendChild(wB);

    await fill(doc, field('qB', 'select'), { kind: 'choice', values: ['Blue'] });

    expect(wB.getAttribute('data-value')).toBe('Blue');
    // Widget A must be untouched (a climbing querySelector would have opened A's control).
    const wA = root.querySelector('#qA')!.closest('.select__control')!.parentElement!;
    expect(wA.getAttribute('data-value')).toBeNull();
  });
});

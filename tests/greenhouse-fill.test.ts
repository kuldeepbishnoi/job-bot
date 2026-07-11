import { describe, it, expect } from 'vitest';
import { fill } from '@/ats/greenhouse';
import type { Field } from '@/engine/types';

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

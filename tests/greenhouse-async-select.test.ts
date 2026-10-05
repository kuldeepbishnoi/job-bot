import { describe, it, expect } from 'vitest';
import { fill } from '@/ats/greenhouse';

// "Location (City)" on Greenhouse is an ASYNC react-select: it opens empty and offers place
// suggestions only for what is typed. The adapter tried to open it like a static list and failed
// every time ("select menu did not open" — Airbnb 8154749, 8045874 on 2026-10-04), leaving a
// required box blank. Modelled here: options render only after an input event.
function asyncLocation(suggest: (q: string) => string[]): { doc: Document; picked: () => string | null } {
  const doc = new DOMParser().parseFromString(`<div id="root"><div class="select__control"><input id="candidate-location" role="combobox" aria-expanded="false"></div></div>`, 'text/html');
  let picked: string | null = null;
  const input = doc.getElementById('candidate-location') as HTMLInputElement;
  input.addEventListener('input', () => {
    doc.querySelector('.select__menu')?.remove();
    const menu = doc.createElement('div');
    menu.className = 'select__menu';
    for (const s of suggest(input.value)) {
      const o = doc.createElement('div');
      o.className = 'select__option';
      o.textContent = s;
      o.addEventListener('click', () => (picked = s));
      menu.appendChild(o);
    }
    doc.getElementById('root')!.appendChild(menu);
  });
  return { doc, picked: () => picked };
}

describe('greenhouse async select (Location (City))', () => {
  it('types the city and picks the suggestion that names it', async () => {
    const { doc, picked } = asyncLocation((q) => (/gurugram/i.test(q) ? ['Gurugram, Haryana, India', 'Gurugram Sector 29, Haryana, India'] : []));
    await fill(doc, { id: 'candidate-location', label: 'Location (City)', kind: 'select', required: true }, { kind: 'text', value: 'Gurugram' });
    expect(picked()).toBe('Gurugram, Haryana, India');
  }, 20_000);

  it('falls back to the city\'s other name when the places API only knows that one', async () => {
    const { doc, picked } = asyncLocation((q) => (/gurgaon/i.test(q) ? ['Gurgaon, Haryana, India'] : []));
    await fill(doc, { id: 'candidate-location', label: 'Location (City)', kind: 'select', required: true }, { kind: 'text', value: 'Gurugram' });
    expect(picked()).toBe('Gurgaon, Haryana, India');
  }, 40_000);
});

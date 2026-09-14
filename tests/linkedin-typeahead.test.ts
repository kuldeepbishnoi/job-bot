import { describe, it, expect } from 'vitest';
import { fillTypeahead } from '@/ats/linkedin';
import type { Field } from '@/engine/types';

// A Jobgether application reached LinkedIn's Review step reading "What is your current location?
// No answer provided" even though the box had been filled: LinkedIn discards typeahead text that
// was never chosen from its own suggestion list. These pin the contract that prevents that —
// "committed" means a suggestion was clicked, and typed text alone never counts.

const field: Field = { id: 'city', label: 'What is your current location?', kind: 'select', required: true };

function modal(optionTexts: string[], opts: { appearAfterMs?: number; onlyForPrefix?: string } = {}): HTMLElement {
  document.body.innerHTML = `
    <div id="m">
      <div class="fb-dash-form-element">
        <label for="city">What is your current location?</label>
        <input id="city" role="combobox" aria-controls="city-list" />
        <div id="city-list" role="listbox"></div>
      </div>
    </div>`;
  const m = document.getElementById('m')!;
  const input = m.querySelector('input')!;
  const list = m.querySelector('#city-list')!;
  const render = (): void => {
    const q = input.value.toLowerCase();
    const show = opts.onlyForPrefix ? q === opts.onlyForPrefix.toLowerCase() : true;
    list.innerHTML = show ? optionTexts.map((t) => `<div role="option">${t}</div>`).join('') : '';
  };
  input.addEventListener('input', () => setTimeout(render, opts.appearAfterMs ?? 0));
  return m;
}

describe('LinkedIn typeahead only counts a chosen suggestion', () => {
  it('commits when a suggestion matches and reports what was chosen', async () => {
    const m = modal(['Gurugram, Haryana, India', 'Gurgaon Rural, India']);
    const r = await fillTypeahead(m, field, 'Gurugram', 1500);
    expect(r.committed).toBe(true);
    expect(r.value).toBe('Gurugram, Haryana, India');
  });

  it('does NOT claim an answer when the list never offers anything', async () => {
    const m = modal([]);
    const r = await fillTypeahead(m, field, 'Gurugram', 400);
    expect(r.committed).toBe(false);
    expect(r.note).toMatch(/never chosen from the list/);
  });

  it('retries with the first word when the full string matches nothing', async () => {
    // LinkedIn matches a prefix, not "Gurugram, Haryana, India" typed whole.
    const m = modal(['Gurugram, Haryana, India'], { onlyForPrefix: 'Gurugram' });
    const r = await fillTypeahead(m, field, 'Gurugram, Haryana, India', 400);
    expect(r.committed).toBe(true);
    expect(r.value).toBe('Gurugram, Haryana, India');
  });

  it('never picks an unrelated suggestion just to fill the box', async () => {
    const m = modal(['Mumbai, Maharashtra, India', 'Pune, Maharashtra, India']);
    await expect(fillTypeahead(m, field, 'Gurugram', 1500)).rejects.toThrow(/offered nothing matching/);
  });
});

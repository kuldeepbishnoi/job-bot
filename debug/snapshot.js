// Paste into the DevTools console of ANY application page (listing, apply form, review step) and
// press Enter: copies a structural dump of the page to the clipboard as JSON. That dump is the
// ground truth a site pack is built from — never guess markup from a bundle again.
//
// What it records: every heading, every form/card, every question-ish block (label + the controls
// inside it + whether it's visible), every button/link that looks like next/continue/submit, and
// the URL. Paste the result into fixtures/<site>-snapshot-<step>.json.
(() => {
  const shown = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0) && !el.closest('[hidden]');
  const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const ctl = (root) => [...root.querySelectorAll('select, input, textarea, [role=combobox], [role=radio], [role=checkbox]')].map((c) => ({
    tag: c.tagName.toLowerCase(), type: c.getAttribute('type') || c.getAttribute('role') || '', name: c.name || '', id: c.id || '',
    value: c.tagName === 'SELECT' ? [...c.options].filter((o) => o.selected).map((o) => o.text.trim()).join(',') : c.value || '',
    checked: 'checked' in c ? c.checked : undefined, options: c.tagName === 'SELECT' ? [...c.options].map((o) => o.text.trim()).filter(Boolean).slice(0, 30) : undefined,
    shown: shown(c), classes: c.className && String(c.className).slice(0, 80), attrs: [...c.attributes].filter((a) => /^(data-|aria-)/.test(a.name)).map((a) => `${a.name}=${a.value}`).slice(0, 6),
  }));
  const blocks = [...document.querySelectorAll('[data-questionid], [data-question-id], .question, .field, fieldset, .form-group, [class*=question], [class*=field]')]
    .filter((b) => !b.parentElement?.closest('[data-questionid], .question, fieldset') || b.matches('[data-questionid]'))
    .map((b) => ({ classes: String(b.className).slice(0, 100), attrs: [...b.attributes].filter((a) => /^data-/.test(a.name)).map((a) => `${a.name}=${a.value}`).slice(0, 5),
      label: text(b.querySelector('label, legend, [class*=label], [class*=title]')) || text(b).slice(0, 120), required: /required|\*/.test(text(b)) || !!b.querySelector('[required], [aria-required=true]'),
      shown: shown(b), controls: ctl(b) })).slice(0, 200);
  const dump = {
    url: location.href, title: document.title, at: new Date().toISOString(),
    headings: [...document.querySelectorAll('h1, h2, h3, h4, [class*=title], [class*=heading]')].map((h) => ({ text: text(h), classes: String(h.className).slice(0, 80), shown: shown(h) })).filter((h) => h.text).slice(0, 80),
    cards: [...document.querySelectorAll('form, .card, section, [class*=form], [class*=step], [class*=section]')].map((c) => ({ tag: c.tagName.toLowerCase(), classes: String(c.className).slice(0, 120), shown: shown(c), controls: ctl(c).length, text: text(c).slice(0, 100) })).filter((c) => c.controls || c.text).slice(0, 80),
    nav: [...document.querySelectorAll('nav li, [role=tablist] li, [class*=progress] li, [class*=step] li')].map((li) => ({ text: text(li), classes: String(li.className).slice(0, 100) })).slice(0, 40),
    blocks,
    buttons: [...document.querySelectorAll('button, a.btn, [role=button], input[type=submit]')].map((b) => ({ text: text(b), classes: String(b.className).slice(0, 100), shown: shown(b), disabled: !!b.disabled, type: b.getAttribute('type') || '' })).filter((b) => b.text).slice(0, 60),
    iframes: [...document.querySelectorAll('iframe')].map((f) => f.src).slice(0, 10),
  };
  const json = JSON.stringify(dump, null, 1);
  copy(json);
  console.log('[snapshot] copied', json.length, 'chars —', dump.blocks.length, 'question blocks,', dump.buttons.length, 'buttons');
  return dump;
})();

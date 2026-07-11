import { chromium } from 'playwright';
import { join, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const EXT = join(ROOT, '.output', 'chrome-mv3');
const url = 'https://careers.datadoghq.com/detail/8038652/?gh_jid=8038652';

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'jobbot-diag-')), {
  headless: false,
  viewport: { width: 1280, height: 1400 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

let frame;
for (let i = 0; i < 60; i++) {
  frame = page.frames().find((f) => /greenhouse\.io\/embed/.test(f.url()));
  if (frame && (await frame.$('#country'))) break;
  await page.waitForTimeout(500);
}
await page.waitForTimeout(800); // EARLY, like the real apply

const result = await frame.evaluate(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (el) => { for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, button: 0 })); };

  async function openMenu(id) {
    const input = () => document.getElementById(id);
    const control = () => input()?.closest('.select__control');
    for (let i = 0; i < 30; i++) {
      const menu = document.querySelector('.select__menu');
      if (menu && menu.querySelector('.select__option')) return menu.querySelectorAll('.select__option').length;
      if (input()?.getAttribute('aria-expanded') !== 'true' && control()) click(control());
      await wait(200);
    }
    return 0;
  }

  const country = await openMenu('country');
  // close it, then try a yes/no select
  document.getElementById('country')?.blur();
  await wait(300);
  return { country };
});
console.log('aria-gated openMenu (EARLY):', JSON.stringify(result));
await ctx.close();

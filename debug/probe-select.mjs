import { chromium } from 'playwright';
import { join, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const EXT = join(ROOT, '.output', 'chrome-mv3');
const url = 'https://careers.datadoghq.com/detail/8038652/?gh_jid=8038652';

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'jobbot-probe-')), {
  headless: false,
  viewport: { width: 1280, height: 1400 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

// wait for the greenhouse iframe
let frame;
for (let i = 0; i < 60; i++) {
  frame = page.frames().find((f) => /greenhouse\.io\/embed/.test(f.url()));
  if (frame && (await frame.$('#country'))) break;
  await page.waitForTimeout(500);
}
console.log('frame:', !!frame);

const probe = async (label, fn) => {
  await frame.evaluate(() => document.querySelectorAll('.select__menu').forEach((m) => m.remove()));
  await fn();
  await page.waitForTimeout(600);
  const menu = await frame.$('.select__menu');
  const nOpts = menu ? (await frame.$$('.select__option')).length : 0;
  console.log(`  ${label}: menu=${!!menu} options=${nOpts}`);
};

// 1. real trusted playwright click on the control
await probe('real click on .select__control', async () => {
  const ctrl = await frame.$('#country');
  const control = await ctrl.evaluateHandle((el) => el.closest('.select__control'));
  await control.asElement().click({ force: true }).catch((e) => console.log('   click err', e.message));
});

// 2. our synthetic click() helper (mousedown/mouseup/click)
await probe('synthetic mousedown/up/click', async () => {
  await frame.evaluate(() => {
    const el = document.getElementById('country').closest('.select__control');
    for (const t of ['mousedown', 'mouseup', 'click'])
      el.dispatchEvent(new MouseEvent(t, { bubbles: true }));
  });
});

// 3. focus + ArrowDown keydown (react-select also opens on this)
await probe('focus + ArrowDown', async () => {
  await frame.evaluate(() => {
    const input = document.getElementById('country');
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 }));
  });
});

// 4. mousedown with button:0 explicitly on the input-container
await probe('mousedown{button:0} on control', async () => {
  await frame.evaluate(() => {
    const el = document.getElementById('country').closest('.select__control');
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  });
});

await ctx.close();

// Automated end-to-end drive of the JobBot extension against a REAL Datadog form.
// Loads the built extension in a headed Chromium, opens a job, triggers the content-script
// `apply` in dry-run mode (fills + verifies, never clicks the real submit), and captures
// console logs + screenshots + a final field dump so we can see exactly what filled.
//
//   node debug/e2e-apply.mjs [jobId]
//
// Default job = 8038652 (the one from the bug screenshots).

import { chromium } from 'playwright';
import { readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');
const EXT = join(ROOT, '.output', 'chrome-mv3');
const OUT = join(ROOT, 'debug', 'e2e');
mkdirSync(OUT, { recursive: true });

const jobId = process.argv[2] ?? '8038652';
const jobUrl = `https://careers.datadoghq.com/detail/${jobId}/?gh_jid=${jobId}`;

// --- profile + resume from disk (bypasses the popup's File System Access picker) ---
const profile = parseYaml(readFileSync(join(ROOT, 'profile', 'profile.yaml'), 'utf8'));
const [sub, fname] = profile.resume.split('/');
const resumeBytes = readFileSync(join(ROOT, 'profile', sub, fname ?? ''));
const resume = {
  name: fname ?? sub,
  type: 'application/pdf',
  dataBase64: resumeBytes.toString('base64'),
};
// Pull the real job (title + location) from Typesense so job.locations is populated exactly
// like the live pipeline — the "which cities" multiselect derives its answer from it.
const ts = await fetch(
  'https://gk6e3zbyuntvc5dap.a1.typesense.net/multi_search?x-typesense-api-key=1Hwq7hntXp211hKvRS3CSI2QSU7w2gFm',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      searches: [{ collection: 'careers_alias', preset: 'careers_list_view', q: '*', filter_by: `job_id:${jobId}`, per_page: 1, page: 1 }],
    }),
  },
).then((r) => r.json());
const doc = ts.results?.[0]?.hits?.[0]?.document ?? {};
const locations = (doc.location_string ?? '')
  .split(';')
  .map((p) => p.split(',')[0]?.trim())
  .filter(Boolean);
const job = {
  id: jobId,
  title: doc.title ?? `Datadog job ${jobId}`,
  team: doc.team ?? '',
  department: doc.department ?? '',
  url: jobUrl,
  locations,
  seniority: doc.time_type ?? [],
};
console.log('  job:', job.title, '| locations:', JSON.stringify(job.locations));

const log = (...a) => console.log('  ', ...a);

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'jobbot-e2e-')), {
  headless: false,
  viewport: { width: 1280, height: 1400 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

// grab the extension service worker (MV3 background)
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
log('extension SW:', sw.url());

const page = ctx.pages()[0] ?? (await ctx.newPage());

// capture ALL console (page + iframes); highlight our [jobbot] lines
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('[jobbot]')) console.log('  JOBBOT>', t);
});
page.on('pageerror', (e) => console.log('  PAGEERR>', e.message));

console.log(`\n=== opening ${jobUrl} ===`);
await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

// find the tab id in the SW context
const tabId = await sw.evaluate(async () => {
  const tabs = await chrome.tabs.query({ url: 'https://careers.datadoghq.com/*' });
  return tabs[0]?.id ?? null;
});
log('tabId:', tabId);

// wait for the greenhouse iframe content script to answer the readiness ping
let ready = false;
for (let i = 0; i < 60; i++) {
  ready = await sw.evaluate(async (id) => {
    try {
      const r = await chrome.tabs.sendMessage(id, { t: 'ping' });
      return r?.pong === true;
    } catch {
      return false;
    }
  }, tabId);
  if (ready) break;
  await page.waitForTimeout(500);
}
log('form frame ready:', ready);
if (!ready) {
  await page.screenshot({ path: join(OUT, 'no-frame.png'), fullPage: true });
  console.log('form frame never became ready — see debug/e2e/no-frame.png');
  await ctx.close();
  process.exit(1);
}

await page.screenshot({ path: join(OUT, '1-before.png'), fullPage: true });
console.log('\n=== triggering apply (dryRun) ===');

const outcome = await sw.evaluate(
  async ({ id, msg }) => {
    try {
      return await chrome.tabs.sendMessage(id, msg);
    } catch (e) {
      return { status: 'error', note: String(e) };
    }
  },
  { id: tabId, msg: { t: 'apply', profile, job, resume, autoSubmit: false, dryRun: true } },
);
console.log('\n=== outcome:', JSON.stringify(outcome), '===');

// let any late remount settle, then dump every field value from the iframe
await page.waitForTimeout(1500);
const frame = page.frames().find((f) => /greenhouse\.io\/embed/.test(f.url()));
const dump = frame
  ? await frame.evaluate(() => {
      const out = [];
      for (const label of document.querySelectorAll('label[for]')) {
        const id = label.getAttribute('for');
        const el = document.getElementById(id);
        if (!el) continue;
        let val = '';
        if (el.tagName === 'INPUT' && el.type === 'file') val = el.files?.[0]?.name ?? '(no file)';
        else if ('value' in el) val = el.value;
        const rs = el.closest?.('.select__control');
        if (rs) val = rs.textContent?.trim() ?? val;
        out.push({ id, kind: el.type ?? el.tagName, value: (val || '').slice(0, 50) });
      }
      return out;
    })
  : [];

console.log('\n=== FINAL FIELD VALUES (from the live iframe) ===');
for (const f of dump) console.log(`  ${(f.value ? 'OK  ' : 'MISS')} ${f.id} [${f.kind}] = ${JSON.stringify(f.value)}`);

await page.screenshot({ path: join(OUT, '2-after.png'), fullPage: true });
if (frame) await frame.locator('body').screenshot({ path: join(OUT, '3-form.png') }).catch(() => {});
console.log('\nscreenshots -> debug/e2e/{1-before,2-after,3-form}.png');

await ctx.close();

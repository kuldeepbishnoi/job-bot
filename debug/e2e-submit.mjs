// REAL end-to-end submit against a live Datadog Greenhouse form, using your ACTUAL Chrome
// profile (so Gmail is logged in for the OTP step). Unlike debug/e2e-apply.mjs this is NOT a
// dry run — it clicks submit, waits for the 8-char verification email, types it, and submits
// again. Targets exactly ONE job.
//
//   1. Quit Chrome fully (Cmd-Q). Verify: pgrep -f 'Google Chrome' returns nothing.
//   2. node debug/e2e-submit.mjs [jobId]
//
// Default job = 8038652 (Senior Software Engineer - Linux, Tel Aviv).

import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync, cpSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');
const EXT = join(ROOT, '.output', 'chrome-mv3');
const OUT = join(ROOT, 'debug', 'e2e');
const REAL_PROFILE = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
mkdirSync(OUT, { recursive: true });

// Refuse to touch the real profile while Chrome holds the lock — it would silently ignore our
// flags (extension never loads) and can corrupt the profile.
try {
  const pids = execSync("pgrep -f 'Google Chrome' || true", { encoding: 'utf8' }).trim();
  if (pids) {
    console.error('Chrome is still running (pids: ' + pids.replace(/\n/g, ' ') + ').');
    console.error('Quit Chrome fully (Cmd-Q) and re-run. Aborting.');
    process.exit(1);
  }
} catch {}
if (!existsSync(join(EXT, 'manifest.json'))) {
  console.error('No built extension at .output/chrome-mv3 — run `npm run build` first.');
  process.exit(1);
}

const jobId = process.argv[2] ?? '8038652';
const jobUrl = `https://careers.datadoghq.com/detail/${jobId}/?gh_jid=${jobId}`;

// --- profile + resume from disk (bypasses the popup's File System Access picker) ---
const profile = parseYaml(readFileSync(join(ROOT, 'profile', 'profile.yaml'), 'utf8'));
const [sub, fname] = profile.resume.split('/');
const resumeBytes = readFileSync(join(ROOT, 'profile', sub, fname ?? ''));
const resume = { name: fname ?? sub, type: 'application/pdf', dataBase64: resumeBytes.toString('base64') };

// Real job (title + location) from Typesense so the cities multiselect resolves like the live run.
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
const locations = (doc.location_string ?? '').split(';').map((p) => p.split(',')[0]?.trim()).filter(Boolean);
const job = {
  id: jobId,
  title: doc.title ?? `Datadog job ${jobId}`,
  team: doc.team ?? '',
  department: doc.department ?? '',
  url: jobUrl,
  locations,
  seniority: doc.time_type ?? [],
};

const log = (...a) => console.log('  ', ...a);
console.log(`\n=== REAL SUBMIT: "${job.title}" (${jobId}) | locations: ${JSON.stringify(job.locations)} ===`);

// Chrome 136+ refuses CDP automation on the DEFAULT user-data-dir. Copy the logged-in profile
// (Default + Local State — cookies decrypt via the same macOS Keychain key) into a scratch,
// NON-default dir so Playwright can drive it. Skip caches/lock files.
const COPY = join(tmpdir(), 'jobbot-real-profile');
rmSync(COPY, { recursive: true, force: true });
mkdirSync(join(COPY, 'Default'), { recursive: true });
cpSync(join(REAL_PROFILE, 'Local State'), join(COPY, 'Local State'));
const SKIP = new Set(['GPUCache', 'DawnWebGPUCache', 'DawnGraphiteCache', 'Cache', 'Code Cache', 'Service Worker', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']);
cpSync(join(REAL_PROFILE, 'Default'), join(COPY, 'Default'), {
  recursive: true,
  filter: (src) => !SKIP.has(src.split('/').pop()),
});
log('profile copied to scratch dir');

const ctx = await chromium.launchPersistentContext(COPY, {
  headless: false,
  channel: 'chrome', // real Chrome binary — matches the on-disk profile version
  viewport: null,
  timeout: 60000,
  ignoreDefaultArgs: ['--disable-extensions'], // Playwright adds this; it kills our unpacked load
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

// MV3 service worker registers lazily — poll for it (opening a page below also wakes it).
let sw = ctx.serviceWorkers()[0];
for (let i = 0; i < 30 && !sw; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  sw = ctx.serviceWorkers()[0];
}
if (!sw) { console.error('extension service worker never registered — extension failed to load'); await ctx.close(); process.exit(1); }
log('extension SW:', sw.url());

// Keep a Gmail tab open for the OTP scrape.
const gmail = await ctx.newPage();
const SEARCH = 'https://mail.google.com/mail/u/0/#search/from%3Ano-reply%40us.greenhouse-mail.io+newer_than%3A1h';
await gmail.goto(SEARCH, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
if (/accounts\.google\.com|signin/i.test(gmail.url())) {
  console.error('Gmail is NOT logged in on this profile — cannot retrieve the OTP. Aborting.');
  await ctx.close();
  process.exit(1);
}
log('gmail tab ready:', gmail.url().slice(0, 60));

const page = await ctx.newPage();
page.on('console', (m) => { const t = m.text(); if (t.includes('[jobbot]')) console.log('  JOBBOT>', t); });
page.on('pageerror', (e) => console.log('  PAGEERR>', e.message));
console.log(`\n=== opening ${jobUrl} ===`);
await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

const tabId = await sw.evaluate(async () => {
  const tabs = await chrome.tabs.query({ url: 'https://careers.datadoghq.com/*' });
  return tabs[0]?.id ?? null;
});
log('job tabId:', tabId);

let ready = false;
for (let i = 0; i < 60; i++) {
  ready = await sw.evaluate(async (id) => {
    try { return (await chrome.tabs.sendMessage(id, { t: 'ping' }))?.pong === true; } catch { return false; }
  }, tabId);
  if (ready) break;
  await page.waitForTimeout(500);
}
log('form frame ready:', ready);
if (!ready) { await ctx.close(); process.exit(1); }

await page.screenshot({ path: join(OUT, 'submit-1-before.png'), fullPage: true });
console.log('\n=== phase 1: apply (REAL submit) ===');
const outcome = await sw.evaluate(
  async ({ id, msg }) => { try { return await chrome.tabs.sendMessage(id, msg); } catch (e) { return { status: 'error', note: String(e) }; } },
  { id: tabId, msg: { t: 'apply', profile, job, resume, autoSubmit: false, dryRun: false } },
);
console.log('=== phase-1 outcome:', JSON.stringify(outcome), '===');
await page.waitForTimeout(1000);
await page.screenshot({ path: join(OUT, 'submit-2-afterphase1.png'), fullPage: true });

if (outcome.status === 'submitted') {
  console.log('\nSubmitted with no OTP step. Done.');
  await page.waitForTimeout(2000);
  await ctx.close();
  process.exit(0);
}
if (outcome.status !== 'needs_otp') {
  console.log('\nNot proceeding to OTP (status was not needs_otp).');
  await ctx.close();
  process.exit(outcome.status === 'error' ? 1 : 0);
}

// --- phase 2: fetch the 8-char code from Gmail, then submit again ---
console.log('\n=== phase 2: waiting for verification email ===');
async function getCode() {
  await gmail.goto(SEARCH, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await gmail.waitForTimeout(2500);
  const row = gmail.locator('tr.zA').first();
  if (await row.count().catch(() => 0)) {
    await row.click().catch(() => {});
    await gmail.waitForTimeout(2000);
  }
  return gmail.evaluate(() => {
    const EXACT_8 = /^[A-Za-z0-9]{8}$/;
    const findCode = (root) => {
      for (const sel of ['b', 'strong', 'h1', 'h2', 'h3'])
        for (const el of root.querySelectorAll(sel)) { const t = (el.textContent || '').trim(); if (EXACT_8.test(t)) return t; }
      const text = root.textContent || '';
      const m = text.match(/application[:\s]+([A-Za-z0-9]{8})\b/i) || text.match(/paste this code[^A-Za-z0-9]+([A-Za-z0-9]{8})/i);
      return m ? m[1] : null;
    };
    for (const body of document.querySelectorAll('div.a3s, div.ii, span.y2')) {
      const text = body.textContent || '';
      if (!/security code|verification code|greenhouse/i.test(text)) continue;
      const c = findCode(body);
      if (c) return c;
    }
    return null;
  });
}

let code = null;
for (let i = 0; i < 40 && !code; i++) { // ~40 * 3s ≈ 2 min
  code = await getCode().catch(() => null);
  if (code) break;
  await page.waitForTimeout(500);
}
if (!code) {
  console.error('No verification code found in Gmail after ~2 min. Aborting before final submit.');
  await ctx.close();
  process.exit(1);
}
console.log('  got code:', code);

const otpOutcome = await sw.evaluate(
  async ({ id, code }) => { try { return await chrome.tabs.sendMessage(id, { t: 'otp', code, autoSubmit: true }); } catch (e) { return { status: 'error', note: String(e) }; } },
  { id: tabId, code },
);
console.log('\n=== OTP outcome:', JSON.stringify(otpOutcome), '===');
await page.waitForTimeout(2000);
await page.screenshot({ path: join(OUT, 'submit-3-final.png'), fullPage: true });
console.log('screenshots -> debug/e2e/submit-{1-before,2-afterphase1,3-final}.png');
await ctx.close();
process.exit(otpOutcome.status === 'submitted' ? 0 : 1);

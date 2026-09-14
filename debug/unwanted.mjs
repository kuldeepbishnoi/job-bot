#!/usr/bin/env node
// Which already-sent applications would NOT pass the profile's current want.titles filter?
//
// Context: until 2026-09-15 the Instahyre pack had no title filter at all and applied to every
// card (see entrypoints/instahyre.content.ts). Those applications are real and cannot be undone
// by the bot — this lists them so a human can go withdraw them.
//
//   node debug/unwanted.mjs                # every site, grouped
//   node debug/unwanted.mjs --site instahyre
//   node debug/unwanted.mjs --json         # machine-readable
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] ?? true : d; };
const site = opt('--site');
const asJson = args.includes('--json');

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
function profileDirs() {
  const out = [];
  if (process.env.JOBBOT_PROFILE) out.push(process.env.JOBBOT_PROFILE);
  out.push(join(repo, 'profile'));
  const parent = dirname(repo);
  try { for (const d of readdirSync(parent)) out.push(join(parent, d, 'profile')); } catch {}
  return [...new Set(out)].filter((d) => existsSync(join(d, 'applications', 'applications.jsonl')));
}
const dirs = profileDirs().sort((a, b) =>
  statSync(join(b, 'applications', 'applications.jsonl')).mtimeMs - statSync(join(a, 'applications', 'applications.jsonl')).mtimeMs);
const dir = dirs[0];
if (!dir) {
  console.error('no profile/applications/applications.jsonl found — set JOBBOT_PROFILE');
  process.exit(1);
}

const want = (() => {
  try { return parse(readFileSync(join(dir, 'profile.yaml'), 'utf8'))?.want ?? {}; } catch { return {}; }
})();
const anyOf = (want.titles_any ?? []).map((s) => String(s).toLowerCase());
const noneOf = (want.titles_none ?? []).map((s) => String(s).toLowerCase());

/** Same rule as engine/select-jobs.ts#titleWanted — keep these in step. */
const wanted = (title) => {
  const t = String(title ?? '').toLowerCase();
  if (anyOf.length && !anyOf.some((x) => t.includes(x))) return false;
  return !noneOf.some((x) => t.includes(x));
};

const recs = readFileSync(join(dir, 'applications', 'applications.jsonl'), 'utf8')
  .trim().split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean)
  .filter((r) => r.status === 'applied')
  .filter((r) => !site || r.company === site);

const bad = recs.filter((r) => !wanted(r.title));

if (asJson) {
  console.log(JSON.stringify(bad, null, 2));
  process.exit(0);
}

console.log(`records: ${dir}/applications  ·  filter: titles_any=[${anyOf.join(', ')}] titles_none=[${noneOf.join(', ')}]`);
console.log(`applied: ${recs.length}   would NOT pass the filter today: ${bad.length}\n`);
const bySite = {};
for (const r of bad) (bySite[r.company] ??= []).push(r);
for (const [s, list] of Object.entries(bySite).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${s} — ${list.length}`);
  for (const r of list) console.log(`   ${r.date}  ${r.title}`);
  console.log();
}
if (bad.length) console.log('These were really submitted. The bot cannot withdraw them — open each site and withdraw by hand.');

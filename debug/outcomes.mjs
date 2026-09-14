#!/usr/bin/env node
// Compact run report from the ON-DISK records (profile/applications/*.jsonl + log-<date>.txt) —
// the complete, append-only history the extension writes as it goes. Falls back to reading the
// extension's LevelDB straight from Chrome's storage dir when no disk records exist (that path is
// lossy: .ldb blocks are compressed, so lines come out garbled — see debug/storage.mjs).
//
//   node debug/outcomes.mjs                    # today's outcomes per job + last 5 log lines
//   node debug/outcomes.mjs --all              # every day
//   node debug/outcomes.mjs --log 40           # last 40 log lines (from log-<date>.txt)
//   node debug/outcomes.mjs --job 4463626521   # one job: record, fields with sources, its log
//   node debug/outcomes.mjs --review           # questions that need a human answer, grouped by label
//   node debug/outcomes.mjs --fields           # today's records with every field + source
//   JOBBOT_PROFILE=/path/to/profile node debug/outcomes.mjs   # the folder the popup was pointed at
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] ?? true : d; };
const has = (k) => args.includes(k);
const today = new Date().toISOString().slice(0, 10);
const job = opt('--job');

// ---- locate profile/applications: env, this repo, or any sibling worktree (newest wins) ----
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
function candidates() {
  const out = [];
  if (process.env.JOBBOT_PROFILE) out.push(join(process.env.JOBBOT_PROFILE, 'applications'));
  out.push(join(repo, 'profile', 'applications'));
  const parent = dirname(repo);
  try { for (const d of readdirSync(parent)) out.push(join(parent, d, 'profile', 'applications')); } catch {}
  return [...new Set(out)].filter((d) => existsSync(join(d, 'applications.jsonl')));
}
const dirs = candidates().sort((a, b) => statSync(join(b, 'applications.jsonl')).mtimeMs - statSync(join(a, 'applications.jsonl')).mtimeMs);
const dir = dirs[0];

if (!dir) {
  console.log('no on-disk records found (profile/applications/applications.jsonl) — set JOBBOT_PROFILE or open the popup once to flush; falling back to LevelDB');
  const { storageDir, rawDump, records } = await import('./storage.mjs');
  const sd = storageDir();
  if (!sd) { console.log('no JobBot storage found'); process.exit(1); }
  report(records(rawDump(sd)), [], []);
} else {
  const lines = (name) => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const recs = lines('applications.jsonl');
  const review = existsSync(join(dir, 'review.jsonl')) ? lines('review.jsonl') : [];
  const logFiles = readdirSync(dir).filter((f) => /^log-\d{4}-\d\d-\d\d\.txt$/.test(f)).sort();
  const logLines = logFiles.flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean));
  console.log(`records: ${dir}  (${recs.length} lines, ${review.length} review lines, ${logFiles.length} log files)`);
  report(recs, review, logLines);
}

function report(recs, review, logLines) {
  const byKey = new Map();
  for (const r of recs) byKey.set(`${r.jobId}@${r.at ?? r.date}`, r); // last write wins
  let list = [...byKey.values()].filter((r) => has('--all') || r.date === today);
  if (job) list = [...byKey.values()].filter((r) => r.jobId === job);

  if (has('--review')) return printReview(review.filter((l) => has('--all') || l.at?.slice(0, 10) === today));

  const counts = list.reduce((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
  const src = (r) => (r.fields ?? []).reduce((a, f) => ((a[f.source ?? '?'] = (a[f.source ?? '?'] ?? 0) + 1), a), {});
  console.log(`JobBot ${job ? `job ${job}` : has('--all') ? 'all days' : today}: ${list.length} records — ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}`);
  for (const r of list) {
    const mark = r.status === 'applied' ? '✓' : r.status === 'parked' ? '⚠' : '✗';
    const s = src(r);
    const flags = ['guessed', 'unanswered', 'coerced'].filter((k) => s[k]).map((k) => `${s[k]} ${k}`).join(', ');
    console.log(` ${mark} ${r.jobId} ${(r.title ?? '').slice(0, 52).padEnd(52)} ${(r.note ?? '').slice(0, 80)}${flags ? `  [${flags}]` : ''}${r.files?.length ? `  📎${r.files.length}` : ''}`);
    if (has('--fields') || job) {
      for (const f of r.fields ?? []) console.log(`     · ${f.label.slice(0, 60).padEnd(60)} = ${String(f.value).slice(0, 50).padEnd(50)} ${f.source ?? '?'}${f.intent ? ` (${f.intent})` : ''}${f.error ? `  ⚠ ${f.error}` : ''}`);
      if (r.resume) console.log(`     résumé: ${r.resume}`);
      if (r.location) console.log(`     location: ${r.location}`);
      for (const f of r.files ?? []) console.log(`     file: ${f}`);
    }
    if (job) for (const l of r.log ?? []) console.log('     ' + l.slice(0, 220));
  }

  const n = Number(opt('--log', 5));
  const pool = logLines.length ? logLines : [...byKey.values()].flatMap((r) => r.log ?? []);
  const tail = pool.filter((l) => !job || l.includes(job)).slice(-n);
  console.log(`\nlast ${n} log lines${logLines.length ? '' : ' (from records — no log-<date>.txt yet)'}:`);
  for (const l of tail) console.log(' ' + l.slice(0, 220));
}

/** Questions the bot could not answer from the profile, grouped so the missing keys are one list. */
function printReview(lines) {
  if (!lines.length) return console.log('nothing to review 🎉');
  const groups = new Map();
  for (const l of lines) {
    const k = `${l.source}|${l.label.toLowerCase().replace(/\s+/g, ' ').trim()}`;
    const g = groups.get(k) ?? { source: l.source, label: l.label, n: 0, intents: new Set(), options: new Set(), values: new Set(), errors: new Set(), jobs: new Set() };
    g.n++;
    if (l.intent) g.intents.add(l.intent);
    for (const o of l.options ?? []) g.options.add(o);
    if (l.value) g.values.add(String(l.value).slice(0, 40));
    if (l.error) g.errors.add(l.error);
    g.jobs.add(l.jobId);
    groups.set(k, g);
  }
  const order = { unanswered: 0, guessed: 1, coerced: 2, unknown: 3, profile: 4, override: 5, prefilled: 6 };
  const sorted = [...groups.values()].sort((a, b) => (order[a.source] ?? 9) - (order[b.source] ?? 9) || b.n - a.n);
  console.log(`${lines.length} review lines, ${sorted.length} distinct questions (source · count · label):`);
  for (const g of sorted) {
    console.log(` ${g.source.padEnd(10)} ×${String(g.n).padEnd(3)} ${g.label.slice(0, 90)}`);
    const meta = [g.intents.size ? `intent ${[...g.intents].join('/')}` : 'NO INTENT (add a matcher rule)', g.options.size ? `options [${[...g.options].slice(0, 8).join(' | ')}]` : '', g.values.size ? `typed ${[...g.values].slice(0, 4).map((v) => JSON.stringify(v)).join(', ')}` : '', g.errors.size ? `error ${[...g.errors].slice(0, 2).join('; ')}` : ''].filter(Boolean);
    console.log(`            ${meta.join(' · ').slice(0, 300)}`);
  }
  console.log('\nFix: add the answer key to profile.yaml (see profile.example.yaml) or a matcher rule (src/engine/matcher.ts) for questions with NO INTENT.');
}

#!/usr/bin/env node
// Compact run report straight from the extension's storage on disk — no DevTools, few tokens.
//   node debug/outcomes.mjs            # today's outcomes per job + last 5 log lines
//   node debug/outcomes.mjs --log 40   # last 40 log lines
//   node debug/outcomes.mjs --job 10524137
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.HOME;
const base = join(home, 'Library/Application Support/Google/Chrome');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] ?? true : d; };

// Find every JobBot storage dir (any Chrome profile, any extension id) — pick the newest.
const dirs = [];
for (const prof of readdirSync(base).filter((d) => /^(Default|Profile \d+)$/.test(d))) {
  const les = join(base, prof, 'Local Extension Settings');
  try { for (const id of readdirSync(les)) dirs.push(join(les, id)); } catch {}
}
const isJobbot = (d) => { try { return readdirSync(d).some((f) => /\.(log|ldb)$/.test(f) && readFileSync(join(d, f), 'latin1').includes('"company":"')); } catch { return false; } };
const dir = dirs.filter(isJobbot).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (!dir) { console.log('no JobBot storage found'); process.exit(1); }

let s = '';
for (const f of readdirSync(dir).filter((f) => /\.(log|ldb)$/.test(f)).sort((a, b) => statSync(join(dir, a)).mtimeMs - statSync(join(dir, b)).mtimeMs)) s += readFileSync(join(dir, f), 'latin1');
s = s.replace(/\\"/g, '"');

const today = new Date().toISOString().slice(0, 10);
const recs = new Map();
for (const m of s.matchAll(/\{"company":"([a-z]+)","date":"(\d{4}-\d\d-\d\d)","jobId":"([^"]+)"(?:,"note":"([^"]*)")?,"status":"([a-z]+)","title":"([^"]*)"/g)) {
  const [, company, date, jobId, note, status, title] = m;
  if (date !== today && !opt('--all')) continue;
  recs.set(jobId, { company, jobId, status, title, note: note ?? '' }); // last write wins
}
const job = opt('--job');
const list = [...recs.values()].filter((r) => !job || r.jobId === job);
const counts = list.reduce((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
console.log(`JobBot ${today}: ${list.length} jobs — ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
for (const r of list) console.log(` ${r.status === 'applied' ? '✓' : r.status === 'parked' ? '⚠' : '✗'} ${r.jobId} ${r.title.slice(0, 48).padEnd(48)} ${r.note.replace(/submitted — page moved on to .*summary\?result=/, 'result=').slice(0, 90)}`);

const n = Number(opt('--log', 5));
const lines = [...new Set([...s.matchAll(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (amazon|apply|outcome|port closed|popup|watchdog) .{0,260}?(?=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d|\x00{2}|$)/gs)].map((m) => m[0].replace(/\s+/g, ' ').replace(/"\],?.*$/, '').replace(/","$/, '')))].sort();
console.log(`\nlast ${n} log lines:`);
for (const l of lines.filter((l) => !job || l.includes(job)).slice(-n)) console.log(' ' + l.slice(0, 220));

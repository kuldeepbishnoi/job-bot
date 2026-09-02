#!/usr/bin/env node
// Compact run report straight from the extension's storage on disk — no DevTools, few tokens.
//   node debug/outcomes.mjs            # today's outcomes per job + last 5 log lines
//   node debug/outcomes.mjs --log 40   # last 40 log lines
//   node debug/outcomes.mjs --job 10524137
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] ?? true : d; };

import { storageDir, rawDump } from './storage.mjs';
const dir = storageDir();
if (!dir) { console.log('no JobBot storage found'); process.exit(1); }
const s = rawDump(dir);

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

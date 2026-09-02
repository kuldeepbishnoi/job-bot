#!/usr/bin/env node
// Export JobBot's records from Chrome's storage on disk into the append-only files in profile/:
//   applications.jsonl  (full record + that job's log lines)   registry.jsonl (jobId → account)
// Idempotent: a job@timestamp already present in applications.jsonl is skipped.
//   node debug/export.mjs                     # account = profile.yaml identity.email
//   node debug/export.mjs --account you.01@gmail.com
//   JOBBOT_PROFILE=/path/to/profile node debug/export.mjs   # when run from a worktree without profile/
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { storageDir, rawDump, records, logLines } from './storage.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const profileDir = process.env.JOBBOT_PROFILE ?? join(repo, 'profile');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const profile = existsSync(join(profileDir, 'profile.yaml')) ? parse(readFileSync(join(profileDir, 'profile.yaml'), 'utf8')) : {};
const account = opt('--account') ?? profile.identity?.email ?? '';
if (!account) { console.error('no account: pass --account <email> or set JOBBOT_PROFILE to a folder with profile.yaml'); process.exit(1); }

const dir = storageDir();
if (!dir) { console.error('no JobBot storage found'); process.exit(1); }
const dump = rawDump(dir);
const recs = records(dump);
const log = logLines(dump);

const outDir = join(profileDir, 'applications');
mkdirSync(outDir, { recursive: true });
const appsPath = join(outDir, 'applications.jsonl');
const regPath = join(outDir, 'registry.jsonl');
const have = new Set(existsSync(appsPath) ? readFileSync(appsPath, 'utf8').split('\n').filter(Boolean).map((l) => { try { const r = JSON.parse(l); return `${r.jobId}@${r.at ?? r.date}`; } catch { return ''; } }) : []);

let n = 0;
for (const r of recs.sort((a, b) => (a.at ?? a.date).localeCompare(b.at ?? b.date))) {
  const key = `${r.jobId}@${r.at ?? r.date}`;
  if (have.has(key)) continue;
  const acct = r.account || account;
  const lines = log.filter((l) => l.includes(`[${r.jobId}]`) || l.includes(` ${r.jobId} `));
  appendFileSync(appsPath, JSON.stringify({ ...r, account: acct, log: lines }) + '\n');
  appendFileSync(regPath, JSON.stringify({ jobId: r.jobId, company: r.company, account: acct, date: r.date, status: r.status }) + '\n');
  have.add(key);
  n++;
}
console.log(`exported ${n} new records (${recs.length} in storage) → ${appsPath}\nregistry: ${regPath}`);

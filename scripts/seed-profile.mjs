#!/usr/bin/env node
// Write profile/profile.yaml (+ the résumé it names) into the INSTALLED extension as
// seed/profile.json, which the extension imports on its next reload (platform/data/profile-seed.ts).
//
// Why: the dashboard keeps its own copy of the profile, and a copy saved there always beat
// profile.yaml. On 2026-10-04 that copy was a near-empty one (auto_submit off, no answers, email
// "@gmai.com") while profile.yaml was complete — and the folder link that would have read the YAML
// needs a click in the browser, so nothing outside Chrome could fix it. With the seed, editing
// profile.yaml and running `npm run install:chrome` is enough.
//
// Only ever written to ~/.jobbot/extension (the unpacked copy Chrome loads) — never to .output/,
// so `npm run build` / `npm run zip` can never package personal data.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const profileDir = process.env.JOBBOT_PROFILE ?? join(repo, 'profile');
const yamlPath = join(profileDir, 'profile.yaml');
const target = process.argv[2] ?? join(homedir(), '.jobbot', 'extension');

if (!existsSync(yamlPath)) {
  console.log(`seed: no ${yamlPath} — the extension keeps whatever profile the dashboard has`);
  process.exit(0);
}
const yaml = readFileSync(yamlPath, 'utf8');
const resumeRel = parse(yaml)?.resume;
const resumePath = typeof resumeRel === 'string' ? resolve(profileDir, resumeRel) : '';
let resume = null;
if (resumePath && existsSync(resumePath)) {
  const bytes = readFileSync(resumePath);
  resume = { name: basename(resumePath), type: /\.docx?$/i.test(resumePath) ? 'application/msword' : 'application/pdf', base64: bytes.toString('base64') };
} else {
  console.log(`seed: résumé "${resumeRel}" not found under ${profileDir} — the extension keeps its stored résumé`);
}
const hash = createHash('sha256').update(yaml).update(resume?.base64 ?? '').digest('hex').slice(0, 16);
mkdirSync(join(target, 'seed'), { recursive: true });
writeFileSync(join(target, 'seed', 'profile.json'), JSON.stringify({ hash, yaml, resume, from: yamlPath }));
console.log(`seed: ${yamlPath}${resume ? ` + ${resume.name}` : ''} → ${join(target, 'seed/profile.json')} (${hash}) — reload JobBot to apply`);

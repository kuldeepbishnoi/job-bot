#!/usr/bin/env node
// Register JobBot's disk writer (scripts/native-host/jobbot-disk.mjs) as a Chrome native-messaging
// host, so the extension can write records, captures and the log to profile/applications with no
// folder link and no dialog. Run by `npm run install:chrome`; idempotent.
//
// Chrome starts the host with a minimal environment, so the manifest points at a small wrapper
// that execs THIS machine's node by absolute path.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = 'com.jobbot.disk';
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = process.argv[2] ?? join(homedir(), '.jobbot', 'extension');

// The extension id: Chrome derives it from the manifest `key` (sha256 of the DER public key, first
// 32 hex digits mapped 0-f → a-p). Without a key the id is path-derived and cannot be known here.
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
if (!manifest.key) {
  console.log('native host: the build has no manifest key (EXTENSION_KEY) — extension id unknown, skipped');
  process.exit(0);
}
const id = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
  .split('').map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');

const hostDir = join(homedir(), '.jobbot', 'native-host');
mkdirSync(hostDir, { recursive: true });
const wrapper = join(hostDir, 'jobbot-disk.sh');
// A stable node path: process.execPath is the versioned Cellar path, which a `brew upgrade` deletes.
const node = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find((p) => existsSync(p)) ?? process.execPath;
writeFileSync(wrapper, `#!/bin/sh\nexec "${node}" "${join(repo, 'scripts', 'native-host', 'jobbot-disk.mjs')}"\n`);
chmodSync(wrapper, 0o755);

const dirs = platform() === 'darwin'
  ? [join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts')]
  : [join(homedir(), '.config', 'google-chrome', 'NativeMessagingHosts')];
for (const d of dirs) {
  if (!existsSync(dirname(d))) continue; // no Chrome here
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${HOST}.json`), JSON.stringify({
    name: HOST,
    description: 'JobBot: write application records and logs to profile/applications',
    path: wrapper,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${id}/`],
  }, null, 2));
  console.log(`native host: ${HOST} → ${wrapper} (extension ${id})`);
}

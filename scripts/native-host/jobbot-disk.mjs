// JobBot's disk writer — a Chrome native-messaging host (registered by scripts/install-native-host.mjs).
//
// The extension writes records, captures and the complete log here when the profile folder is not
// linked: that link is a File System Access grant only a click in Chrome can give, it was lost on
// 2026-10-04, and the owner asked for this to be handled with no user step. chrome.downloads was
// tried first and opened a Save dialog per file on a Chrome with "Ask where to save" on; native
// messaging never shows UI.
//
// Protocol (Chrome's): each message is a 4-byte little-endian length + UTF-8 JSON, both ways.
//   { op: 'append', path, text }            append text to <root>/<path>
//   { op: 'write',  path, text | base64 }   create/overwrite <root>/<path>
// Every path is relative to the records root (profile/applications by default) and may not leave it.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.env.JOBBOT_RECORDS ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'profile', 'applications'));

function target(rel) {
  const p = resolve(ROOT, String(rel ?? ''));
  if (p !== ROOT && !p.startsWith(ROOT + sep)) throw new Error(`path outside the records folder: ${rel}`);
  return p;
}

function handle(msg) {
  if (msg?.op === 'ping') return { ok: true, root: ROOT };
  const p = target(msg?.path);
  mkdirSync(dirname(p), { recursive: true });
  if (msg.op === 'append') appendFileSync(p, msg.text ?? '');
  else if (msg.op === 'write') writeFileSync(p, msg.base64 !== undefined ? Buffer.from(msg.base64, 'base64') : msg.text ?? '');
  else throw new Error(`unknown op ${msg?.op}`);
  return { ok: true };
}

function reply(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const raw = buf.subarray(4, 4 + len).toString('utf8');
    buf = buf.subarray(4 + len);
    try {
      reply(handle(JSON.parse(raw)));
    } catch (e) {
      reply({ ok: false, error: String(e?.message ?? e) });
    }
  }
});
process.stdin.on('end', () => process.exit(0));

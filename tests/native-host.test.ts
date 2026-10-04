import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// JobBot's native host writes records/logs/captures with no folder link and no dialog (owner,
// 2026-10-04: "it should be auto handled"). Driven here exactly as Chrome drives it: 4-byte LE
// length + JSON on stdin, the same framing back on stdout.
function talk(root: string, msgs: object[]): Promise<{ ok: boolean; error?: string }[]> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['scripts/native-host/jobbot-disk.mjs'], { env: { ...process.env, JOBBOT_RECORDS: root } });
    const out: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.on('error', reject);
    p.on('close', () => {
      let b = Buffer.concat(out);
      const replies = [];
      while (b.length >= 4) {
        const n = b.readUInt32LE(0);
        replies.push(JSON.parse(b.subarray(4, 4 + n).toString('utf8')));
        b = b.subarray(4 + n);
      }
      resolve(replies);
    });
    for (const m of msgs) {
      const body = Buffer.from(JSON.stringify(m), 'utf8');
      const head = Buffer.alloc(4);
      head.writeUInt32LE(body.length, 0);
      p.stdin.write(Buffer.concat([head, body]));
    }
    p.stdin.end();
  });
}

describe('native host (scripts/native-host/jobbot-disk.mjs)', () => {
  it('appends, writes text and binary, all under the records root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jobbot-'));
    const r = await talk(root, [
      { op: 'append', path: 'applications.jsonl', text: '{"a":1}\n' },
      { op: 'append', path: 'applications.jsonl', text: '{"a":2}\n' },
      { op: 'write', path: 'captures/x.html', text: '<p>Résumé ✓</p>' },
      { op: 'write', path: 'captures/x.png', base64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') },
    ]);
    expect(r.every((x) => x.ok)).toBe(true);
    expect(readFileSync(join(root, 'applications.jsonl'), 'utf8')).toBe('{"a":1}\n{"a":2}\n');
    expect(readFileSync(join(root, 'captures/x.html'), 'utf8')).toBe('<p>Résumé ✓</p>');
    expect([...readFileSync(join(root, 'captures/x.png'))]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('refuses any path that leaves the records root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jobbot-'));
    const [r] = await talk(root, [{ op: 'write', path: '../escape.txt', text: 'x' }]);
    expect(r!.ok).toBe(false);
    expect(existsSync(join(root, '..', 'escape.txt'))).toBe(false);
  });
});

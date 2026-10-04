// Read JobBot's chrome.storage.local straight from Chrome's LevelDB files on disk (no browser).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function storageDir() {
  const base = join(process.env.HOME, 'Library/Application Support/Google/Chrome');
  const dirs = [];
  for (const prof of readdirSync(base).filter((d) => /^(Default|Profile \d+)$/.test(d))) {
    const les = join(base, prof, 'Local Extension Settings');
    try { for (const id of readdirSync(les)) dirs.push(join(les, id)); } catch {}
  }
  const isJobbot = (d) => { try { return readdirSync(d).some((f) => /\.(log|ldb)$/.test(f) && readFileSync(join(d, f), 'latin1').includes('"company":"')); } catch { return false; } };
  return dirs.filter(isJobbot).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

export function rawDump(dir) {
  let s = '';
  for (const f of readdirSync(dir).filter((f) => /\.(log|ldb)$/.test(f)).sort((a, b) => statSync(join(dir, a)).mtimeMs - statSync(join(dir, b)).mtimeMs)) {
    const buf = readFileSync(join(dir, f));
    // .ldb tables store their blocks snappy-compressed, so a raw read of a compacted table yields
    // garbage — every log line older than the last compaction was unreadable (2026-10-04). Decode
    // the table's blocks; fall back to the raw bytes if it is not a table we understand.
    s += f.endsWith('.ldb') ? (tableText(buf) ?? buf.toString('latin1')) : buf.toString('latin1');
  }
  return s.replace(/\\"/g, '"');
}

// ---- minimal LevelDB table reader: footer → index block → data blocks (snappy) ----------------
function varint(b, o) {
  let v = 0, shift = 0, i = o;
  for (;;) { const x = b[i++]; v += (x & 0x7f) * 2 ** shift; if (x < 0x80) break; shift += 7; }
  return [v, i];
}
function snappy(src) {
  let [len, i] = varint(src, 0);
  const out = Buffer.alloc(len); let o = 0;
  while (i < src.length) {
    const tag = src[i++]; const t = tag & 3;
    if (t === 0) {
      let n = tag >> 2;
      if (n >= 60) { const k = n - 59; n = 0; for (let j = 0; j < k; j++) n |= src[i + j] << (8 * j); i += k; }
      n += 1; src.copy(out, o, i, i + n); i += n; o += n;
    } else {
      let n, off;
      if (t === 1) { n = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | src[i++]; }
      else if (t === 2) { n = (tag >> 2) + 1; off = src[i] | (src[i + 1] << 8); i += 2; }
      else { n = (tag >> 2) + 1; off = src.readUInt32LE(i); i += 4; }
      for (let j = 0; j < n; j++, o++) out[o] = out[o - off];
    }
  }
  return out;
}
function block(buf, off, size) {
  const raw = buf.subarray(off, off + size);
  return buf[off + size] === 1 ? snappy(raw) : raw; // trailer byte: 0 = none, 1 = snappy
}
function tableText(buf) {
  try {
    if (buf.length < 48) return null;
    const foot = buf.subarray(buf.length - 48);
    let o = 0, mo, ms, io, is;
    [mo, o] = varint(foot, o); [ms, o] = varint(foot, o); [io, o] = varint(foot, o); [is, o] = varint(foot, o);
    const index = block(buf, io, is);
    const restarts = index.readUInt32LE(index.length - 4);
    const end = index.length - 4 - 4 * restarts;
    let p = 0; let text = '';
    while (p < end) {
      let shared, nonShared, vlen;
      [shared, p] = varint(index, p); [nonShared, p] = varint(index, p); [vlen, p] = varint(index, p);
      p += nonShared;
      let q = p, bo, bs; [bo, q] = varint(index, q); [bs, q] = varint(index, q);
      p += vlen;
      text += block(buf, bo, bs).toString('latin1');
    }
    return text;
  } catch {
    return null;
  }
}

/** Every application record object found in the dump (all versions; last one per jobId+at wins). */
export function records(s) {
  const out = new Map();
  let i = 0;
  while ((i = s.indexOf('{"company":"', i)) !== -1) {
    // brace-match a JSON object (values may contain braces only inside strings)
    let depth = 0, j = i, inStr = false, esc = false;
    for (; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) break; }
    }
    const text = s.slice(i, j + 1);
    i = j + 1;
    try { const r = JSON.parse(text); if (r.jobId && r.status) out.set(`${r.jobId}@${r.at ?? r.date}`, r); } catch {}
  }
  return [...out.values()];
}

export function logLines(s) {
  return [...new Set([...s.matchAll(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (amazon|apply|outcome|port closed|popup|watchdog) .{0,1500}?(?=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d|\x00{2}|$)/gs)].map((m) => m[0].replace(/\s+/g, ' ').replace(/"\],?.*$/, '').replace(/","$/, '')))].sort();
}

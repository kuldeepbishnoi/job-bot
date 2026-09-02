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
  for (const f of readdirSync(dir).filter((f) => /\.(log|ldb)$/.test(f)).sort((a, b) => statSync(join(dir, a)).mtimeMs - statSync(join(dir, b)).mtimeMs)) s += readFileSync(join(dir, f), 'latin1');
  return s.replace(/\\"/g, '"');
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

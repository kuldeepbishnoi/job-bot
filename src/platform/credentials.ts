// profile/accounts.csv (git-ignored) — one row per login, extensible to any company:
//   email,site,password
//   you.01@gmail.com,amazon,temp-pass
//   you.01@gmail.com,datadog,other-pass
//   you.02@gmail.com,*,temp-pass          # * = every site
// Pure parser (tested); the popup reads the file with its folder grant and hands the result to
// the background in the `run` message. Passwords live in run_state only for the run.
export interface Credentials {
  /** site id (or '*') -> email -> password */
  readonly bySite: Record<string, Record<string, string>>;
}

export function parseCredentialsCsv(text: string): Credentials {
  const bySite: Record<string, Record<string, string>> = {};
  const rows = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const header = rows[0]?.toLowerCase().split(',').map((h) => h.trim()) ?? [];
  const has = header.includes('email') && header.includes('password');
  const idx = (k: string) => header.indexOf(k);
  for (const line of has ? rows.slice(1) : rows) {
    const cells = splitCsv(line);
    const email = (has ? cells[idx('email')] : cells[0])?.trim().toLowerCase();
    const site = ((has ? (idx('site') >= 0 ? cells[idx('site')] : '*') : cells[1]) ?? '*').trim().toLowerCase() || '*';
    const password = (has ? cells[idx('password')] : cells[2])?.trim() ?? '';
    if (!email || !password) continue;
    (bySite[site] ??= {})[email] = password;
  }
  return { bySite };
}

/** Password for `email` on `site`, falling back to a '*' row. */
export function passwordFor(c: Credentials | undefined, site: string, email: string): string | undefined {
  const e = email.toLowerCase();
  return c?.bySite[site]?.[e] ?? c?.bySite['*']?.[e];
}

/** Every login that has a password for `site` (in file order). */
export function accountsFor(c: Credentials | undefined, site: string): string[] {
  if (!c) return [];
  return [...new Set([...Object.keys(c.bySite[site] ?? {}), ...Object.keys(c.bySite['*'] ?? {})])];
}

// Minimal CSV cell splitter: handles quoted cells with commas.
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
    } else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

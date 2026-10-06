// "How many years of experience do you have WITH <X>?" — answered per skill, never with the total.
//
// Until 2026-10-05 every such question got years_of_experience (the whole career): the bot told
// employers 4 years of Microsoft Exchange, RDF, OWL, SHACL, Spring Security and React — none of
// which are on the résumé. With auto_submit on that is a false claim in the applicant's name.
// Now: a generic subject (total / backend / software development / distributed systems…) keeps the
// career total; a named technology gets profile.skills[<it>] (built from the résumé's dated roles);
// a technology the profile does not list gets 0 — the honest answer for something not on the CV.
// Pure: no I/O.

/** Subjects that ARE the career, not one technology. */
const GENERIC = /^(the\s+)?(it|software|tech|technology|industry|professional|relevant|total|overall|work|backend|back[- ]end|backend engineering|back end engineering|software development|software engineering|engineering|development|programming|coding|distributed systems?( or microservices( architecture)?)?|microservices?( architecture)?|product based (organi[sz]ations?|companies|company)|product companies|it industry|this field|the field|the industry|similar roles?|a similar role)\b/i;

/** Words that are not a skill on their own (stripped from a subject before lookup). */
const NOISE = /\b(the|a|an|work|working|hands on|hands-on|professional|experience|production|building|using|development|engineering|framework|frameworks|language|languages|technologies|technology|skills?|tools?|stack|based|systems?)\b/gi;

/** Common spellings that should hit the same profile key. */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  go: ['go', 'golang', 'go lang'],
  javascript: ['javascript', 'js'],
  typescript: ['typescript', 'ts'],
  kubernetes: ['kubernetes', 'k8s'],
  postgresql: ['postgresql', 'postgres'],
  'c++': ['c++', 'cpp'],
  aws: ['aws', 'amazon web services'],
  gcp: ['gcp', 'google cloud'],
  ci_cd: ['ci_cd', 'ci/cd', 'ci cd', 'cicd', 'continuous integration', 'devops'],
  'integration tests': ['integration tests', 'integration test', 'integration testing', 'integration suite'],
  dsa: ['dsa', 'data structures and algorithms', 'data structures', 'algorithms'],
  sql: ['sql', 'relational databases', 'rdbms'],
};

/** The subject of the LAST "with|in|using|on <subject>" clause ("…years of professional experience
 *  with Go" → "Go"), or null when the question names no subject ("total years of experience?",
 *  "5+ years of non-internship software development experience?") — those are the career total. */
export function skillSubject(label: string): string | null {
  const clean = label.replace(/["“”]/g, '').replace(/\(.*?\)/g, ' ');
  const re = /\b(?:with|in|using|on)\s+(?!years?\b|experience\b)/gi;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(clean); m; m = re.exec(clean)) last = m;
  if (!last) return null;
  const rest = clean.slice(last.index + last[0].length);
  const subject = rest.split(/\?|\.\s|,\s*(?:please|if)\b/i)[0]!.trim();
  return subject || null;
}

function keysFor(token: string, skills: Readonly<Record<string, number>>): string[] {
  const t = token.toLowerCase().replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const out: string[] = [];
  for (const key of Object.keys(skills)) {
    const names = [key.toLowerCase(), ...(ALIASES[key.toLowerCase()] ?? [])];
    if (names.some((n) => t === n || new RegExp(`(^|[^a-z0-9+#.])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9+#.])`).test(t))) out.push(key);
  }
  return out;
}

/** "CI/CD" is one skill, not "CI" and "CD": protect it before splitting a subject on "/". */
function splitSubject(subject: string): string[] {
  return subject.replace(/\bci\s*\/\s*cd\b/gi, 'ci_cd').split(/\s*(?:\/|,|&|\band\b|\bor\b|\+)\s*/i).filter(Boolean);
}

/** Years for the technology a question names: null = generic (use the career total), else the
 *  profile's figure for the best-matching skill in the subject, else 0 (not on the résumé). */
export function skillYears(label: string, skills: Readonly<Record<string, number>>): number | null {
  // Leading people or projects is not a technology: only an explicit `leadership` entry answers it.
  if (/\b(managing|manage|handling|handled|leading|lead|led)\b.{0,40}\b(team|teams|projects?|people|engineers)\b/i.test(label)) return skills['leadership'] ?? 0;
  const subject = skillSubject(label);
  if (!subject) return null;
  // "React OR Angular", "JavaScript & TypeScript", "Python/FastAPI", "Node.js, React.js, PHP and AWS".
  // A named skill wins over a generic word around it ("Java software development" is Java).
  let best: number | null = null;
  for (const p of splitSubject(subject)) for (const k of keysFor(p, skills)) best = Math.max(best ?? 0, skills[k]!);
  if (best !== null) return best;
  if (GENERIC.test(subject.trim()) || /\b(software development|software engineering|backend|back-end|distributed systems|microservices)\b/i.test(subject)) return null;
  return 0;
}

/** A yes/no "Have you used / Do you have experience with <skill>…?": true only when EVERY technology
 *  the question names is in the profile with years > 0; false when one of them is listed at 0;
 *  null when it names something the profile does not list (other rules / the review file decide). */
export function hasSkill(label: string, skills: Readonly<Record<string, number>>): boolean | null {
  if (!/\b(experience|used|use|worked|work with|built|hands-on|hands on|familiar|proficient|knowledge|written|developed)\b/i.test(label)) return null;
  const subject = skillSubject(label);
  const parts = splitSubject(subject ?? '').filter((p) => p.replace(NOISE, '').trim());
  if (parts.length) {
    const keys = parts.map((p) => keysFor(p, skills));
    if (keys.every((k) => k.length)) return keys.every((k) => k.some((x) => (skills[x] ?? 0) > 0));
  }
  // No usable subject ("Have you used Go concurrency features … in production?"): the label itself.
  const named = Object.keys(skills).filter((key) => [key.toLowerCase(), ...(ALIASES[key.toLowerCase()] ?? [])].some((n) => new RegExp(`(^|[^a-z0-9+#.])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9+#.])`, 'i').test(label)));
  if (!named.length) return null;
  return named.every((k) => (skills[k] ?? 0) > 0) ? true : null;
}

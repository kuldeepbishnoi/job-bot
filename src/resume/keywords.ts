// Keywords = the skills the user already lists in their résumé variants. No AI, no external
// taxonomy: the vocabulary is derived from the Technical Skills lines, so every keyword we can
// match in a JD is one the user has actually claimed somewhere. Pure.
import { escapeTex, unescapeTex, type ResumeTex } from './tex.ts';

export interface Term {
  readonly key: string; // normalized canonical form, e.g. "google cloud platform"
  readonly display: string; // as it should appear on a skills line (unescaped), e.g. "Google Cloud Platform (GCP)"
  readonly category: string; // unescaped category it was first listed under, e.g. "Cloud Platforms"
  readonly aliases: readonly string[]; // normalized alternative keys
  readonly patterns: readonly RegExp[];
}

/** Alternative *spellings* JDs use for the same thing — never synonyms (no "monitoring" for
 *  observability), or every JD would reorder the page. Generic, not per-user: a user adds their own
 *  aliases in the .tex itself as a parenthetical, e.g. `Kubernetes (K8s)`. Any member of a class
 *  pulls in the whole class, so a résumé that says "Postgres" still matches a JD that says
 *  "PostgreSQL". Spellings keep their case (it decides case-sensitivity, see `pattern`). */
const ALIAS_CLASSES: readonly (readonly string[])[] = [
  ['Go', 'golang'],
  ['C++', 'cpp'],
  ['Python', 'python3'],
  ['JavaScript', 'JS'],
  ['TypeScript', 'TS'],
  ['HTML', 'HTML5'],
  ['CSS', 'CSS3'],
  ['Node.js', 'nodejs'],
  ['React', 'reactjs', 'react.js'],
  ['PostgreSQL', 'postgres'],
  ['MongoDB', 'mongo'],
  ['AWS', 'amazon web services'],
  ['Google Cloud Platform', 'GCP', 'google cloud'],
  ['Azure', 'microsoft azure'],
  ['Kubernetes', 'k8s'],
  ['Apache Kafka', 'kafka'],
  ['REST APIs', 'REST', 'RESTful', 'REST API'],
  ['Microservices', 'microservice', 'micro-services'],
  ['CI/CD', 'cicd', 'ci-cd', 'continuous integration', 'continuous delivery'],
  ['Data Structures & Algorithms', 'DSA'],
  ['Machine Learning', 'ML'],
];
const ALIAS_CLASS = new Map<string, readonly string[]>();
for (const cls of ALIAS_CLASSES) for (const member of cls) ALIAS_CLASS.set(norm(member), cls);

/** Canonical key: no parenthetical, `&` → and, lowercase, single spaces. */
export function norm(s: string): string {
  return unescapeTex(s)
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Union of every skill listed across the variants, merged by key/alias, in first-seen order. */
export function vocabulary(resumes: readonly ResumeTex[]): Term[] {
  // aliases = normalized keys (for merging/lookup); forms = raw spellings (for matching, case kept).
  const terms: { key: string; display: string; category: string; aliases: Set<string>; forms: Set<string> }[] = [];
  for (const r of resumes) {
    for (const line of r.skills) {
      for (const item of line.items) {
        const key = norm(item.text);
        if (!key) continue;
        const forms = [bareDisplay(item.text), ...(ALIAS_CLASS.get(key) ?? []), ...slashParts(item.text), ...parentheticalAliases(item.text)];
        const aliases = new Set(forms.map(norm));
        const related = terms.filter((t) => t.key === key || t.aliases.has(key) || [...aliases].some((a) => t.key === a || t.aliases.has(a)));
        const existing = related[0];
        if (existing) {
          // One skill may bridge two terms seen earlier ("GCP" and "Google Cloud" via
          // "Google Cloud Platform (GCP)") — fold them all into the first.
          for (const other of related.slice(1)) {
            other.aliases.forEach((a) => existing.aliases.add(a));
            other.forms.forEach((f) => existing.forms.add(f));
            existing.aliases.add(other.key);
            terms.splice(terms.indexOf(other), 1);
          }
          aliases.forEach((a) => existing.aliases.add(a));
          forms.forEach((f) => existing.forms.add(f));
          if (displayRank(item.text) > displayRank(existing.display)) existing.display = item.text;
        } else {
          terms.push({ key, display: item.text, category: unescapeTex(line.category), aliases, forms: new Set(forms) });
        }
      }
    }
  }
  return terms.map((t) => ({
    key: t.key,
    display: t.display,
    category: t.category,
    aliases: [...t.aliases].filter((a) => a !== t.key),
    patterns: [...t.forms].map(pattern),
  }));
}

/** How many times each term occurs in `text`, counting each mention once even when several
 *  spellings overlap it ("Apache Kafka" is one hit, not "Apache Kafka" + "Kafka"). */
export function findTerms(text: string, terms: readonly Term[]): Map<string, number> {
  const hits = new Map<string, number>();
  for (const t of terms) {
    const spans = t.patterns
      .flatMap((p) => [...text.matchAll(p)].map((m) => [m.index, m.index + m[0].length] as const))
      .sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    let n = 0;
    let end = -1;
    for (const [s, e] of spans) if (s >= end) [n, end] = [n + 1, e];
    if (n > 0) hits.set(t.key, n);
  }
  return hits;
}

/** The Term an authored skills item refers to, if any. */
export function lookup(terms: readonly Term[], itemText: string): Term | undefined {
  const key = norm(itemText);
  return terms.find((t) => t.key === key || t.aliases.includes(key));
}

/** Bold the skill name only, keeping a qualifier as authored: "Terraform (Familiar)" → `\textbf{Terraform} (Familiar)`. */
export function boldTex(text: string): string {
  const i = text.indexOf(' (');
  return i < 0 ? `\\textbf{${text}}` : `\\textbf{${text.slice(0, i)}}${text.slice(i)}`;
}

/** Escaped + bolded, ready to drop on a skills line. */
export function displayTex(t: Term): string {
  return boldTex(escapeTex(t.display));
}

/** Which spelling represents the skill on an imported line: one carrying an acronym alias beats a
 *  bare name ("Google Cloud Platform (GCP)" > "GCP"), and a bare name beats a hedge ("Python" >
 *  "Python (Basics)") — never advertise the weakest self-assessment. Ties → longer. */
function displayRank(display: string): number {
  const tier = parentheticalAliases(display).length > 0 ? 2 : /\(/.test(display) ? 0 : 1;
  return tier * 1000 + display.length;
}

// "C/C++" and "HTML/CSS" are two skills written as one token: match either half too.
function slashParts(text: string): string[] {
  const bare = bareDisplay(text);
  return !bare.includes(' ') && bare.includes('/') ? bare.split('/').filter((x) => x.length >= 2) : [];
}

// A parenthetical acronym is an alias: "Google Kubernetes Engine (GKE)" → GKE, "(K8s)", "(ES6)".
// A qualifier like "(Familiar)", "(Basics)", "(2020)" or "(Compose)" is not.
function parentheticalAliases(text: string): string[] {
  return [...text.matchAll(/\(([A-Za-z0-9+#.]+)\)/g)]
    .map((m) => m[1]!)
    .filter((a) => /^(?=.*[A-Z])[A-Z0-9+#.]{2,8}$/.test(a) || /^[A-Z][A-Za-z]*\d[A-Za-z0-9]*$/.test(a));
}

function bareDisplay(display: string): string {
  return unescapeTex(display).replace(/\s*\([^)]*\)/g, '').trim();
}

/**
 * Word-bounded match for one spelling. Two-letter or ALL-CAPS forms are case-sensitive ("Go" the
 * language, not "go to market"; "REST", not "the rest"). "&" also matches "and". A multi-word plural
 * also matches its singular ("Distributed System(s)") and an acronym its plural ("API(s)") — single
 * words are otherwise matched exactly, so "Rails" is not "rail", "R" is not "Rs", "React" is not
 * "reacts".
 */
function pattern(form: string): RegExp {
  const sensitive = form.length <= 2 || form === form.toUpperCase();
  const stemmed = form.includes(' ') && /[A-Za-rt-z]s$/.test(form) && !/(?:is|us)$/.test(form);
  const stem = stemmed ? form.slice(0, -1) : form;
  const plural = stemmed || (form.length >= 2 && form === form.toUpperCase() && !/S$/.test(form));
  const body = `${escapeRe(stem)}${plural ? 's?' : ''}`.replace(/ & /g, ' (?:&|and) ');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}+#]|\\.\\p{L})`, sensitive ? 'gu' : 'giu');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

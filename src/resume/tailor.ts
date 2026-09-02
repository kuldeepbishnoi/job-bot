// JD text + the user's résumé variants → one tailored .tex. Pure and deterministic: same inputs,
// same bytes out. No AI, no network.
//
//   1. keywords  = skills the user lists in ANY variant that also appear in the JD (see keywords.ts)
//   2. variant   = the .tex whose text already mentions the most of those keywords, weighted by how
//                  often the JD repeats them (capped); a keyword in the headline counts double (the
//                  headline is the variant's declared focus). A dead heat — common when a JD names
//                  few skills — is settled by plain word overlap between the JD and each variant's
//                  prose ("networks", "security", "compute"…), then by name.
//   3. copy edit = on that variant's Technical Skills lines: matched skills move to the front and get
//                  bolded; matched skills it lacks (but a sibling variant lists) are added under the
//                  same-named category, else under "Other" — so every keyword the JD asked for that
//                  the user actually has is on the page, in the section ATS parsers read. Nothing
//                  else in the file changes.
import { boldTex, displayTex, findTerms, lookup, norm, vocabulary, type Term } from './keywords.ts';
import { renderSkillLine, unescapeTex, type ResumeTex, type SkillLine } from './tex.ts';

export interface TailorResult {
  readonly variant: string;
  readonly tex: string;
  /** JD keyword hits with raw counts, ranked by weight (count capped at MAX_WEIGHT), then A–Z. */
  readonly matched: readonly { term: string; count: number }[];
  /** Per-variant score, by variant name. */
  readonly scores: readonly { name: string; score: number }[];
  /** Skills injected into the chosen variant's skills block, with the category they landed in. */
  readonly added: readonly { term: string; category: string }[];
}

const FALLBACK_CATEGORY = 'Other';
/** A keyword's weight saturates: a company that names its own product 15 times (Datadog, on a
 *  Datadog JD) must not drown the three skills the role is actually about. */
const MAX_WEIGHT = 3;

export function tailor(variants: readonly ResumeTex[], jd: string): TailorResult {
  if (variants.length === 0) throw new Error('no résumé variants given');
  // Sort by name so the result never depends on the order the caller found the files in.
  const resumes = [...variants].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const terms = vocabulary(resumes);
  const hits = findTerms(normalizeJd(jd), terms);
  const weight = new Map([...hits].map(([key, count]) => [key, Math.min(count, MAX_WEIGHT)]));
  const byKey = new Map(terms.map((t) => [t.key, t]));

  const jdWords = words(normalizeJd(jd));
  const scores = resumes.map((r) => {
    const body = findTerms(r.plain, terms);
    const head = findTerms(r.headline, terms);
    let score = 0;
    for (const [key, w] of weight) score += (body.has(key) ? w : 0) + (head.has(key) ? w : 0);
    const overlap = [...jdWords].filter((w) => words(r.plain).has(w)).length;
    return { name: r.name, score, overlap };
  });
  const best = scores.reduce((b, s, i) => (s.score > scores[b]!.score || (s.score === scores[b]!.score && s.overlap > scores[b]!.overlap) ? i : b), 0);
  const chosen = resumes[best]!;

  const ranked = [...hits]
    .sort((a, b) => weight.get(b[0])! - weight.get(a[0])! || (a[0] < b[0] ? -1 : 1))
    .map(([key, count]) => ({ term: byKey.get(key)!, count }));
  const { tex, added } = rewriteSkills(chosen, terms, ranked.map((x) => x.term));
  return {
    variant: chosen.name,
    tex,
    matched: ranked.map((x) => ({ term: x.term.display, count: x.count })),
    scores: scores.map(({ name, score }) => ({ name, score })),
    added,
  };
}

/** Distinct lowercase words of 5+ letters — long enough to be topical ("networks"), not glue ("with"). */
function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z]{5,}/g) ?? []);
}

interface Bucket {
  readonly line: SkillLine | null; // null = the "Other" line we're creating
  readonly category: string; // as authored (escaped)
  readonly matched: string[]; // tex items, JD-matched, in authored order
  readonly added: string[]; // tex items imported from siblings
  readonly rest: string[]; // tex items, untouched
}

function rewriteSkills(r: ResumeTex, terms: readonly Term[], wanted: readonly Term[]): Pick<TailorResult, 'tex' | 'added'> {
  if (r.skills.length === 0 || wanted.length === 0) return { tex: r.source, added: [] };
  const wantedKeys = new Set(wanted.map((t) => t.key));
  const have = new Set<string>();

  const buckets: Bucket[] = r.skills.map((line) => {
    const b: Bucket = { line, category: line.category, matched: [], added: [], rest: [] };
    for (const item of line.items) {
      const term = lookup(terms, item.text);
      if (term) have.add(term.key);
      if (term && wantedKeys.has(term.key)) b.matched.push(item.bold ? item.raw : boldTex(item.raw));
      else b.rest.push(item.raw);
    }
    return b;
  });

  const added: { term: string; category: string }[] = [];
  for (const t of wanted) {
    if (have.has(t.key)) continue;
    const bucket = buckets.find((b) => norm(b.category) === norm(t.category)) ?? otherBucket(buckets);
    bucket.added.push(displayTex(t));
    have.add(t.key);
    added.push({ term: t.display, category: unescapeTex(bucket.category) });
  }

  const lines = r.source.split('\n');
  const last = r.skills[r.skills.length - 1]!;
  const extra: string[] = [];
  for (const b of buckets) {
    const items = [...b.matched, ...b.added, ...b.rest];
    if (b.line) lines[b.line.line] = renderSkillLine(b.line, items);
    else extra.push(renderSkillLine({ ...last, category: b.category }, items));
  }
  // A last line authored without "\\" must get one once something follows it, or both render as one row.
  if (extra.length > 0 && !last.trail.includes('\\\\')) lines[last.line] = lines[last.line]!.replace(/\r?$/, (cr) => ` \\\\${cr}`);
  lines.splice(last.line + 1, 0, ...extra);
  return { tex: lines.join('\n'), added };
}

function otherBucket(buckets: Bucket[]): Bucket {
  const existing = buckets.find((b) => norm(b.category) === norm(FALLBACK_CATEGORY));
  if (existing) return existing;
  const b: Bucket = { line: null, category: FALLBACK_CATEGORY, matched: [], added: [], rest: [] };
  buckets.push(b);
  return b;
}

/** JDs arrive as pasted text or scraped HTML (sometimes entity-encoded twice). Make either plain prose. */
export function normalizeJd(jd: string): string {
  let s = jd;
  for (let i = 0; i < 3 && /&(amp|nbsp|#\d+|#x[0-9a-f]+|quot|lt|gt);/i.test(s); i++) {
    s = s
      .replace(/&nbsp;/g, ' ')
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#(\d+|x[0-9a-f]+);/gi, (_, n: string) => codePoint(n))
      .replace(/&amp;/g, '&');
  }
  // Tags only — "<5 years" or "a < b" in a pasted JD must survive.
  return s.replace(/<\/?[a-z!][^>]*>/gi, ' ').replace(/\s+/g, ' ').trim();
}

function codePoint(n: string): string {
  const cp = /^x/i.test(n) ? parseInt(n.slice(1), 16) : Number(n);
  return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ' ';
}

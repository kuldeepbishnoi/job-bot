// Read a résumé .tex variant (the user's Overleaf source) into plain data. Pure: string in, data out.
//
// The only structure we rely on is the Technical Skills block, which in the template looks like:
//
//   \section{Technical Skills}
//    \begin{itemize}[leftmargin=0.15in, label={}]
//       \small{\item{
//        \textbf{Languages}{: \textbf{Go}, \textbf{Java}, Python, SQL} \\
//        \textbf{Databases}{: MySQL, Redis} \\
//       }}
//    \end{itemize}
//
// Everything else in the file is opaque text we carry through untouched.

/** One comma-separated entry on a skills line, e.g. `\textbf{Go}` or `Playwright (Familiar)`. */
export interface SkillItem {
  readonly raw: string; // exactly as authored (so an untouched item round-trips byte-for-byte)
  readonly text: string; // raw without the \textbf wrapper, `\&` unescaped: "Playwright (Familiar)"
  readonly bold: boolean;
}

/** One `\textbf{Category}{: items} \\` line. */
export interface SkillLine {
  readonly line: number; // 0-based index into source.split('\n')
  readonly indent: string;
  readonly category: string; // as authored, e.g. "Backend \& Messaging"
  readonly items: readonly SkillItem[];
  readonly trail: string; // what followed the closing brace, normally " \\\\"
}

export interface ResumeTex {
  readonly name: string; // file stem, e.g. "backend_systems"
  readonly source: string;
  readonly skills: readonly SkillLine[];
  /** Body text with LaTeX markup stripped — what a keyword search runs against. */
  readonly plain: string;
  /** The header block (name + tagline), stripped — the variant's declared focus. */
  readonly headline: string;
}

const SKILL_LINE = /^(\s*)\\textbf\{(.+?)\}\{:\s*(.*?)\}(\s*(?:\\\\)?\s*)$/; // trail keeps a CRLF's "\r" too

export function parseResumeTex(name: string, source: string): ResumeTex {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => /\\section\{[^}]*skills[^}]*\}/i.test(l));
  const skills: SkillLine[] = [];
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (/\\end\{itemize\}/.test(line)) break;
      const m = SKILL_LINE.exec(line);
      if (m) skills.push({ line: i, indent: m[1]!, category: m[2]!, items: splitItems(m[3]!).map(parseItem), trail: m[4]! });
    }
    // A skills section we can't read would silently drop every keyword this variant claims.
    if (skills.length === 0) throw new Error(`${name}.tex: found a Skills section but no "\\textbf{Category}{: a, b} \\\\" lines in it`);
  }
  return { name, source, skills, plain: stripLatex(source), headline: stripLatex(headerBlock(source)) };
}

/** Split on top-level commas only — never inside `{}` or `()`. */
export function splitItems(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '{' || ch === '(') depth++;
    else if (ch === '}' || ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function parseItem(raw: string): SkillItem {
  const bold = raw.startsWith('\\textbf{');
  const text = unescapeTex(bold ? raw.replace(/^\\textbf\{/, '').replace(/\}(?=[^}]*$)/, '') : raw);
  return { raw, text, bold };
}

/** Render a skills line back to LaTeX in the template's exact shape. */
export function renderSkillLine(shape: Pick<SkillLine, 'indent' | 'category' | 'trail'>, items: readonly string[]): string {
  return `${shape.indent}\\textbf{${shape.category}}{: ${items.join(', ')}}${shape.trail}`;
}

export function unescapeTex(s: string): string {
  return s.replace(/\\([&%$#_])/g, '$1');
}

export function escapeTex(s: string): string {
  return s.replace(/([&%$#_])/g, '\\$1');
}

/** The `\begin{center} … \end{center}` block that opens the document (name, tagline, links). */
function headerBlock(source: string): string {
  const m = /\\begin\{center\}([\s\S]*?)\\end\{center\}/.exec(source);
  return m ? `\\begin{document}${m[1]}` : '';
}

/** Body text with comments, commands, and braces removed. Good enough for keyword presence. */
export function stripLatex(source: string): string {
  const body = source.split(/\\begin\{document\}/)[1] ?? source;
  return unescapeTex(
    body
      .replace(/(^|[^\\])%.*$/gm, '$1') // comments (but not `\%`)
      .replace(/\\href\{[^}]*\}/g, '') // drop link targets, keep link text
      .replace(/\\[A-Za-z]+\*?(\[[^\]]*\])?/g, ' '), // \command[opt]
  )
    .replace(/[{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

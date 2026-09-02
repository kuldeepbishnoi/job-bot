import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseResumeTex, splitItems, stripLatex } from '@/resume/tex';
import { boldTex, findTerms, lookup, vocabulary } from '@/resume/keywords';
import { normalizeJd, tailor } from '@/resume/tailor';

const load = (name: string) => parseResumeTex(name, readFileSync(`fixtures/resume/${name}.tex`, 'utf8'));
const backend = load('backend');
const platform = load('platform');
const variants = [backend, platform];
const terms = vocabulary(variants);

const skillsBlock = (tex: string) => tex.split('\n').filter((l) => /^\s*\\textbf\{[^}]+\}\{:/.test(l));

describe('parseResumeTex', () => {
  it('reads every Technical Skills line with category, items and bold', () => {
    expect(backend.skills.map((s) => s.category)).toEqual(['Languages', 'Backend \\& Messaging', 'Databases', 'Infrastructure', 'Other']);
    const langs = backend.skills[0]!;
    expect(langs.items.map((i) => i.text)).toEqual(['Go', 'Java', 'Python', 'C++', 'SQL']);
    expect(langs.items.map((i) => i.bold)).toEqual([true, true, false, false, false]);
    expect(langs.trail).toBe(' \\\\');
  });

  it('keeps parenthetical qualifiers and partial-bold items intact', () => {
    const other = backend.skills[4]!;
    expect(other.items.map((i) => i.text)).toEqual(['Git', 'Data Structures & Algorithms', 'System Design (HLD/LLD)']);
    const cicd = platform.skills[3]!;
    expect(cicd.items[1]).toEqual({ raw: '\\textbf{LaunchDarkly} (Feature Flags)', text: 'LaunchDarkly (Feature Flags)', bold: true });
  });

  it('accepts a skills line without a trailing \\\\ and keeps it that way', () => {
    const src = '\\section{Technical Skills}\n\\textbf{Languages}{: Go, Java}\n\\end{itemize}';
    const r = parseResumeTex('x', src);
    expect(r.skills[0]?.trail).toBe('');
    expect(tailor([r], 'Java').tex).toBe('\\section{Technical Skills}\n\\textbf{Languages}{: \\textbf{Java}, Go}\n\\end{itemize}');
    // CRLF + no trailing \\: exactly one \r survives.
    const crlf = parseResumeTex('x', src.replace(/\n/g, '\r\n'));
    expect(crlf.skills[0]?.trail).toBe('\r');
    expect(tailor([crlf], 'Java').tex).toBe('\\section{Technical Skills}\r\n\\textbf{Languages}{: \\textbf{Java}, Go}\r\n\\end{itemize}');
    // …but once an "Other" line follows it, it needs a line break or both render on one row.
    const zig = parseResumeTex('zig', src.replace('Go, Java', 'Go, Java, Zig'));
    expect(tailor([zig, backend], 'Zig, Zig, Zig and Kafka').tex).toBe(
      '\\section{Technical Skills}\n\\textbf{Languages}{: \\textbf{Zig}, Go, Java} \\\\\n\\textbf{Other}{: \\textbf{Apache Kafka}}\n\\end{itemize}',
    );
  });

  it('refuses a Skills section it cannot read instead of silently matching nothing', () => {
    expect(() => parseResumeTex('x', '\\section{Technical Skills}\n\\textbf{Languages:} Go, Java \\\\\n\\end{itemize}')).toThrow(/x\.tex: found a Skills section/);
    expect(parseResumeTex('x', '\\section{Experience}\nnothing').skills).toEqual([]); // no section at all is fine
  });

  it('splits on top-level commas only', () => {
    expect(splitItems('A, \\textbf{B, C}, D (x, y), E')).toEqual(['A', '\\textbf{B, C}', 'D (x, y)', 'E']);
  });

  it('strips markup for plain-text keyword search', () => {
    expect(stripLatex('\\begin{document}\\resumeItem{Moved to \\textbf{Apache Kafka} \\& \\href{https://x.y}{gRPC} % note\n}')).toBe(
      'Moved to Apache Kafka & gRPC',
    );
  });
});

describe('vocabulary', () => {
  it('is the union of every variant’s skills, merged by alias', () => {
    expect(lookup(terms, 'Go')).toBeDefined();
    expect(lookup(terms, 'Terraform')).toBeDefined();
    // "GCP" (backend) and "Google Cloud Platform (GCP)" (platform) are one term, longest spelling kept.
    expect(lookup(terms, 'GCP')).toBe(lookup(terms, 'Google Cloud Platform (GCP)'));
    expect(lookup(terms, 'GCP')?.display).toBe('Google Cloud Platform (GCP)');
  });

  it('remembers which category a skill was listed under', () => {
    expect(lookup(terms, 'Terraform')?.category).toBe('CI/CD & DevOps');
    expect(lookup(terms, 'Kafka')?.category).toBe('Backend & Messaging');
  });
});

describe('findTerms', () => {
  const hit = (text: string) => [...findTerms(text, terms).keys()];

  it('is word-bounded and case-aware for two-letter/ALL-CAPS names', () => {
    expect(hit('Experience with Go and Java.')).toEqual(expect.arrayContaining(['go', 'java']));
    expect(hit('go to market with javascript')).not.toContain('go');
    expect(hit('go to market with javascript')).not.toContain('java');
    expect(hit('the rest of the team')).not.toContain('rest apis');
    expect(hit('build REST APIs')).toContain('rest apis');
    expect(hit('C++ or Rust')).toContain('c++');
    expect(hit('experience with git and helm')).toEqual(expect.arrayContaining(['git', 'helm']));
  });

  it('understands common aliases, acronyms, plurals and "&" vs "and"', () => {
    expect(hit('Golang services on k8s')).toEqual(expect.arrayContaining(['go', 'kubernetes']));
    expect(hit('deploy to GKE')).toContain('google kubernetes engine');
    expect(hit('one microservice')).toContain('microservices');
    expect(hit('Kafka streams')).toContain('apache kafka');
    expect(hit('Github actions workflows')).toContain('github actions');
    expect(hit('strong data structures & algorithms')).toContain('data structures and algorithms');
    expect(hit('strong data structures and algorithms')).toContain('data structures and algorithms');
  });

  it('counts each mention once even when spellings overlap', () => {
    expect(findTerms('Go, Go, and more Go', terms).get('go')).toBe(3);
    expect(findTerms('Apache Kafka', terms).get('apache kafka')).toBe(1); // not "Apache Kafka" + "Kafka"
    expect(findTerms('Kafka and Apache Kafka', terms).get('apache kafka')).toBe(2);
  });

  it('never stems a single word, and ignores qualifiers that only look like acronyms', () => {
    const r = parseResumeTex('x', [
      '\\section{Skills}',
      '\\textbf{Web}{: Rails, Windows, Rust (Basics), React (2020), Node, Node.js, Kubernetes (K8s)} \\\\',
      '\\end{itemize}',
    ].join('\n'));
    const t = vocabulary([r]);
    const keys = (text: string) => [...findTerms(text, t).keys()];
    expect(keys('rail transport through a window')).toEqual([]);
    expect(keys('Rails and Windows')).toEqual(['rails', 'windows']);
    expect(keys('basic understanding, since 2020')).toEqual([]);
    expect(keys('Node.js developer')).toEqual(['node.js']); // "Node" does not match inside "Node.js"
    expect(keys('on K8S')).toEqual(['kubernetes']);
  });

  it('folds two earlier terms into one when a later skill bridges them', () => {
    const mk = (name: string, items: string) =>
      parseResumeTex(name, `\\section{Skills}\n\\textbf{Cloud}{: ${items}} \\\\\n\\end{itemize}`);
    const t = vocabulary([mk('a', 'GCP'), mk('b', 'Google Cloud'), mk('c', 'Google Cloud Platform (GCP)')]);
    expect(t).toHaveLength(1);
    expect(t[0]?.display).toBe('Google Cloud Platform (GCP)');
    expect(findTerms('GCP or Google Cloud', t).get(t[0]!.key)).toBe(2);
  });

  it('matches the canonical spelling when the résumé lists the alias, and vice versa', () => {
    const r = parseResumeTex('x', '\\section{Skills}\n\\textbf{Stack}{: Postgres, Golang, K8s, Mongo, R, React, Node} \\\\\n\\end{itemize}');
    const t = vocabulary([r]);
    const keys = (text: string) => [...findTerms(text, t).keys()].sort();
    expect(keys('PostgreSQL, Go, Kubernetes and MongoDB')).toEqual(['golang', 'k8s', 'mongo', 'postgres']);
    // No blanket plural: "R" is not "Rs", "React" is not "reacts", "Node" is not "nodes".
    expect(keys('CTC Rs 25 LPA; a team that reacts fast on Cassandra nodes')).toEqual([]);
  });

  it('matches either half of a slash compound', () => {
    const r = parseResumeTex('x', '\\section{Skills}\n\\textbf{Languages}{: C/C++, HTML/CSS, JA3/TLS Fingerprint Spoofing} \\\\\n\\end{itemize}');
    const t = vocabulary([r]);
    expect([...findTerms('C++ and CSS', t).keys()]).toEqual(['c/c++', 'html/css']);
    expect([...findTerms('TLS handshakes', t).keys()]).toEqual([]); // multi-word: no split
  });

  it('never lets a hedge like "(Basics)" become the canonical spelling', () => {
    const mk = (name: string, items: string) =>
      parseResumeTex(name, `\\section{Skills}\n\\textbf{Languages}{: ${items}} \\\\\n\\end{itemize}`);
    const t = vocabulary([mk('a', 'Python'), mk('b', 'Python (Basics)'), mk('c', 'Rust')]);
    expect(lookup(t, 'Python')?.display).toBe('Python');
    expect(tailor([mk('a', 'Python'), mk('b', 'Python (Basics)'), mk('c', 'Rust')], 'Rust, Rust and Python').added).toEqual([
      { term: 'Python', category: 'Languages' },
    ]);
  });

  it('boldTex bolds the name, not the qualifier', () => {
    expect(boldTex('Terraform (Familiar)')).toBe('\\textbf{Terraform} (Familiar)');
    expect(boldTex('Go')).toBe('\\textbf{Go}');
  });
});

describe('tailor', () => {
  const k8sJd = `Platform Engineer. You will run Kubernetes clusters on GKE, write Terraform,
    and own CI/CD with GitHub Actions. Bonus: Go, gRPC and Kafka experience.`;
  const goJd = `Backend Engineer. Go, gRPC, Kafka, distributed systems, MySQL. REST APIs.`;

  it('picks the variant that already speaks the JD’s language', () => {
    expect(tailor(variants, k8sJd).variant).toBe('platform');
    expect(tailor(variants, goJd).variant).toBe('backend');
  });

  it('moves matched skills first, bolds them, and imports missing ones from a sibling variant', () => {
    const r = tailor(variants, k8sJd);
    const lines = skillsBlock(r.tex);
    // Matched items (GitHub Actions, Terraform) move to the front, bolded, keeping their authored order.
    expect(lines[3]).toBe(
      '     \\textbf{CI/CD \\& DevOps}{: \\textbf{GitHub Actions}, \\textbf{Terraform} (Familiar), \\textbf{LaunchDarkly} (Feature Flags), Canary Deployments} \\\\',
    );
    // Kubernetes was already first+bold; GKE bolded and moved ahead of Docker.
    expect(lines[0]).toBe(
      '     \\textbf{Container Orchestration}{: \\textbf{Kubernetes}, \\textbf{Google Kubernetes Engine} (GKE), \\textbf{Docker}, Helm} \\\\',
    );
    // gRPC/Kafka aren't on the platform variant and it has no "Backend & Messaging" category →
    // they land on a single new "Other" line (JD-frequency order, then A–Z).
    expect(lines[lines.length - 1]).toBe('     \\textbf{Other}{: \\textbf{Apache Kafka}, \\textbf{gRPC}} \\\\');
    expect(lines).toHaveLength(platform.skills.length + 1);
    expect(r.added).toEqual([
      { term: 'Apache Kafka', category: 'Other' },
      { term: 'gRPC', category: 'Other' },
    ]);
  });

  it('imports into the same-named category when the chosen variant has it', () => {
    const r = tailor(variants, 'Go engineer who knows Docker and Redis.');
    expect(r.variant).toBe('backend');
    expect(r.added).toEqual([]); // backend lists all three already
    // Prometheus is listed under "Observability & Monitoring" on platform; backend has no such
    // category but does have "Other" → reuse it, right after the matched block.
    const r2 = tailor(variants, 'Go, Java, gRPC and Prometheus.');
    expect(r2.variant).toBe('backend');
    expect(r2.added).toEqual([{ term: 'Prometheus', category: 'Other' }]);
    const lines = skillsBlock(r2.tex);
    expect(lines).toHaveLength(backend.skills.length); // no new line needed
    expect(lines[4]).toBe('     \\textbf{Other}{: \\textbf{Prometheus}, Git, Data Structures \\& Algorithms, System Design (HLD/LLD)} \\\\');
  });

  it('breaks a tie in favour of the variant whose headline names the keyword', () => {
    // Both variants list Docker under skills; only the platform headline says "Docker".
    expect(tailor(variants, 'Docker').scores).toEqual([
      { name: 'backend', score: 1 },
      { name: 'platform', score: 2 },
    ]);
    expect(tailor(variants, 'Docker').variant).toBe('platform');
  });

  it('caps how much a repeated keyword can weigh', () => {
    // Docker is on both variants and in the platform headline. Repeating it 20× must not outweigh
    // the four backend skills the JD is actually about (uncapped: platform 41 vs backend 26).
    const r = tailor(variants, `${'Docker '.repeat(20)} Go gRPC Kafka distributed systems`);
    expect(r.variant).toBe('backend');
    expect(r.matched[0]).toEqual({ term: 'Docker', count: 20 }); // raw count still reported
    expect(r.scores).toEqual([
      { name: 'backend', score: 3 + 2 + 1 + 1 + 2 }, // Docker capped at 3; Go + Distributed Systems also in the headline
      { name: 'platform', score: 3 + 3 + 1 }, // Docker body + headline, Go
    ]);
  });

  it('settles a dead heat by plain word overlap with the variant’s prose', () => {
    // Neither variant lists "Helm" alone as a differentiator here: Redis is on both. What differs is
    // that only the platform bullets talk about incidents, metrics and charts.
    const r = tailor(variants, 'Redis. You will own incident detection, metrics dashboards and charts.');
    expect(r.scores.map((s) => s.score)).toEqual([1, 1]);
    expect(r.variant).toBe('platform');
    expect(tailor(variants, 'Redis. Billing and notification flows across orders.').variant).toBe('backend');
  });

  it('changes nothing outside the skills lines', () => {
    const r = tailor(variants, k8sJd);
    const before = platform.source.split('\n');
    const after = r.tex.split('\n');
    const first = platform.skills[0]!.line;
    const last = platform.skills.at(-1)!.line;
    expect(after.slice(0, first)).toEqual(before.slice(0, first));
    expect(after.slice(after.length - (before.length - last - 1))).toEqual(before.slice(last + 1));
  });

  it('with no keyword hits, returns the first variant byte-for-byte', () => {
    const r = tailor(variants, 'We are hiring a florist.');
    expect(r.variant).toBe('backend');
    expect(r.matched).toEqual([]);
    expect(r.added).toEqual([]);
    expect(r.tex).toBe(backend.source);
  });

  it('keeps CRLF line endings consistent when the source uses them', () => {
    const crlf = parseResumeTex('platform', platform.source.replace(/\n/g, '\r\n'));
    const out = tailor([backend, crlf], k8sJd).tex;
    expect(out.split('\r\n')).toHaveLength(platform.source.split('\n').length + 1); // + the "Other" line
    expect(out.split('\n').every((l, i, a) => i === a.length - 1 || l.endsWith('\r'))).toBe(true);
  });

  it('does not depend on the order the variants were given in', () => {
    expect(tailor([platform, backend], k8sJd)).toEqual(tailor([backend, platform], k8sJd));
    expect(tailor([platform, backend], 'florist').tex).toBe(backend.source);
  });

  it('handles a real scraped JD (HTML-entity soup from the Typesense fixture)', () => {
    const doc = JSON.parse(readFileSync('fixtures/typesense-response.json', 'utf8'))
      .results.flatMap((r: { hits: { document: { job_id: string; description: string } }[] }) => r.hits)
      .map((h: { document: { job_id: string; description: string } }) => h.document)
      .find((d: { job_id: string }) => String(d.job_id) === '8050874');
    expect(normalizeJd(doc.description)).toContain("Datadog's Application Performance Monitoring");
    const r = tailor(variants, doc.description);
    expect(r.variant).toBe('platform');
    expect(r.matched.map((m) => m.term)).toEqual(expect.arrayContaining(['AWS', 'Azure', 'Google Cloud Platform (GCP)', 'Datadog']));
  });

  it('rejects an empty variant list', () => {
    expect(() => tailor([], 'x')).toThrow();
  });
});

describe('normalizeJd', () => {
  it('strips tags and decodes (double-)encoded entities', () => {
    expect(normalizeJd('<p>Data &amp;amp; ML&amp;nbsp;team &amp;#39;24</p>')).toBe("Data & ML team '24");
    expect(normalizeJd('&lt;ul&gt;&lt;li&gt;Go&lt;/li&gt;&lt;/ul&gt;')).toBe('Go');
  });

  it('keeps "<" and ">" that are not tags, and survives malformed entities', () => {
    expect(normalizeJd('must have <5 years, salary 10 -> 20 LPA, C++ > Java. Redis required.')).toBe(
      'must have <5 years, salary 10 -> 20 LPA, C++ > Java. Redis required.',
    );
    expect(normalizeJd('a &#face; b &#1114112; c &#x110000; d &#x41;')).toBe('a &#face; b c d A');
  });
});

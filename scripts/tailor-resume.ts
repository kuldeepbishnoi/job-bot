#!/usr/bin/env node
// CLI: a job description in → the tailored résumé PDF (and its .tex, for Overleaf) out.
// This is the "Main" for the pure `src/resume/` module: file I/O and the pdflatex process live here.
//
//   npm run tailor -- --jd jd.txt                      # variants from profile/resume/*.tex → profile/resume/out/tailored.{tex,pdf}
//   pbpaste | node scripts/tailor-resume.ts --jd - --name datadog-sde --json
//
// Other bots call this with `--json` and read `tex`/`pdf` paths from stdout. Invoke the script
// directly (or `npm run --silent tailor`) for that — plain `npm run` prints its banner to stdout.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseResumeTex } from '../src/resume/tex.ts';
import { tailor } from '../src/resume/tailor.ts';

const USAGE = `usage: tailor-resume --jd <file|-> [--resumes <dir>] [--out <dir>] [--name <stem>] [--json] [--no-pdf]
  --jd       job description text file, or "-" for stdin (required)
  --resumes  folder of .tex variants          (default: profile/resume)
  --out      where to write <name>.tex/.pdf   (default: <resumes>/out)
  --name     output file stem                 (default: tailored)
  --json     print machine-readable result
  --no-pdf   write only the .tex (otherwise pdflatex is required)`;

interface Args {
  jd: string;
  resumes: string;
  out: string;
  name: string;
  json: boolean;
  pdf: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { jd: '', resumes: 'profile/resume', out: '', name: 'tailored', json: false, pdf: true };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) fail(`${flag} needs a value`);
      return v;
    };
    if (flag === '--jd') a.jd = next();
    else if (flag === '--resumes') a.resumes = next();
    else if (flag === '--out') a.out = next();
    else if (flag === '--name') a.name = next();
    else if (flag === '--json') a.json = true;
    else if (flag === '--no-pdf') a.pdf = false;
    else if (flag === '-h' || flag === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else fail(`unknown flag ${flag}`);
  }
  if (!a.jd) fail('--jd is required');
  if (!/^[A-Za-z0-9._-]+$/.test(a.name)) fail('--name must be a plain file stem');
  a.out ||= join(a.resumes, 'out');
  return a;
}

function readJd(path: string): string {
  try {
    return readFileSync(path === '-' ? 0 : path, 'utf8');
  } catch (e) {
    return fail(`cannot read ${path}: ${(e as Error).message}`);
  }
}

function fail(msg: string): never {
  console.error(`tailor-resume: ${msg}\n\n${USAGE}`);
  process.exit(1);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const jd = readJd(args.jd);
  if (!jd.trim()) fail('the job description is empty');

  const dir = resolve(args.resumes);
  if (resolve(args.out) === dir) fail('--out must not be the variants folder itself (the output would be read as a variant next run)');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.tex')) : [];
  if (files.length === 0) fail(`no .tex variants in ${dir} — copy your Overleaf sources there`);
  const resumes = files.map((f) => parseResumeTex(basename(f, '.tex'), readFileSync(join(dir, f), 'utf8')));

  const result = tailor(resumes, jd);
  mkdirSync(args.out, { recursive: true });
  const texPath = join(args.out, `${args.name}.tex`);
  writeFileSync(texPath, result.tex);

  const pdf = args.pdf ? compile(texPath, args.out) : { status: 'skipped' as const };
  if (pdf.status === 'missing') fail('pdflatex not found — install it (macOS: `brew install --cask basictex`, then reopen the terminal) or pass --no-pdf for the .tex only');
  const out = {
    variant: result.variant,
    tex: texPath,
    pdf: pdf.status === 'ok' ? pdf.path : null,
    pages: pdf.status === 'ok' ? pdf.pages : null,
    pdfStatus: pdf.status,
    pdfLog: pdf.status === 'failed' ? pdf.log : null,
    matched: result.matched,
    added: result.added,
    scores: result.scores,
  };
  if (args.json) console.log(JSON.stringify(out, null, 2));
  else {
    const scores = result.scores.map((s) => `${s.name} ${s.score}`).join(' · ');
    console.log(`variant   ${result.variant}   (${scores})`);
    console.log(`matched   ${result.matched.map((m) => `${m.term} ×${m.count}`).join(', ') || '(no keywords found — first variant used as-is)'}`);
    console.log(`added     ${result.added.map((a) => `${a.term} → ${a.category}`).join(', ') || '(nothing)'}`);
    if (pdf.status === 'ok') console.log(`pdf       ${pdf.path} (${pdf.pages} page${pdf.pages === 1 ? '' : 's'}${pdf.pages > 1 ? ' — over one page, trim before sending' : ''})`);
    else if (pdf.status === 'failed') console.log(`pdf       compile failed — see ${pdf.log}`);
    console.log(`tex       ${texPath}${pdf.status === 'skipped' ? '   (paste into Overleaf)' : ''}`);
  }
  if (pdf.status === 'failed') process.exit(2);
}

type Compiled =
  | { status: 'ok'; path: string; pages: number }
  | { status: 'missing' }
  | { status: 'failed'; log: string }
  | { status: 'skipped' };

// PATH first; then where MacTeX/BasicTeX and TinyTeX install when the shell hasn't picked them up.
const PDFLATEX_CANDIDATES = ['pdflatex', '/Library/TeX/texbin/pdflatex', join(homedir(), 'Library/TinyTeX/bin/universal-darwin/pdflatex')];

function compile(texPath: string, outDir: string): Compiled {
  const bin = PDFLATEX_CANDIDATES.find((b) => spawnSync(b, ['--version']).status === 0);
  if (!bin) return { status: 'missing' };
  const args = ['-interaction=nonstopmode', '-halt-on-error', '-output-directory', outDir, texPath];
  // Two passes: hyperref/fancyhdr write auxiliary data on the first run that the second one uses.
  let r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.status === 0) r = spawnSync(bin, args, { encoding: 'utf8' });
  const stem = basename(texPath, '.tex');
  const log = join(outDir, `${stem}.log`);
  // pdflatex hard-wraps its output at 79 columns (mid-token, no marker) — unwrap before parsing.
  const pages = Number(/\((\d+) pages?, \d+ bytes\)/.exec((r.stdout ?? '').replace(/\r?\n/g, ''))?.[1] ?? 0);
  if (r.status !== 0 || pages === 0) return { status: 'failed', log };
  for (const ext of ['aux', 'log', 'out']) rmSync(join(outDir, `${stem}.${ext}`), { force: true });
  return { status: 'ok', path: join(outDir, `${stem}.pdf`), pages };
}

try {
  main();
} catch (e) {
  fail((e as Error).message); // unreadable file, a directory named *.tex, …
}

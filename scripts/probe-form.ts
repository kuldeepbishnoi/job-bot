#!/usr/bin/env node
// CLI: a live apply URL in → what the bot would actually do with that form out.
//
//   npm run probe -- https://jobs.lever.co/anchorage/09b2b0d1-.../apply
//   npm run probe -- <url> --save fixtures/lever-apply-anchorage.html
//
// Why this exists: a report that "the form did not fill" is not evidence, and a theory about the
// DOM is not either — a guess that happens to look right gets a working path "fixed". This fetches
// the real page and runs the REAL pipeline over it (adapter extract → matcher → resolver, with the
// owner's own profile), printing every field, the options it offers, and the answer we would put
// in. An `unknown` on a required row is the bug, named, before a line of adapter code is touched.
//
// Server-rendered boards only (Lever, Greenhouse hosted): one GET is the whole form. A React board
// that assembles itself client-side (Ashby, Workday, LinkedIn) needs a real browser — use
// `npm run mitm -- <url>` and capture from there, then pass --file to read what it dumped.
import { readFileSync, writeFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { parse as parseYaml } from 'yaml';
import { parseProfile } from '../src/config/schema.ts';
import { withIntent } from '../src/engine/matcher.ts';
import { resolve as resolveAnswer, guessAnswer } from '../src/engine/resolver.ts';
import type { Field, Job } from '../src/engine/types.ts';

interface Adapter {
  readonly extract: (doc: Document) => Field[];
  readonly optionsFor: (doc: Document, f: Field) => string[];
}

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const target = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true);
const fromFile = flag('--file');
if (!target && !fromFile) {
  console.error('usage: npm run probe -- <apply-url> [--save <path>] [--as lever|greenhouse] [--file <html>]');
  process.exit(2);
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const html = fromFile
  ? readFileSync(fromFile, 'utf8')
  : await (async () => {
      const res = await fetch(target!, { headers: { 'user-agent': UA } });
      if (!res.ok) throw new Error(`GET ${target} -> ${res.status}`);
      return res.text();
    })();

const save = flag('--save');
if (save) {
  writeFileSync(save, html);
  console.log(`saved ${html.length} bytes -> ${save}`);
}

// Styles and scripts only slow the parse down; every adapter reads structure, never CSS.
const window = new Window({ url: target ?? 'https://example.invalid/' });
// The adapters test nodes with bare `instanceof HTMLInputElement`, the way they do inside a page.
// Publish this window's constructors as globals BEFORE importing them, or every such test throws.
for (const k of Object.getOwnPropertyNames(window)) {
  if (/^(HTML|SVG)|^(Element|Node|Document|DocumentFragment|Event|KeyboardEvent|MouseEvent|InputEvent|DataTransfer|File|FileList|DOMParser|NodeFilter|CustomEvent)$/.test(k) && !(k in globalThis)) {
    (globalThis as Record<string, unknown>)[k] = (window as unknown as Record<string, unknown>)[k];
  }
}
const ADAPTERS: readonly { readonly host: RegExp; readonly name: string; readonly a: Adapter }[] = [
  { host: /jobs\.lever\.co/i, name: 'lever', a: (await import('../src/ats/lever.ts')) as unknown as Adapter },
  { host: /greenhouse\.io/i, name: 'greenhouse', a: (await import('../src/ats/greenhouse.ts')) as unknown as Adapter },
];
const which = flag('--as') ?? ADAPTERS.find((x) => x.host.test(target ?? ''))?.name;
const chosen = ADAPTERS.find((x) => x.name === which);
if (!chosen) throw new Error(`no adapter for ${target ?? fromFile} — pass --as lever|greenhouse`);
window.document.write(
  html.replace(/<link\b[^>]*>/gi, '').replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, ''),
);
const doc = window.document as unknown as Document;

const profile = parseProfile(parseYaml(readFileSync('profile/profile.yaml', 'utf8')));
// The job only feeds location-shaped answers; its title is what the JD-derived ones would use.
const job: Job = { id: 'probe', title: doc.querySelector('h2')?.textContent?.trim() ?? '', team: '', department: '', url: target ?? '', locations: [doc.querySelector('.location')?.textContent?.trim() ?? ''].filter(Boolean), seniority: [] };

const fields = chosen.a.extract(doc).map(withIntent);
const rows = fields.map((f) => {
  const options = chosen.a.optionsFor(doc, f);
  let answer;
  try {
    answer = resolveAnswer(f, profile, job, options);
  } catch (e) {
    answer = { kind: 'threw', value: (e as Error).message } as never;
  }
  const guessed = answer.kind === 'unknown' && profile.on_unknown === 'guess' ? guessAnswer(f, options, profile) : null;
  return { f, options, answer, guessed };
});

const show = (r: (typeof rows)[number]): string => {
  const a = r.guessed ?? r.answer;
  const via = r.guessed ? ' (GUESS)' : '';
  if (a.kind === 'text') return JSON.stringify(a.value.slice(0, 70)) + via;
  if (a.kind === 'choice') return a.values.join(' + ') + via;
  if (a.kind === 'check') return String(a.value) + via;
  return a.kind + via;
};

console.log(`\n${chosen.name}: ${fields.length} fields — ${job.title}\n`);
for (const r of rows) {
  const mark = r.answer.kind === 'unknown' && !r.guessed ? (r.f.required ? '!!' : '  ') : '  ';
  console.log(`${mark} ${r.f.required ? '*' : ' '} ${r.f.label.slice(0, 62).padEnd(62)} ${(r.f.intent ?? '-').padEnd(30)} ${show(r)}`);
  if (r.options.length) console.log(`        options: ${r.options.join(' | ').slice(0, 150)}`);
}

// The exit code is the point: a required question we cannot answer is a failure, not a printout.
const blocked = rows.filter((r) => r.f.required && r.answer.kind === 'unknown' && !r.guessed);
const guesses = rows.filter((r) => r.guessed);
console.log(`\n${rows.length} fields · ${blocked.length} required unanswered · ${guesses.length} guessed`);
for (const r of blocked) console.log(`  BLOCKED: ${r.f.label}`);
for (const r of guesses) console.log(`  GUESSED: ${r.f.label} -> ${show(r)}`);
process.exit(blocked.length ? 1 : 0);

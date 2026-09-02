import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseResumeTex } from '@/resume/tex';
import { tailor } from '@/resume/tailor';

const JD = 'Platform Engineer: Kubernetes on GKE, Terraform, GitHub Actions. Bonus: Go and gRPC.';
const hasPdflatex = spawnSync('pdflatex', ['--version']).status === 0;

let out: string;
beforeAll(() => (out = mkdtempSync(join(tmpdir(), 'tailor-'))));
afterAll(() => rmSync(out, { recursive: true, force: true }));

function run(args: string[], input?: string) {
  return spawnSync('node', ['scripts/tailor-resume.ts', ...args], { encoding: 'utf8', input });
}

describe('tailor-resume CLI', () => {
  it('writes the same .tex the pure module produces and reports it as JSON', () => {
    const r = run(['--jd', '-', '--resumes', 'fixtures/resume', '--out', out, '--name', 'job1', '--json', '--no-pdf'], JD);
    expect(r.status, r.stderr).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.variant).toBe('platform');
    expect(json.pdf).toBeNull();
    expect(json.added).toEqual([{ term: 'gRPC', category: 'Other' }]);

    const variants = ['backend', 'platform'].map((n) => parseResumeTex(n, readFileSync(`fixtures/resume/${n}.tex`, 'utf8')));
    expect(readFileSync(json.tex, 'utf8')).toBe(tailor(variants, JD).tex);
  });

  it('fails loudly on bad input instead of writing anything', () => {
    expect(run(['--jd', '-', '--resumes', 'fixtures/resume', '--out', out, '--no-pdf'], '   ').status).toBe(1);
    expect(run(['--jd', '-', '--resumes', join(out, 'nope'), '--out', out, '--no-pdf'], JD).status).toBe(1);
    expect(run(['--jd', '-', '--resumes', 'fixtures/resume', '--out', out, '--name', '../x', '--no-pdf'], JD).status).toBe(1);
    expect(run([]).status).toBe(1);
    expect(run(['--jd', '-', '--resumes', 'fixtures/resume', '--out', 'fixtures/resume', '--no-pdf'], JD).status).toBe(1);
    expect(run(['--jd', join(out, 'missing.txt'), '--resumes', 'fixtures/resume', '--out', out, '--no-pdf']).stderr).toContain('cannot read');
    expect(existsSync(join(out, 'tailored.tex'))).toBe(false);
  });

  it.skipIf(!hasPdflatex)('compiles the tailored .tex to a one-page PDF with pdflatex', () => {
    // A long name makes pdflatex wrap its "Output written on … (1 page, N bytes)" line mid-token.
    const name = 'job2-' + 'x'.repeat(60);
    const r = run(['--jd', '-', '--resumes', 'fixtures/resume', '--out', out, '--name', name, '--json'], JD);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.pages).toBe(1);
    expect(existsSync(json.pdf)).toBe(true);
    expect(existsSync(join(out, `${name}.log`))).toBe(false); // aux files cleaned up on success
  });
});

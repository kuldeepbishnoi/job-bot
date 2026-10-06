import { describe, it, expect } from 'vitest';
import { applyOne, type RunPorts } from '@/app/runner';
import { parseProfile } from '@/config/schema';
import { rawToJob } from '@/sources/greenhouse-boards';

// 420 Greenhouse jobs on 2026-10-05 failed "form frame never became ready" on the company's own
// careers page (Roblox, Elastic, Stripe, Coinbase…); Greenhouse's standalone embed serves the form.
describe('company page without a form → the Greenhouse embed', () => {
  const profile = parseProfile({ identity: { first_name: 'K', last_name: 'B', email: 'k@x.com', phone: '1', country: 'India' }, resume: 'r', auto_submit: true });
  const site = { id: 'greenhouse', label: 'Greenhouse', ats: 'greenhouse' as const, discover: async () => [] };

  it('a job on a company page carries the embed as its fallback; a hosted one does not', () => {
    const own = rawToJob('stripe', { id: 7369543, title: 'SWE', absolute_url: 'https://stripe.com/jobs/listing/x/7369543', location: { name: 'Remote' } } as never);
    expect(own.fallbackUrl).toBe('https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=7369543');
    const hosted = rawToJob('flexport', { id: 1, title: 'SWE', absolute_url: 'https://job-boards.greenhouse.io/flexport/jobs/1', location: { name: 'Remote' } } as never);
    expect(hosted.fallbackUrl).toBeUndefined();
  });

  it('applies on the fallback when the company page never shows a form', async () => {
    const opened: string[] = [];
    const ports = {
      openJob: async (url: string) => (opened.push(url), opened.length),
      seenOtps: async () => [],
      apply: async (_s: unknown, tabId: number) => {
        if (tabId === 1) throw new Error('form frame never became ready (no content script answered)');
        return { status: 'submitted' as const };
      },
      capture: async () => null,
      today: () => '2026-10-06',
    } as unknown as RunPorts;
    const job = rawToJob('stripe', { id: 7369543, title: 'SWE', absolute_url: 'https://stripe.com/jobs/listing/x/7369543', location: { name: 'Remote' } } as never);
    const rec = await applyOne(site, job, profile, { name: 'cv.pdf', type: 'application/pdf', dataBase64: '' }, ports);
    expect(rec.status).toBe('applied');
    expect(opened).toEqual([job.url, job.fallbackUrl]);
  });
});

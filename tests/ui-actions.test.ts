import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Msg } from '@/platform/messaging';
import type { SitePack } from '@/sites/packs';

// What the Start buttons actually send. A dry run is a promise to the user ("one job, filled, left
// open"), and it is kept by exactly two override fields — so they are pinned here.

const profile = { identity: {}, resume: 'r', answers: {}, overrides: {}, linkedin: { search_urls: ['https://x'] } };
const resume = { name: 'cv.pdf', type: 'application/pdf', dataUrl: 'data:,' };

vi.mock('@/platform/data/profile-store', () => ({
  resolveRunInputs: async () => ({ profile, resume, source: 'ui' }),
}));
vi.mock('@/platform/fs-config', () => ({
  readRegistry: async () => new Set(['old-job']),
  loadCredentials: async () => undefined,
}));

const { startSite, ensureScreenshots } = await import('@/ui/actions');
const { offersDryRun } = await import('@/ui/components/SiteCard');
const { controlShape } = await import('@/ui/components/FixAnswer');

const pack = (over: Partial<SitePack> = {}): SitePack => ({
  id: 'linkedin',
  label: 'LinkedIn',
  icon: '💼',
  kind: 'in-page',
  hosts: ['www.linkedin.com'],
  steps: [],
  stallMs: 1,
  deadMs: 2,
  needs: { resume: true, gmail: false, accounts: false },
  supports: { schedule: true, stop: true, resume: false, dryRun: true },
  config: { key: 'linkedin', fields: [] },
  ...over,
});

let sent: Msg[] = [];
let grant = { hosts: true, allUrls: false };

beforeEach(() => {
  sent = [];
  grant = { hosts: true, allUrls: false };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    permissions: {
      contains: async ({ origins }: { origins: string[] }) => (origins[0] === '<all_urls>' ? grant.allUrls : grant.hosts),
      request: async ({ origins }: { origins: string[] }) => {
        if (origins[0] === '<all_urls>') {
          grant.allUrls = true;
          return true;
        }
        return grant.hosts;
      },
    },
    runtime: {
      sendMessage: async (msg: Msg) => {
        sent.push(msg);
        return { ok: true };
      },
    },
  };
});

describe('startSite', () => {
  it('sends a plain LinkedIn run with no overrides', async () => {
    expect(await startSite(pack())).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ t: 'runLinkedin', profile, resume });
    expect('overrides' in sent[0]!).toBe(false);
  });

  it('turns a dry run into auto_submit off + a budget of exactly one', async () => {
    expect(await startSite(pack(), { dryRun: true })).toEqual({ ok: true });
    expect(sent[0]).toMatchObject({ t: 'runLinkedin', overrides: { autoSubmit: false, maxPerRun: 1 } });
  });

  it('asks for the screenshot permission before a LinkedIn run, and starts anyway if refused', async () => {
    await startSite(pack());
    expect(grant.allUrls).toBe(true); // captureVisibleTab refuses plain host permissions
    expect(sent).toHaveLength(1);

    grant.allUrls = false;
    (globalThis as unknown as { chrome: { permissions: { request: unknown } } }).chrome.permissions.request = async ({ origins }: { origins: string[] }) =>
      origins[0] !== '<all_urls>';
    await startSite(pack());
    expect(sent).toHaveLength(2); // declining costs screenshots, never the run
  });

  it('will not pretend to dry-run a pack that cannot', async () => {
    const res = await startSite(pack({ id: 'datadog', label: 'Datadog', kind: 'worker', config: undefined }), { dryRun: true });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/only wired for LinkedIn/);
    expect(sent).toHaveLength(0);

    const inst = await startSite(pack({ id: 'instahyre', label: 'Instahyre', config: undefined }), { dryRun: true });
    expect(inst.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('refuses to start without site access instead of failing later in the background', async () => {
    grant.hosts = false;
    const res = await startSite(pack());
    expect(res).toMatchObject({ ok: false });
    expect(sent).toHaveLength(0);
  });

  it('offers the dry run only where a form can be left open to look at', () => {
    expect(offersDryRun(pack())).toBe(true);
    expect(offersDryRun(pack({ kind: 'worker' }))).toBe(false); // a hidden worker window is not inspectable
    expect(offersDryRun(pack({ supports: { schedule: true, stop: true, resume: false, dryRun: false } }))).toBe(false);
  });

  it('ensureScreenshots is a no-op once the grant exists', async () => {
    grant.allUrls = true;
    expect(await ensureScreenshots()).toBe(true);
  });
});

describe('the fix control picks its shape from the record', () => {
  it('uses the intent, the options, then the control kind', () => {
    expect(controlShape({ intent: 'answers.needs_sponsorship' })).toBe('boolean');
    expect(controlShape({ intent: 'answers.years_of_experience', options: ['0-2 years', '3-5 years'] })).toBe('number');
    expect(controlShape({ options: ['Yes', 'No'], kind: 'select' })).toBe('boolean'); // a yes/no pair IS a boolean
    expect(controlShape({ options: ['Remote', 'Hybrid', 'Onsite'], kind: 'select' })).toBe('text');
    expect(controlShape({ kind: 'multiselect' })).toBe('string[]');
  });
});

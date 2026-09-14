import { describe, it, expect } from 'vitest';
import { PACKS, packById, workerPack } from '@/sites/packs';
import { SITES } from '@/sites';

describe('site packs', () => {
  it('has a pack for every registered Site, with unique ids', () => {
    for (const s of SITES) expect(packById(s.id)).toMatchObject({ id: s.id, label: s.label, kind: 'worker' });
    expect(new Set(PACKS.map((p) => p.id)).size).toBe(PACKS.length);
    expect(PACKS.map((p) => p.id)).toEqual([...SITES.map((s) => s.id), 'instahyre', 'linkedin']);
  });

  it('every pack is complete: hosts, steps, thresholds, needs, supports', () => {
    for (const p of PACKS) {
      expect(p.hosts.length, p.id).toBeGreaterThan(0);
      expect(p.steps.length, p.id).toBeGreaterThan(0);
      expect(p.icon, p.id).not.toBe('');
      expect(p.stallMs, p.id).toBeGreaterThan(0);
      expect(p.deadMs, p.id).toBeGreaterThan(p.stallMs);
      expect(typeof p.needs.resume).toBe('boolean');
      expect(typeof p.supports.stop).toBe('boolean');
      for (const h of p.hosts) expect(h, p.id).not.toMatch(/[/:]/); // bare hosts, not URLs
    }
  });

  it('in-page packs name the logged-in tab; worker packs do not', () => {
    for (const p of PACKS) {
      if (p.kind === 'in-page') expect(p.needs.loggedInTab, p.id).toMatch(/^https:\/\//);
      else expect(p.needs.loggedInTab, p.id).toBeUndefined();
    }
  });

  it('uses the watchdogs’ own thresholds', () => {
    expect(packById('datadog')).toMatchObject({ stallMs: 6 * 60_000, deadMs: 2 * 3_600_000 });
    expect(packById('linkedin')).toMatchObject({ stallMs: 5 * 60_000, deadMs: 40 * 60_000 });
    expect(packById('instahyre')).toMatchObject({ stallMs: 5 * 60_000, deadMs: 40 * 60_000 });
  });

  it('derives the Greenhouse pack from the Site: OTP step, Gmail needed, both frame hosts', () => {
    const dd = packById('datadog')!;
    expect(dd.steps).toEqual(['open', 'fill', 'submit', 'otp', 'confirm']);
    expect(dd.needs).toEqual({ resume: true, gmail: true, accounts: false });
    expect(dd.hosts).toEqual(['careers.datadoghq.com', 'job-boards.greenhouse.io']);
    expect(dd.icon).toBe('🐶');
    expect(dd.config).toBeUndefined();
  });

  it('Amazon: accounts + per-day limit + a search_url form', () => {
    const az = packById('amazon')!;
    expect(az.steps).toEqual(['open', 'fill', 'continue', 'review', 'submit']);
    expect(az.needs).toEqual({ resume: true, gmail: false, accounts: true });
    expect(az.limits?.perDay).toBe(10);
    expect(az.config?.key).toBe('amazon');
    expect(az.config?.fields.find((f) => f.key === 'search_url')).toMatchObject({ type: 'url', required: true });
    expect(az.config?.fields.find((f) => f.key === 'ai_consent')?.type).toBe('boolean');
  });

  it('LinkedIn: form for profile.linkedin; Instahyre needs no résumé', () => {
    const li = packById('linkedin')!;
    expect(li.config?.key).toBe('linkedin');
    expect(li.config?.fields.map((f) => [f.key, f.type])).toEqual([['search_urls', 'url[]'], ['filter_titles', 'boolean'], ['max_per_run', 'number']]);
    expect(li.config?.fields[0]?.required).toBe(true);
    expect(li.needs.resume).toBe(true);
    expect(packById('instahyre')?.needs.resume).toBe(false);
    expect(packById('instahyre')?.steps).toEqual(['open', 'apply']);
  });

  it('an unknown Greenhouse company gets a generic pack with no UI code', () => {
    const p = workerPack({ id: 'netflix', label: 'Netflix', ats: 'greenhouse', discover: async () => [] });
    expect(p).toMatchObject({ icon: '🏢', hosts: [], kind: 'worker', needs: { gmail: true, accounts: false } });
    expect(packById('netflix')).toBeUndefined();
  });
});

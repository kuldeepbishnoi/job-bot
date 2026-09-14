import { describe, it, expect } from 'vitest';
import { nextFire, siteIdFromAlarm, alarmName, DAILY_HOUR, enableDaily, dailySchedule } from '@/platform/schedule';
import { installChromeRuntimeFake } from './helpers/chrome-extras';
import { parseProfile } from '@/config/schema';
import type { SerializedFile } from '@/platform/serialized-file';
import type { Credentials } from '@/platform/credentials';

describe('daily schedule', () => {
  it('fires at the next 9:00 local, tomorrow if today is past', () => {
    const at = (h: number, m = 0) => new Date(2026, 8, 2, h, m).getTime(); // 2 Sep 2026
    expect(new Date(nextFire(9, at(8, 30)))).toEqual(new Date(2026, 8, 2, 9, 0));
    expect(new Date(nextFire(9, at(9, 0)))).toEqual(new Date(2026, 8, 3, 9, 0)); // exactly 9:00 → tomorrow
    expect(new Date(nextFire(9, at(17)))).toEqual(new Date(2026, 8, 3, 9, 0));
  });

  it('arms at 9:00 local', () => {
    expect(DAILY_HOUR).toBe(9);
  });

  it('round-trips the site id through the alarm name', () => {
    expect(siteIdFromAlarm(alarmName('amazon'))).toBe('amazon');
    expect(siteIdFromAlarm('jobbot-step')).toBeNull();
  });

  it('carries credentials through the snapshot, so a daily run can rotate accounts itself (#regression: they were previously dropped, so a hands-off multi-account run just wedged on the first limit page)', async () => {
    installChromeRuntimeFake();
    const profile = parseProfile({ identity: { first_name: 'K', last_name: 'B', email: 'k@x.com', phone: '1', country: 'India' }, resume: 'r.pdf', accounts: ['a@x.com', 'b@x.com'] });
    const resume: SerializedFile = { name: 'r.pdf', type: 'application/pdf', dataBase64: '' };
    const credentials: Credentials = { bySite: { amazon: { 'a@x.com': 'pw1', 'b@x.com': 'pw2' } } };

    await enableDaily('amazon', profile, resume, credentials);
    expect((await dailySchedule('amazon'))?.credentials).toEqual(credentials);

    // Arming WITHOUT credentials (single-account sites, or no accounts.csv) must not invent one.
    await enableDaily('datadog', profile, resume);
    expect((await dailySchedule('datadog'))?.credentials).toBeUndefined();
  });

  it('stores ONLY the armed site\'s logins — a schedule persists indefinitely, so the whole CSV must never sit there (#regression)', async () => {
    installChromeRuntimeFake();
    const profile = parseProfile({ identity: { first_name: 'K', last_name: 'B', email: 'k@x.com', phone: '1', country: 'India' }, resume: 'r.pdf' });
    const resume: SerializedFile = { name: 'r.pdf', type: 'application/pdf', dataBase64: '' };
    const everySite: Credentials = { bySite: { amazon: { 'a@x.com': 'amazon-pw' }, linkedin: { 'a@x.com': 'linkedin-pw' }, '*': { 'b@x.com': 'shared-pw' } } };

    await enableDaily('amazon', profile, resume, everySite);
    const stored = (await dailySchedule('amazon'))?.credentials;
    expect(Object.keys(stored?.bySite ?? {})).toEqual(['amazon']); // never linkedin
    expect(JSON.stringify(stored)).not.toContain('linkedin-pw');
    expect(stored?.bySite['amazon']).toEqual({ 'b@x.com': 'shared-pw', 'a@x.com': 'amazon-pw' }); // '*' still applies

    // A site with no rows of its own keeps nothing beyond the wildcard.
    await enableDaily('datadog', profile, resume, { bySite: { amazon: { 'a@x.com': 'amazon-pw' } } });
    expect((await dailySchedule('datadog'))?.credentials).toBeUndefined();
  });
});

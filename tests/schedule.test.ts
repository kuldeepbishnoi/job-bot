import { describe, it, expect } from 'vitest';
import { nextFire, siteIdFromAlarm, alarmName, DAILY_HOUR } from '@/platform/schedule';

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
});

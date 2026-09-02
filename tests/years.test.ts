import { describe, it, expect } from 'vitest';
import { pickYearsOption, yearsRange } from '@/engine/years';

// Real Amazon option sets (from fixtures/amazon-forms.json) + other common wordings.
const AMAZON = ['less than 2 years', '2 years to less than 3 years', '3 years to less than 4 years', '4 years to less than 5 years', 'more than 5 years'];
const AMAZON4 = ['less than 1 year', '1 year to less than 2 years', '2 years to less than 3 years', '3 years to less than 4 years', 'more than 4 years'];

describe('years ranges', () => {
  it('parses the wordings we have seen', () => {
    expect(yearsRange('less than 2 years')).toEqual({ min: 0, max: 2, maxInclusive: false });
    expect(yearsRange('2 years to less than 3 years')).toEqual({ min: 2, max: 3, maxInclusive: false });
    expect(yearsRange('more than 5 years')).toEqual({ min: 5, max: Number.POSITIVE_INFINITY, maxInclusive: true });
    expect(yearsRange('3+ years')).toEqual({ min: 3, max: Number.POSITIVE_INFINITY, maxInclusive: true });
    expect(yearsRange('1–2 years')).toEqual({ min: 1, max: 2, maxInclusive: true });
    expect(yearsRange('5 years or more')?.max).toBe(Number.POSITIVE_INFINITY);
    expect(yearsRange('12 months or less')).toEqual({ min: 0, max: 1, maxInclusive: true });
    expect(yearsRange('None')).toEqual({ min: 0, max: 0, maxInclusive: true });
    expect(pickYearsOption(['None', '1-2 years', '3+ years'], 0)).toBe('None');
    expect(yearsRange('Select an option')).toBeNull();
    expect(yearsRange('Yes')).toBeNull();
  });

  it('picks the bucket that contains the experience', () => {
    expect(pickYearsOption(AMAZON, 6)).toBe('more than 5 years');
    expect(pickYearsOption(AMAZON, 5)).toBe('more than 5 years'); // 5 is "more than 5" in Amazon's ladder
    expect(pickYearsOption(AMAZON, 3.5)).toBe('3 years to less than 4 years');
    expect(pickYearsOption(AMAZON, 1)).toBe('less than 2 years');
    expect(pickYearsOption(AMAZON4, 6)).toBe('more than 4 years'); // what the owner picked by hand
  });

  it('falls back to the nearest bound when no bucket contains the value', () => {
    expect(pickYearsOption(['0-1 years', '1-2 years', '2-3 years'], 10)).toBe('2-3 years');
    expect(pickYearsOption(['3-5 years', '5-8 years'], 1)).toBe('3-5 years');
    expect(pickYearsOption(['Yes', 'No'], 6)).toBeNull();
  });
});

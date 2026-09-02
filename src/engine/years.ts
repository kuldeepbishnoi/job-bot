// "How many years …?" dropdowns come as ranges in wildly different wordings:
//   "less than 2 years" · "2 years to less than 3 years" · "more than 5 years" · "3+ years" ·
//   "1–2 years" · "5 years or more" · "0-1 year". The user writes ONE number in profile.yaml
//   (years_of_experience: 6); this picks the option whose range contains it.
// Pure: (options, years) -> option label. No magic strings in config.

interface Range {
  readonly min: number; // inclusive
  readonly max: number; // Infinity for open-ended
  readonly maxInclusive: boolean;
}

const num = (s: string): number => Number.parseFloat(s.replace(',', '.'));

/** Parse an option label into a numeric range, or null if it doesn't look like one. */
export function yearsRange(label: string): Range | null {
  const t = label.toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
  if (/^(none|no experience|no prior experience)\b/.test(t)) return { min: 0, max: 0, maxInclusive: true };
  const inMonths = /\bmonths?\b/.test(t) && !/\byears?\b/.test(t);
  const nums = (t.match(/\d+(?:[.,]\d+)?/g)?.map(num) ?? []).map((n) => (inMonths ? n / 12 : n));
  if (nums.length === 0) return null;

  // "N or less" / "N or fewer" / "up to N" -> [0, N]
  if (nums.length === 1 && /(or less|or fewer|^up to|at most)/.test(t)) return { min: 0, max: nums[0]!, maxInclusive: true };

  // "less than N" / "under N" / "fewer than N" (single number) -> [0, N)
  if (nums.length === 1 && /^(less|fewer) than|^under|^below/.test(t)) return { min: 0, max: nums[0]!, maxInclusive: false };
  // "more than N" / "over N" / "N+" / "N or more" / "at least N" / "N and above" -> [N, ∞)
  if (nums.length === 1 && /(more than|over|greater than|at least|\d\s*\+|or more|and above|or above|and more)/.test(t)) {
    return { min: nums[0]!, max: Number.POSITIVE_INFINITY, maxInclusive: true };
  }
  // "A to less than B" -> [A, B) · "A-B" / "A to B" / "between A and B" -> [A, B]
  if (nums.length >= 2) {
    const [a, b] = [nums[0]!, nums[1]!];
    const exclusive = /less than|under|below/.test(t.slice(t.indexOf(String(a)) + 1));
    return { min: Math.min(a, b), max: Math.max(a, b), maxInclusive: !exclusive };
  }
  // bare "N years" -> [N, N+1)
  return { min: nums[0]!, max: nums[0]! + 1, maxInclusive: false };
}

function contains(r: Range, years: number): boolean {
  if (years < r.min) return false;
  return r.maxInclusive ? years <= r.max : years < r.max;
}

/** The option whose range contains `years`; otherwise the nearest bound (largest min when the
 *  user has more experience than any option offers, smallest when less). Null if no option parses. */
export function pickYearsOption(options: readonly string[], years: number): string | null {
  const parsed = options.map((o) => ({ o, r: yearsRange(o) })).filter((x): x is { o: string; r: Range } => x.r !== null);
  if (parsed.length === 0) return null;
  const hit = parsed.find((x) => contains(x.r, years));
  if (hit) return hit.o;
  const top = parsed.reduce((a, b) => (b.r.min > a.r.min ? b : a));
  if (years > top.r.min) return top.o;
  return parsed.reduce((a, b) => (b.r.min < a.r.min ? b : a)).o;
}

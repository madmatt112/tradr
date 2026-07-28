// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  EM_DASH,
  formatBucketLabel,
  formatMoney,
  formatPercent,
  formatProfitFactor,
  NULL_PLACEHOLDER,
} from './formatPerformance';

describe('formatPerformance — placeholders', () => {
  it('NULL_PLACEHOLDER and EM_DASH are both U+2014 (em dash) — not a hyphen', () => {
    expect(NULL_PLACEHOLDER).toBe('—');
    expect(EM_DASH).toBe('—');
    expect(NULL_PLACEHOLDER).not.toBe('-');
  });
});

describe('formatPerformance — formatMoney re-export', () => {
  it('re-exports `formatMoney` from `@/lib/format` (does not redefine)', () => {
    // Sanity check: the re-export produces a currency-formatted string.
    const out = formatMoney('1234.56', 'USD');
    // We don't pin the locale separator (`,` vs `.`) — the caller's runtime
    // locale chooses it — but USD must show $ and 1234.56 in some form.
    expect(out).toMatch(/\$/);
    expect(out).toMatch(/1[,. ]?234[.,]56/);
  });
});

describe('formatPerformance — formatPercent', () => {
  it('returns em-dash for null', () => {
    expect(formatPercent(null)).toBe(EM_DASH);
  });

  it('formats with exactly 1 decimal place (REQ-4.3)', () => {
    expect(formatPercent(0)).toBe('0.0%');
    expect(formatPercent(54.3)).toBe('54.3%');
    expect(formatPercent(100)).toBe('100.0%');
  });
});

describe('formatPerformance — formatProfitFactor', () => {
  it('formats finite numbers with 2 decimals (REQ-4.7 schema contract)', () => {
    expect(formatProfitFactor(1.5, true, true)).toBe('1.50');
    expect(formatProfitFactor(2.34, true, true)).toBe('2.34');
    expect(formatProfitFactor(0, false, true)).toBe('0.00');
  });

  it('renders ∞ ONLY for null when hasWins && !hasLosses', () => {
    expect(formatProfitFactor(null, true, false)).toBe('∞');
  });

  it('renders em-dash for null in every other combination', () => {
    expect(formatProfitFactor(null, false, false)).toBe(EM_DASH);
    expect(formatProfitFactor(null, false, true)).toBe(EM_DASH);
    // hasWins && hasLosses but pf is null shouldn't happen per the API
    // contract, but if it did, we still emit em-dash (no ∞ sentinel leakage).
    expect(formatProfitFactor(null, true, true)).toBe(EM_DASH);
  });

  it('does NOT use ∞ when pf is a finite number, regardless of flags', () => {
    expect(formatProfitFactor(1.5, true, false)).toBe('1.50');
  });
});

describe('formatPerformance — formatBucketLabel', () => {
  // Bucket-start ISO strings are local-midnight UTC instants per the API
  // contract. We use UTC tz here so the label reflects the same calendar
  // date the bucket-start represents — no offset surprises in the cases.
  const TZ_UTC = 'UTC';

  it('day → "MMM d"', () => {
    expect(formatBucketLabel('2026-03-15T00:00:00.000Z', 'day', TZ_UTC)).toBe('Mar 15');
  });

  it('week → "MMM d–d" (start day .. start+6)', () => {
    expect(formatBucketLabel('2026-03-15T00:00:00.000Z', 'week', TZ_UTC)).toBe('Mar 15–21');
  });

  it('month → "MMM yyyy"', () => {
    expect(formatBucketLabel('2026-03-01T00:00:00.000Z', 'month', TZ_UTC)).toBe('Mar 2026');
  });

  it('year → "yyyy"', () => {
    expect(formatBucketLabel('2026-01-01T00:00:00.000Z', 'year', TZ_UTC)).toBe('2026');
  });

  it('day label respects tz — UTC midnight reads as previous day in NY', () => {
    // 2026-03-15T00:00:00Z = 2026-03-14 20:00 in America/New_York (EDT, UTC-4).
    expect(formatBucketLabel('2026-03-15T00:00:00.000Z', 'day', 'America/New_York')).toBe('Mar 14');
  });
});

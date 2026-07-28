// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  formatAccounting,
  formatCurrency,
  formatMoney,
  formatPercent,
  formatProfitFactor,
  formatRelativeTime,
  formatSigned,
  moneyDirection,
} from './format';

describe('formatCurrency', () => {
  it('formats USD amounts WITHOUT a trailing currency-code suffix', () => {
    const out = formatCurrency(1234.5, 'USD');
    expect(out).toMatch(/^\$1,234\.50$/);
    // The legacy ` USD` tail was dropped — canonical on-screen money is suffix-less.
    expect(out).not.toMatch(/USD$/);
  });

  it('formats EUR amounts without the code suffix', () => {
    const out = formatCurrency(10, 'EUR');
    expect(out).toContain('10');
    expect(out).not.toMatch(/EUR$/);
  });

  it('handles negative values without the code suffix', () => {
    const out = formatCurrency(-50, 'USD');
    expect(out).toContain('50');
    expect(out).not.toMatch(/USD$/);
  });
});

describe('formatSigned', () => {
  it('prefixes a + on positive values', () => {
    expect(formatSigned(5)).toMatch(/^\+/);
  });

  it('prefixes a minus on negative values', () => {
    // U+2212 minus sign or ASCII hyphen-minus depending on locale.
    expect(formatSigned(-5)).toMatch(/^[-−]/);
  });

  it('shows no sign for zero', () => {
    expect(formatSigned(0)).not.toMatch(/^[+\-−]/);
  });

  it('forwards Intl options (currency style)', () => {
    const out = formatSigned(1234.5, { style: 'currency', currency: 'USD' });
    expect(out).toMatch(/^\+\$1,234\.50$/);
  });
});

describe('formatAccounting', () => {
  it('parenthesizes negative amounts', () => {
    expect(formatAccounting(-1240, 'USD')).toMatch(/^\(\$?1,240\.00\)$/);
  });

  it('keeps a leading + on gains', () => {
    expect(formatAccounting(1240, 'USD')).toMatch(/^\+\$1,240\.00$/);
  });

  it('renders zero with no sign or parentheses', () => {
    const out = formatAccounting(0, 'USD');
    expect(out).not.toMatch(/^[(+]/);
    expect(out).toContain('0.00');
  });
});

describe('moneyDirection', () => {
  it('classifies null as absent', () => {
    expect(moneyDirection(null)).toBe('absent');
  });

  it('classifies zero as flat', () => {
    expect(moneyDirection(0)).toBe('flat');
  });

  it('classifies positive as gain', () => {
    expect(moneyDirection(1)).toBe('gain');
  });

  it('classifies negative as loss', () => {
    expect(moneyDirection(-1)).toBe('loss');
  });
});

describe('formatPercent', () => {
  it('returns the em-dash placeholder for null', () => {
    expect(formatPercent(null)).toBe('—');
  });

  it('formats to one decimal place', () => {
    expect(formatPercent(0)).toBe('0.0%');
    expect(formatPercent(54.3)).toBe('54.3%');
    expect(formatPercent(100)).toBe('100.0%');
  });
});

describe('formatProfitFactor', () => {
  it('formats a finite factor to two decimals', () => {
    expect(formatProfitFactor(1.5, true, true)).toBe('1.50');
  });

  it('returns ∞ only when there are wins and no losses', () => {
    expect(formatProfitFactor(null, true, false)).toBe('∞');
  });

  it('returns the em-dash placeholder for any other null case', () => {
    expect(formatProfitFactor(null, false, false)).toBe('—');
    expect(formatProfitFactor(null, true, true)).toBe('—');
  });
});

describe('formatMoney', () => {
  it('formats a decimal string as currency WITHOUT the duplicated code suffix', () => {
    const out = formatMoney('1234.50', 'USD');
    expect(out).toContain('1,234.50');
    // Must NOT double-print the currency code — regression guard for review finding.
    expect(out).not.toMatch(/USD$/);
  });

  it('round-trips an integer decimal string', () => {
    expect(formatMoney('100', 'USD')).toContain('100');
  });

  it('handles negative decimal strings', () => {
    const out = formatMoney('-25.00', 'USD');
    expect(out).toMatch(/-|\(/);
    expect(out).toContain('25');
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-05-27T12:00:00Z');

  it('returns "just now" for diffs under 60s', () => {
    const then = new Date(now.getTime() - 30 * 1000).toISOString();
    expect(formatRelativeTime(then, now)).toBe('just now');
  });

  it('returns "5m ago" at the 5-minute boundary', () => {
    const then = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    expect(formatRelativeTime(then, now)).toBe('5m ago');
  });

  it('returns "5h ago" at the 5-hour boundary', () => {
    const then = new Date(now.getTime() - 5 * 3600 * 1000).toISOString();
    expect(formatRelativeTime(then, now)).toBe('5h ago');
  });

  it('returns "yesterday" at the 25-hour boundary', () => {
    const then = new Date(now.getTime() - 25 * 3600 * 1000).toISOString();
    expect(formatRelativeTime(then, now)).toBe('yesterday');
  });

  it('returns "3d ago" at the 3-day boundary', () => {
    const then = new Date(now.getTime() - 3 * 86_400 * 1000).toISOString();
    expect(formatRelativeTime(then, now)).toBe('3d ago');
  });

  it('returns an absolute "Mon D" date for diffs older than 7 days', () => {
    const then = new Date(now.getTime() - 8 * 86_400 * 1000).toISOString();
    expect(formatRelativeTime(then, now)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it('returns an empty string for invalid or empty input', () => {
    expect(formatRelativeTime('not-a-date', now)).toBe('');
    expect(formatRelativeTime('', now)).toBe('');
  });

  it('clamps future timestamps to "just now"', () => {
    const then = new Date(now.getTime() + 30 * 1000).toISOString();
    expect(formatRelativeTime(then, now)).toBe('just now');
  });
});

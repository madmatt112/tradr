// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { formatIntString, formatMicroUsd } from './format';

describe('formatMicroUsd — string→Intl path (no float arithmetic on money)', () => {
  it('renders a whole-dollar micro-USD string', () => {
    expect(formatMicroUsd('1000000')).toBe('$1.00');
  });

  it('renders a sub-dollar micro-USD string', () => {
    expect(formatMicroUsd('1500000')).toBe('$1.50');
  });

  it('renders zero', () => {
    expect(formatMicroUsd('0')).toBe('$0.00');
  });

  it('renders a large value with grouping', () => {
    expect(formatMicroUsd('123456789')).toBe('$123.46');
  });

  it('formats an 18-digit micro-USD balance losslessly (no float)', () => {
    // 123_456_789_012_345_678 micro-USD = 123,456,789,012.345678 USD.
    // Number() would lose precision past ~15 significant digits; the BigInt
    // path keeps every digit, then rounds the trailing .345678 to .35 cents.
    expect(formatMicroUsd('123456789012345678')).toBe('$123,456,789,012.35');
  });

  it('renders negative micro-USD as a parenthesised/negated currency string', () => {
    const out = formatMicroUsd('-2500000');
    expect(out).toContain('2.50');
    expect(out).toMatch(/[-−(]/);
  });
});

describe('formatIntString', () => {
  it('groups large integer-string counts', () => {
    expect(formatIntString('1234567')).toBe('1,234,567');
  });
});

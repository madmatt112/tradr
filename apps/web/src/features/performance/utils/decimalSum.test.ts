// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { sumDecimalStrings } from './decimalSum';

describe('sumDecimalStrings', () => {
  it('returns 0 for an empty list', () => {
    expect(sumDecimalStrings([])).toBe('0');
  });

  it('is exact for 0.1 + 0.2 (no float error)', () => {
    expect(sumDecimalStrings(['0.1', '0.2'])).toBe('0.3');
  });

  it('sums mixed fractional scales at the widest scale present', () => {
    expect(sumDecimalStrings(['1.5', '2.25', '3'])).toBe('6.75');
  });

  it('sums negatives and positives', () => {
    expect(sumDecimalStrings(['-1.50', '2.00', '-0.25'])).toBe('0.25');
  });

  it('cancels to a clean zero without a sign', () => {
    expect(sumDecimalStrings(['-1.50', '1.50'])).toBe('0.00');
    expect(sumDecimalStrings(['10', '-4', '-6'])).toBe('0');
  });

  it('preserves the widest scale for a single value', () => {
    expect(sumDecimalStrings(['5.00'])).toBe('5.00');
  });

  it('is exact beyond IEEE-754 integer precision (BigInt, not float)', () => {
    expect(sumDecimalStrings(['9007199254740993', '1'])).toBe('9007199254740994');
  });
});

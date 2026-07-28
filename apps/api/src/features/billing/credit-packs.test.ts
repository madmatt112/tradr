import { describe, expect, it } from 'vitest';

import { CreditPackSchema } from '@tradr/shared';

import { CREDIT_PACKS } from './credit-packs';

describe('CREDIT_PACKS', () => {
  it('every pack parses against CreditPackSchema', () => {
    for (const pack of CREDIT_PACKS) {
      expect(() => CreditPackSchema.parse(pack)).not.toThrow();
    }
  });

  it('credits are non-negative integer micro-USD strings', () => {
    for (const pack of CREDIT_PACKS) {
      expect(pack.credits).toMatch(/^\d+$/);
      expect(Number.isInteger(Number(pack.credits))).toBe(true);
    }
  });

  it('priceMinor is a positive integer', () => {
    for (const pack of CREDIT_PACKS) {
      expect(Number.isInteger(pack.priceMinor)).toBe(true);
      expect(pack.priceMinor).toBeGreaterThan(0);
    }
  });

  it('pack ids are unique', () => {
    const ids = CREDIT_PACKS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a malformed pack fails CreditPackSchema (guards the constant)', () => {
    const malformed = { id: 'bad', label: '$x', priceMinor: -1, currency: 'usd', credits: '1.5' };
    expect(() => CreditPackSchema.parse(malformed)).toThrow();
  });
});

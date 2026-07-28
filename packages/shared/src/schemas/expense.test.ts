import { describe, expect, it } from 'vitest';

import { ledgerAmountSchema } from './accounting';
import { positiveDecimal4, TaxSummaryResponseSchema } from './expense';

describe('positiveDecimal4', () => {
  it('rejects "0"', () => {
    expect(positiveDecimal4.safeParse('0').success).toBe(false);
  });

  it('rejects "-1"', () => {
    expect(positiveDecimal4.safeParse('-1').success).toBe(false);
  });

  it('rejects " 1 " (surrounding whitespace)', () => {
    expect(positiveDecimal4.safeParse(' 1 ').success).toBe(false);
  });

  it('rejects "1.12345" (more than 4 fractional digits)', () => {
    expect(positiveDecimal4.safeParse('1.12345').success).toBe(false);
  });

  it('accepts "0.0001"', () => {
    expect(positiveDecimal4.safeParse('0.0001').success).toBe(true);
  });

  it('accepts "100.00"', () => {
    expect(positiveDecimal4.safeParse('100.00').success).toBe(true);
  });
});

describe('positiveDecimal4 vs ledgerAmount regex alignment', () => {
  it('both accept "0.5"', () => {
    expect(positiveDecimal4.safeParse('0.5').success).toBe(true);
    expect(ledgerAmountSchema.safeParse('0.5').success).toBe(true);
  });

  it('only ledgerAmount accepts "0" (intentional divergence)', () => {
    expect(positiveDecimal4.safeParse('0').success).toBe(false);
    expect(ledgerAmountSchema.safeParse('0').success).toBe(true);
  });
});

describe('TaxSummaryResponseSchema strict()', () => {
  const validBase = {
    year: 2026,
    jurisdiction: 'other' as const,
    displayCurrency: null,
    realisedPnl: {
      total: null,
      perCurrency: [],
      shortTerm: null,
      longTerm: null,
    },
    trackedExpenses: {
      total: null,
      perCurrency: [],
      perCategory: [],
    },
    flags: { washSales: [], superficialLosses: [] },
    missingRates: [],
    excludedCurrencies: [],
    ratesAsOf: null,
    usedRates: [],
    disclaimer: '',
  };

  it('accepts a minimally-valid payload', () => {
    expect(TaxSummaryResponseSchema.safeParse(validBase).success).toBe(true);
  });

  it('rejects the forbidden netTaxableIncome field (Req 4.1)', () => {
    const withForbidden = { ...validBase, netTaxableIncome: '100' };
    expect(TaxSummaryResponseSchema.safeParse(withForbidden).success).toBe(false);
  });
});

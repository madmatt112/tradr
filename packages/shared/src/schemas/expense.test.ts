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
    lotMethod: 'fifo' as const,
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
    lotRealisations: [],
    missingRates: [],
    excludedCurrencies: [],
    ratesAsOf: null,
    usedRates: [],
    disclaimer: '',
    // Always-present, empty off the acb path (AC 5.1, AC 8.1, design D6).
    acbDispositions: [],
    acbMissingRates: [],
  };

  it('accepts a minimally-valid payload', () => {
    expect(TaxSummaryResponseSchema.safeParse(validBase).success).toBe(true);
  });

  it('rejects the forbidden netTaxableIncome field (Req 4.1)', () => {
    const withForbidden = { ...validBase, netTaxableIncome: '100' };
    expect(TaxSummaryResponseSchema.safeParse(withForbidden).success).toBe(false);
  });

  it('accepts acb disposition rows carrying every AC 5.3 field, priced and unpriced', () => {
    const withAcb = {
      ...validBase,
      lotMethod: 'acb' as const,
      acbDispositions: [
        {
          exitFillId: '11111111-1111-1111-a111-111111111111',
          positionId: '22222222-2222-2222-a222-222222222222',
          accountId: '33333333-3333-3333-a333-333333333333',
          symbol: 'XYZ',
          currency: 'CAD',
          tradeDate: '2026-03-01',
          realisedAt: '2026-03-01T15:00:00.000Z',
          quantity: '50',
          cadRate: null,
          proceeds: '600.00',
          outlays: '0.00',
          acb: '520.00',
          gain: '80.00',
          unpricedReason: null,
        },
        {
          exitFillId: '44444444-4444-4444-a444-444444444444',
          positionId: '55555555-5555-5555-a555-555555555555',
          accountId: '66666666-6666-6666-a666-666666666666',
          symbol: 'NRTE',
          currency: 'USD',
          tradeDate: '2026-04-01',
          realisedAt: '2026-04-01T15:00:00.000Z',
          quantity: '50',
          cadRate: null,
          proceeds: null,
          outlays: null,
          acb: null,
          gain: null,
          unpricedReason: 'missing_rate' as const,
        },
      ],
      acbMissingRates: [{ currency: 'USD', tradeDate: '2026-04-01' }],
    };
    expect(TaxSummaryResponseSchema.safeParse(withAcb).success).toBe(true);
  });
});

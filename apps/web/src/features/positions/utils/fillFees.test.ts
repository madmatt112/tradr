import { describe, expect, it } from 'vitest';

import type { FeeSchedule } from '@tradr/shared';

import { computeFillFee, fillSide } from './fillFees';

const schedule: FeeSchedule = {
  stockPerShareCommission: '0.005',
  stockMinPerFill: '1',
  stockMaxPerFill: '0',
  optionsPerContractCommission: '0.65',
  optionsPerContractExchangeFee: '0',
  optionsMinPerFill: '0',
  optionsMaxPerFill: '0',
};

describe('fillSide', () => {
  it('maps an entry to the direction that opens the position', () => {
    expect(fillSide('long', 'entry')).toBe('buy');
    expect(fillSide('short', 'entry')).toBe('sell');
  });

  it('maps an exit to the direction that closes it', () => {
    expect(fillSide('long', 'exit')).toBe('sell');
    expect(fillSide('short', 'exit')).toBe('buy');
  });
});

describe('computeFillFee', () => {
  const base = {
    schedule,
    assetType: 'stock' as const,
    positionSide: 'long' as const,
    type: 'entry' as const,
  };

  it('prices a stock fill through the shared calculator', () => {
    // 1000 shares × 0.005 = 5.00, above the 1.00 minimum.
    expect(computeFillFee({ ...base, price: '10', quantity: '1000' })).toBe('5');
  });

  it('applies the per-fill minimum on small fills', () => {
    expect(computeFillFee({ ...base, price: '10', quantity: '10' })).toBe('1');
  });

  it('prices options per contract', () => {
    const fee = computeFillFee({
      ...base,
      assetType: 'option',
      price: '2.50',
      quantity: '10',
    });
    expect(fee).toBe('6.5');
  });

  // A half-typed form must not render a confident 0.00.
  it('returns null until price and quantity are usable', () => {
    expect(computeFillFee({ ...base, price: '', quantity: '' })).toBeNull();
    expect(computeFillFee({ ...base, price: '10', quantity: '' })).toBeNull();
    expect(computeFillFee({ ...base, price: '0', quantity: '100' })).toBeNull();
    expect(computeFillFee({ ...base, price: 'abc', quantity: '100' })).toBeNull();
    expect(computeFillFee({ ...base, price: '10', quantity: '-5' })).toBeNull();
  });
});

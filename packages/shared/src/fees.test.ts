import { describe, it, expect } from 'vitest';

import { calculateFees } from './fees';
import type { FeeScheduleInput, FillInput } from './fees';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const defaultSchedule: FeeScheduleInput = {
  stockPerShareCommission: '0.005',
  stockMinPerFill: '1',
  stockMaxPerFill: '10',
  optionsPerContractCommission: '0.65',
  optionsPerContractExchangeFee: '0',
  optionsMinPerFill: '1',
  optionsMaxPerFill: '10',
};

function stockFill(quantity: string, price = '100'): FillInput {
  return { quantity, price, type: 'stock', side: 'buy' };
}

function optionFill(quantity: string, price = '2.50'): FillInput {
  return { quantity, price, type: 'option', side: 'buy' };
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('calculateFees', () => {
  // 1. Stock basic fee
  it('computes stock fee as quantity * perShare commission', () => {
    const schedule: FeeScheduleInput = {
      ...defaultSchedule,
      stockMinPerFill: '0',
      stockMaxPerFill: '0',
    };
    const result = calculateFees([stockFill('100')], schedule);
    // 100 * 0.005 = 0.50
    expect(result.perFillFees).toEqual(['0.5']);
    expect(result.totalFees).toBe('0.5');
  });

  // 2. Stock min per fill
  it('applies stock minimum per fill', () => {
    const result = calculateFees([stockFill('10')], defaultSchedule);
    // 10 * 0.005 = 0.05, min=1 → 1
    expect(result.perFillFees).toEqual(['1']);
    expect(result.totalFees).toBe('1');
  });

  // 3. Stock max per fill
  it('applies stock maximum per fill', () => {
    const result = calculateFees([stockFill('10000')], defaultSchedule);
    // 10000 * 0.005 = 50, max=10 → 10
    expect(result.perFillFees).toEqual(['10']);
    expect(result.totalFees).toBe('10');
  });

  // 4. Stock zero quantity
  it('returns $0 for stock with zero quantity regardless of min', () => {
    const result = calculateFees([stockFill('0')], defaultSchedule);
    expect(result.perFillFees).toEqual(['0']);
    expect(result.totalFees).toBe('0');
  });

  // 5. Options basic
  it('computes options fee as quantity * perContract commission', () => {
    const result = calculateFees([optionFill('5')], {
      ...defaultSchedule,
      optionsMinPerFill: '0',
      optionsMaxPerFill: '0',
    });
    // 5 * 0.65 = 3.25
    expect(result.perFillFees).toEqual(['3.25']);
    expect(result.totalFees).toBe('3.25');
  });

  // 6. Options with exchange fee
  it('includes exchange fee in options calculation', () => {
    const schedule: FeeScheduleInput = {
      ...defaultSchedule,
      optionsPerContractExchangeFee: '0.05',
      optionsMinPerFill: '0',
      optionsMaxPerFill: '0',
    };
    const result = calculateFees([optionFill('5')], schedule);
    // 5 * (0.65 + 0.05) = 3.50
    expect(result.perFillFees).toEqual(['3.5']);
    expect(result.totalFees).toBe('3.5');
  });

  // 7. Options min per fill
  it('applies options minimum per fill', () => {
    const result = calculateFees([optionFill('1')], defaultSchedule);
    // 1 * 0.65 = 0.65, min=1 → 1
    expect(result.perFillFees).toEqual(['1']);
    expect(result.totalFees).toBe('1');
  });

  // 8. Options max per fill
  it('applies options maximum per fill', () => {
    const result = calculateFees([optionFill('100')], defaultSchedule);
    // 100 * 0.65 = 65, max=10 → 10
    expect(result.perFillFees).toEqual(['10']);
    expect(result.totalFees).toBe('10');
  });

  // 9. Options zero quantity
  it('returns $0 for options with zero quantity regardless of min', () => {
    const result = calculateFees([optionFill('0')], defaultSchedule);
    expect(result.perFillFees).toEqual(['0']);
    expect(result.totalFees).toBe('0');
  });

  // 10. Mixed fills (stock + option)
  it('handles mixed stock and option fills', () => {
    const result = calculateFees([stockFill('10'), optionFill('1')], defaultSchedule);
    // stock: 10 * 0.005 = 0.05, min=1 → 1
    // option: 1 * 0.65 = 0.65, min=1 → 1
    expect(result.perFillFees).toEqual(['1', '1']);
    expect(result.totalFees).toBe('2');
  });

  // 11. All-zero fee schedule
  it('returns $0 for all fills with all-zero fee schedule', () => {
    const zeroSchedule: FeeScheduleInput = {
      stockPerShareCommission: '0',
      stockMinPerFill: '0',
      stockMaxPerFill: '0',
      optionsPerContractCommission: '0',
      optionsPerContractExchangeFee: '0',
      optionsMinPerFill: '0',
      optionsMaxPerFill: '0',
    };
    const result = calculateFees([stockFill('100'), optionFill('10')], zeroSchedule);
    expect(result.perFillFees).toEqual(['0', '0']);
    expect(result.totalFees).toBe('0');
  });

  // 12. Large quantities
  it('handles large quantities (1,000,000 shares)', () => {
    const schedule: FeeScheduleInput = {
      ...defaultSchedule,
      stockMaxPerFill: '0', // no cap
    };
    const result = calculateFees([stockFill('1000000')], schedule);
    // 1000000 * 0.005 = 5000, min=1, max=0 (no cap) → 5000
    expect(result.perFillFees).toEqual(['5000']);
    expect(result.totalFees).toBe('5000');
  });

  // 13. 4 decimal place precision
  it('rounds fees to 4 decimal places', () => {
    const schedule: FeeScheduleInput = {
      ...defaultSchedule,
      stockPerShareCommission: '0.00337',
      stockMinPerFill: '0',
      stockMaxPerFill: '0',
    };
    const result = calculateFees([stockFill('3')], schedule);
    // 3 * 0.00337 = 0.01011 → rounds to 0.0101 (4dp)
    expect(result.perFillFees).toEqual(['0.0101']);
    expect(result.totalFees).toBe('0.0101');
  });

  // 14. Empty array
  it('returns empty result for empty fills array', () => {
    const result = calculateFees([], defaultSchedule);
    expect(result.perFillFees).toEqual([]);
    expect(result.totalFees).toBe('0');
  });

  // 15. min=max boundary
  it('clamps to boundary value when min equals max', () => {
    const schedule: FeeScheduleInput = {
      ...defaultSchedule,
      stockMinPerFill: '1',
      stockMaxPerFill: '1',
    };
    // Any non-zero qty should produce fee of 1
    const result = calculateFees([stockFill('500')], schedule);
    expect(result.perFillFees).toEqual(['1']);

    const result2 = calculateFees([stockFill('1')], schedule);
    expect(result2.perFillFees).toEqual(['1']);
  });

  // 16. Fractional quantity
  it('handles fractional quantities (0.5 shares)', () => {
    const schedule: FeeScheduleInput = {
      ...defaultSchedule,
      stockMinPerFill: '0',
      stockMaxPerFill: '0',
    };
    const result = calculateFees([stockFill('0.5')], schedule);
    // 0.5 * 0.005 = 0.0025
    expect(result.perFillFees).toEqual(['0.0025']);
    expect(result.totalFees).toBe('0.0025');
  });

  // 17. max=0 sentinel (no cap)
  it('treats max=0 as no cap (IBKR-style)', () => {
    const schedule: FeeScheduleInput = {
      ...defaultSchedule,
      stockMinPerFill: '1',
      stockMaxPerFill: '0', // no cap
    };
    const result = calculateFees([stockFill('10000')], schedule);
    // 10000 * 0.005 = 50, min=1, no cap → 50
    expect(result.perFillFees).toEqual(['50']);
    expect(result.totalFees).toBe('50');
  });

  // 18. Sum consistency
  it('totalFees equals sum of perFillFees', () => {
    const schedule: FeeScheduleInput = {
      ...defaultSchedule,
      stockMinPerFill: '0',
      stockMaxPerFill: '0',
      optionsMinPerFill: '0',
      optionsMaxPerFill: '0',
      optionsPerContractExchangeFee: '0.15',
    };
    const fills: FillInput[] = [
      stockFill('123'),
      optionFill('7'),
      stockFill('456'),
      optionFill('13'),
    ];
    const result = calculateFees(fills, schedule);

    const sum = result.perFillFees.reduce((acc, f) => acc + parseFloat(f), 0).toString();
    // Use parseFloat to compare since string representations may differ
    expect(parseFloat(result.totalFees)).toBeCloseTo(parseFloat(sum), 4);
  });

  // 19. Multiple fills total accumulation
  it('accumulates total across multiple fills', () => {
    const schedule: FeeScheduleInput = {
      ...defaultSchedule,
      stockMinPerFill: '0',
      stockMaxPerFill: '0',
    };
    const result = calculateFees([stockFill('200'), stockFill('300'), stockFill('500')], schedule);
    // 200*0.005=1, 300*0.005=1.5, 500*0.005=2.5 → total=5
    expect(result.perFillFees).toEqual(['1', '1.5', '2.5']);
    expect(result.totalFees).toBe('5');
  });

  // 20. Zero-quantity fill among non-zero fills
  it('handles zero-quantity fill among non-zero fills', () => {
    const result = calculateFees(
      [stockFill('200'), stockFill('0'), stockFill('200')],
      defaultSchedule,
    );
    // 200*0.005=1, min=1 → 1; 0 → 0; 200*0.005=1, min=1 → 1
    expect(result.perFillFees).toEqual(['1', '0', '1']);
    expect(result.totalFees).toBe('2');
  });
});

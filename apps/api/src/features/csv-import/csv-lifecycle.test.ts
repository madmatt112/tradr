import { Decimal } from 'decimal.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { encodeOccCompact } from '@tradr/shared';

import { classifyEventCode, liftLifecycleEvents } from './csv-lifecycle';
import type { NormalizedRow } from './csv-normalize';

/**
 * Contract block — one row per success criterion this file covers.
 *
 * | Criterion                                                  | Pre-condition                                                              | Call (seam)                      | Observable result                                                             | Source of expected value |
 * |-------------------------------------------------------------|-------------------------------------------------------------------------------|-----------------------------------|----------------------------------------------------------------------------------|---------------------------|
 * | AC 10.1 classifier                                           | eventCode cells `A`, `EX`, `AEX`, `MEX`, `O;A`, `EP`, `GEA`, `O`, ``          | classifyEventCode(cell)           | assigned / exercised / assigned / unsupported / undefined per cell               | task 18 _Prompt Success   |
 * | AC 10.4 matched stock row                                     | tagged option row + a 100-share stock row at the strike, same UTC day        | liftLifecycleEvents(rows)         | rows: []; one event with summed fee; no warning                                 | task 18 _Prompt Success, design D16 |
 * | AC 10.5 price mismatch                                        | tagged option row + a coded stock row at a different price                   | liftLifecycleEvents(rows)         | the stock row stays; one lifecycle_basis_excludes_premium warning               | task 18 _Prompt Success  |
 * | AC 10.5 date mismatch                                         | tagged option row + a coded stock row on a different UTC day                 | liftLifecycleEvents(rows)         | the stock row stays; one lifecycle_basis_excludes_premium warning               | task 18 _Prompt Success  |
 * | non-lifecycle code (regression)                               | a stock row whose eventCode classifies to neither assigned nor exercised     | liftLifecycleEvents(rows)         | the stock row stays unchanged; no warning                                       | task 18 _Prompt Success  |
 */

beforeAll(() => {
  Decimal.set({ rounding: Decimal.ROUND_HALF_UP, precision: 20 });
});

function occ(underlying: string, expiration: string, type: 'call' | 'put', strike: string): string {
  const result = encodeOccCompact({ underlying, expiration, type, strike });
  if (!result.ok) {
    throw new Error(`fixture OCC symbol invalid: ${result.error.message}`);
  }
  return result.value;
}

/** A tagged option row, as task 19's contract resolution step would leave it. */
function optionRow(
  sourceRow: number,
  symbol: string,
  overrides: Partial<Record<string, string>> = {},
): NormalizedRow {
  return {
    sourceRow,
    values: {
      symbol,
      assetType: 'option',
      eventCode: 'A',
      quantity: '1',
      price: '2.50',
      fees: '1.00',
      filledAt: '2026-03-20T14:30:00.000Z',
      ...overrides,
    },
    lifecycleOutcome: 'assigned',
  } as NormalizedRow;
}

/** An untouched stock row, carrying whatever lifecycle code the broker stamped on it. */
function stockRow(sourceRow: number, overrides: Partial<Record<string, string>> = {}): NormalizedRow {
  return {
    sourceRow,
    values: {
      symbol: 'AAPL',
      assetType: 'stock',
      eventCode: 'A',
      quantity: '100',
      price: '150',
      fees: '0.50',
      filledAt: '2026-03-20T09:30:00.000Z',
      ...overrides,
    },
  };
}

describe('classifyEventCode (AC 10.1)', () => {
  it('classifies A as assigned', () => {
    expect(classifyEventCode('A')).toBe('assigned');
  });

  it('classifies EX, AEX and MEX as exercised', () => {
    expect(classifyEventCode('EX')).toBe('exercised');
    expect(classifyEventCode('AEX')).toBe('exercised');
    expect(classifyEventCode('MEX')).toBe('exercised');
  });

  it('classifies a multi-token cell by its recognised code: O;A as assigned', () => {
    expect(classifyEventCode('O;A')).toBe('assigned');
  });

  it('classifies EP and GEA as unsupported', () => {
    expect(classifyEventCode('EP')).toBe('unsupported');
    expect(classifyEventCode('GEA')).toBe('unsupported');
  });

  it('classifies O and an empty cell as neither', () => {
    expect(classifyEventCode('O')).toBeUndefined();
    expect(classifyEventCode('')).toBeUndefined();
  });
});

describe('liftLifecycleEvents — matched stock row (AC 10.4)', () => {
  it('a short put assignment and its 100-share stock row at the strike, same UTC day, lift into one event, no remaining stock row, fee summed', () => {
    const symbol = occ('AAPL', '2026-06-19', 'put', '150');
    const option = optionRow(2, symbol);
    const stock = stockRow(3, { price: '150', quantity: '100', fees: '0.50' });

    const { rows, events, warnings } = liftLifecycleEvents([option, stock]);

    expect(rows).toEqual([]);
    expect(warnings).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      rowNumber: 2,
      outcome: 'assigned',
      symbol,
      quantity: option.values.quantity,
      date: option.values.filledAt,
    });
    const expectedFee = new Decimal(option.values.fees).plus(stock.values.fees);
    expect(new Decimal(events[0].fee).equals(expectedFee)).toBe(true);
  });
});

describe('liftLifecycleEvents — unmatched coded stock row warns (AC 10.5)', () => {
  it('a stock row priced away from the strike stays and takes a lifecycle_basis_excludes_premium warning', () => {
    const symbol = occ('AAPL', '2026-06-19', 'put', '150');
    const option = optionRow(2, symbol);
    const stock = stockRow(3, { price: '151', quantity: '100' });

    const { rows, events, warnings } = liftLifecycleEvents([option, stock]);

    expect(rows).toEqual([stock]);
    expect(events).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ rowNumber: 3, kind: 'lifecycle_basis_excludes_premium' });
    expect(typeof warnings[0].message).toBe('string');
  });

  it('a stock row dated a different UTC day stays and takes a lifecycle_basis_excludes_premium warning', () => {
    const symbol = occ('AAPL', '2026-06-19', 'put', '150');
    const option = optionRow(2, symbol);
    const stock = stockRow(3, { price: '150', quantity: '100', filledAt: '2026-03-21T09:30:00.000Z' });

    const { rows, events, warnings } = liftLifecycleEvents([option, stock]);

    expect(rows).toEqual([stock]);
    expect(events).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ rowNumber: 3, kind: 'lifecycle_basis_excludes_premium' });
  });
});

describe('liftLifecycleEvents — non-lifecycle stock code (regression)', () => {
  it('a stock row with a non-lifecycle code stays with no warning', () => {
    const stock = stockRow(3, { eventCode: 'O' });

    const { rows, events, warnings } = liftLifecycleEvents([stock]);

    expect(rows).toEqual([stock]);
    expect(events).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

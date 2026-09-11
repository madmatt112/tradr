import { Decimal } from 'decimal.js';
import { beforeAll, describe, expect, it } from 'vitest';

import type { ContractForm, LocatedError, NumberFormat } from '@tradr/shared';

import { decodeDescriptor, resolveContracts, type ContractOptions } from './csv-contract';
import type { NormalizedRow } from './csv-normalize';

// Mirror the global Decimal config (app.ts:82) so the encoder/parser and the
// descriptor's strike parse behave exactly as in production.
beforeAll(() => {
  Decimal.set({ rounding: Decimal.ROUND_HALF_UP, precision: 20 });
});

const COLUMNS: Record<string, string> = {
  symbol: 'Symbol',
  underlying: 'Underlying',
  expiry: 'Expiry',
  strike: 'Strike',
  right: 'Right',
  descriptor: 'Description',
  multiplier: 'Multiplier',
  eventCode: 'Code',
};

function row(values: Record<string, string>, sourceRow = 2): NormalizedRow {
  return { sourceRow, values };
}

function opts(contractForm?: ContractForm, numberFormat: NumberFormat = 'us'): ContractOptions {
  return { contractForm, numberFormat, columns: COLUMNS };
}

/** Narrow a decode result to success, failing the test otherwise. */
function decoded(cell: string, format: NumberFormat = 'us') {
  const result = decodeDescriptor(cell, format);
  if (!result.ok) throw new Error(`expected decode success, got ${JSON.stringify(result)}`);
  return result;
}

function findError(errors: LocatedError[], code: string): LocatedError {
  const found = errors.find((e) => e.code === code);
  if (!found) throw new Error(`expected error ${code}, got ${JSON.stringify(errors)}`);
  return found;
}

// ---------------------------------------------------------------------------
// decodeDescriptor
// ---------------------------------------------------------------------------

describe('decodeDescriptor — Tradervue grammar', () => {
  it('monthly form (no day) derives the third Friday', () => {
    const d = decoded('JAN 12 125 CALL');
    expect(d).toMatchObject({
      expiration: '2012-01-20',
      type: 'call',
      strike: '125',
      derived: true,
    });
  });

  it('weekly form (explicit day) is not derived', () => {
    const d = decoded('APR26 13 375 PUT');
    expect(d).toMatchObject({
      expiration: '2013-04-26',
      type: 'put',
      strike: '375',
      derived: false,
    });
  });

  it('refuses a trailing M (mini) before any decode', () => {
    expect(decodeDescriptor('APR26 13 375 PUT M', 'us')).toEqual({
      ok: false,
      reason: 'mini',
      detail: 'APR26 13 375 PUT M',
    });
  });

  it('trims outer whitespace and upper-cases (lowercase input)', () => {
    const d = decoded(' jan 12 125 call ');
    expect(d).toMatchObject({
      expiration: '2012-01-20',
      type: 'call',
      strike: '125',
      derived: true,
    });
  });

  it('parses a decimal strike under the eu number format', () => {
    const d = decoded('JAN 12 125,50 CALL', 'eu');
    expect(d.strike).toBe('125.5');
  });

  describe('unparseable shapes', () => {
    for (const cell of ['JAN 12 CALL', '13 JAN 125 CALL', 'JAN 12 abc CALL', 'XYZ 12 125 CALL']) {
      it(`rejects "${cell}"`, () => {
        expect(decodeDescriptor(cell, 'us')).toMatchObject({ ok: false, reason: 'unparseable' });
      });
    }

    it('rejects a cell over the 64-char cap', () => {
      const long = `JAN 12 125 CALL ${'X'.repeat(60)}`;
      expect(long.length).toBeGreaterThan(64);
      expect(decodeDescriptor(long, 'us')).toMatchObject({ ok: false, reason: 'unparseable' });
    });
  });

  it('decodes YY >= 50 to a 20xx date the encoder later rejects (JAN 55 -> 2055-01-15)', () => {
    const d = decoded('JAN 55 125 CALL');
    expect(d).toMatchObject({ expiration: '2055-01-15', type: 'call', derived: true });
  });

  describe('third-Friday table', () => {
    const cases: Array<[string, string]> = [
      ['JAN 12 100 CALL', '2012-01-20'],
      ['FEB 15 100 CALL', '2015-02-20'],
      ['MAR 26 100 CALL', '2026-03-20'],
      ['APR 13 100 CALL', '2013-04-19'],
      ['MAY 26 100 CALL', '2026-05-15'], // May 2026: the 1st is a Friday
      ['AUG 26 100 CALL', '2026-08-21'], // Aug 2026: the 1st is a Saturday
    ];
    for (const [cell, expiration] of cases) {
      it(`${cell} -> ${expiration}`, () => {
        expect(decoded(cell).expiration).toBe(expiration);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// resolveContracts — one contract, four forms
// ---------------------------------------------------------------------------

describe('resolveContracts — the same contract via every form', () => {
  const expected = 'AAPL260320C250';

  it('padded OCC-21 (occ-symbol)', () => {
    const result = resolveContracts(
      [row({ symbol: 'AAPL  260320C00250000', assetType: 'option' })],
      opts('occ-symbol'),
    );
    expect(result.errors).toEqual([]);
    expect(result.rows[0].values.symbol).toBe(expected);
  });

  it('Form 3 (occ-symbol)', () => {
    const result = resolveContracts(
      [row({ symbol: 'AAPL260320C00250000', assetType: 'option' })],
      opts('occ-symbol'),
    );
    expect(result.rows[0].values.symbol).toBe(expected);
  });

  it('Form 4 (occ-symbol)', () => {
    const result = resolveContracts(
      [row({ symbol: 'AAPL260320C250', assetType: 'option' })],
      opts('occ-symbol'),
    );
    expect(result.rows[0].values.symbol).toBe(expected);
  });

  it('composed cells', () => {
    const result = resolveContracts(
      [
        row({
          symbol: 'AAPL',
          assetType: 'option',
          expiry: '2026-03-20',
          strike: '250',
          right: 'call',
        }),
      ],
      opts('composed'),
    );
    expect(result.errors).toEqual([]);
    expect(result.rows[0].values.symbol).toBe(expected);
  });

  it('upper-cases a lowercase occ-symbol before parsing', () => {
    const result = resolveContracts(
      [row({ symbol: 'aapl260320c250', assetType: 'option' })],
      opts('occ-symbol'),
    );
    expect(result.errors).toEqual([]);
    expect(result.rows[0].values.symbol).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// resolveContracts — the descriptor path and its warning
// ---------------------------------------------------------------------------

describe('resolveContracts — descriptor form', () => {
  it('encodes a monthly descriptor and emits a derived_expiry warning', () => {
    const result = resolveContracts(
      [row({ symbol: 'SPY', assetType: 'option', descriptor: 'JAN 12 125 CALL' })],
      opts('descriptor'),
    );
    expect(result.errors).toEqual([]);
    expect(result.rows[0].values.symbol).toBe('SPY120120C125');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      rowNumber: 2,
      csvColumn: 'Description',
      kind: 'derived_expiry',
    });
    expect(result.warnings[0].message).toContain('2012-01-20');
  });

  it('surfaces the encoder OCC_DATE_RANGE for a JAN 55 (2055) descriptor', () => {
    const result = resolveContracts(
      [row({ symbol: 'SPY', assetType: 'option', descriptor: 'JAN 55 125 CALL' })],
      opts('descriptor'),
    );
    expect(result.rows).toEqual([]);
    const err = findError(result.errors, 'OCC_DATE_RANGE');
    expect(err).toMatchObject({ rowNumber: 2, tradrField: 'descriptor', csvColumn: 'Description' });
  });
});

// ---------------------------------------------------------------------------
// resolveContracts — every located-error code (Data Models table)
// ---------------------------------------------------------------------------

describe('resolveContracts — located error codes', () => {
  it('CONTRACT_FORM_MISSING when an option row has no contract form', () => {
    const result = resolveContracts(
      [row({ symbol: 'AAPL', assetType: 'option' })],
      opts(undefined),
    );
    expect(result.rows).toEqual([]);
    const err = findError(result.errors, 'CONTRACT_FORM_MISSING');
    expect(err).toMatchObject({ rowNumber: 2, tradrField: 'symbol', csvColumn: 'Symbol' });
    expect(err.message).toContain('Row 2');
  });

  it('CONTRACT_FIELD_MISSING once per missing composed cell (all three)', () => {
    const result = resolveContracts(
      [row({ symbol: 'AAPL', assetType: 'option' })],
      opts('composed'),
    );
    expect(result.rows).toEqual([]);
    const missing = result.errors.filter((e) => e.code === 'CONTRACT_FIELD_MISSING');
    expect(missing.map((e) => e.tradrField).sort()).toEqual(['expiry', 'right', 'strike']);
    expect(missing.map((e) => e.csvColumn).sort()).toEqual(['Expiry', 'Right', 'Strike']);
  });

  it('CONTRACT_FIELD_ON_STOCK when a stock row carries a composed cell', () => {
    const result = resolveContracts(
      [row({ symbol: 'AAPL', assetType: 'stock', expiry: '2026-03-20' })],
      opts('composed'),
    );
    expect(result.rows).toEqual([]);
    const err = findError(result.errors, 'CONTRACT_FIELD_ON_STOCK');
    expect(err).toMatchObject({ rowNumber: 2, tradrField: 'expiry', csvColumn: 'Expiry' });
    expect(err.message).toContain('2026-03-20');
  });

  it('CONTRACT_DESCRIPTOR_UNPARSEABLE names the offending descriptor', () => {
    const result = resolveContracts(
      [row({ symbol: 'AAPL', assetType: 'option', descriptor: 'JAN 12 CALL' })],
      opts('descriptor'),
    );
    expect(result.rows).toEqual([]);
    const err = findError(result.errors, 'CONTRACT_DESCRIPTOR_UNPARSEABLE');
    expect(err).toMatchObject({ rowNumber: 2, tradrField: 'descriptor', csvColumn: 'Description' });
    expect(err.message).toContain('JAN 12 CALL');
  });

  it('OPTION_MULTIPLIER_UNSUPPORTED via a multiplier column of 10', () => {
    const result = resolveContracts(
      [row({ symbol: 'AAPL260320C250', assetType: 'option', multiplier: '10' })],
      opts('occ-symbol'),
    );
    expect(result.rows).toEqual([]);
    const err = findError(result.errors, 'OPTION_MULTIPLIER_UNSUPPORTED');
    expect(err).toMatchObject({ rowNumber: 2, tradrField: 'multiplier', csvColumn: 'Multiplier' });
    expect(err.message).toContain('10');
  });

  it('OPTION_MULTIPLIER_UNSUPPORTED via a mini descriptor', () => {
    const result = resolveContracts(
      [row({ symbol: 'AAPL', assetType: 'option', descriptor: 'APR26 13 375 PUT M' })],
      opts('descriptor'),
    );
    expect(result.rows).toEqual([]);
    const err = findError(result.errors, 'OPTION_MULTIPLIER_UNSUPPORTED');
    expect(err).toMatchObject({ rowNumber: 2, tradrField: 'descriptor', csvColumn: 'Description' });
  });

  it('OPTION_EVENT_NOT_SUPPORTED via an A code', () => {
    const result = resolveContracts(
      [row({ symbol: 'AAPL260320C250', assetType: 'option', eventCode: 'A' })],
      opts('occ-symbol'),
    );
    expect(result.rows).toEqual([]);
    const err = findError(result.errors, 'OPTION_EVENT_NOT_SUPPORTED');
    expect(err).toMatchObject({ rowNumber: 2, tradrField: 'eventCode', csvColumn: 'Code' });
    expect(err.message).toContain('assignment');
  });

  it('OPTION_EVENT_NOT_SUPPORTED via a semicolon-delimited O;A code', () => {
    const result = resolveContracts(
      [row({ symbol: 'AAPL260320C250', assetType: 'option', eventCode: 'O;A' })],
      opts('occ-symbol'),
    );
    const err = findError(result.errors, 'OPTION_EVENT_NOT_SUPPORTED');
    expect(err).toMatchObject({ tradrField: 'eventCode' });
  });

  it('OCC_NO_FORM_MATCH for a double-space compact string that matches no form', () => {
    const result = resolveContracts(
      [row({ symbol: 'AAPL  260320C0025000', assetType: 'option' })],
      opts('occ-symbol'),
    );
    expect(result.rows).toEqual([]);
    const err = findError(result.errors, 'OCC_NO_FORM_MATCH');
    expect(err).toMatchObject({ rowNumber: 2, tradrField: 'symbol', csvColumn: 'Symbol' });
  });

  it('OCC_BAD_UNDERLYING located to symbol when the underlying comes from symbol', () => {
    const result = resolveContracts(
      [
        row({
          symbol: '1BAD',
          assetType: 'option',
          expiry: '2026-03-20',
          strike: '250',
          right: 'call',
        }),
      ],
      opts('composed'),
    );
    const err = findError(result.errors, 'OCC_BAD_UNDERLYING');
    expect(err).toMatchObject({ rowNumber: 2, tradrField: 'symbol', csvColumn: 'Symbol' });
    expect(err.message).toContain('1BAD');
  });

  it('OCC_STRIKE_RANGE for a strike of 100000', () => {
    const result = resolveContracts(
      [
        row({
          symbol: 'AAPL',
          assetType: 'option',
          expiry: '2026-03-20',
          strike: '100000',
          right: 'call',
        }),
      ],
      opts('composed'),
    );
    const err = findError(result.errors, 'OCC_STRIKE_RANGE');
    expect(err).toMatchObject({ rowNumber: 2, tradrField: 'strike', csvColumn: 'Strike' });
    expect(err.message).toContain('100000');
  });

  it('OCC_STRIKE_PRECISION for a strike of 0.0001', () => {
    const result = resolveContracts(
      [
        row({
          symbol: 'AAPL',
          assetType: 'option',
          expiry: '2026-03-20',
          strike: '0.0001',
          right: 'call',
        }),
      ],
      opts('composed'),
    );
    const err = findError(result.errors, 'OCC_STRIKE_PRECISION');
    expect(err).toMatchObject({ rowNumber: 2, tradrField: 'strike', csvColumn: 'Strike' });
    expect(err.message).toContain('0.0001');
  });

  it('OCC_STRIKE_NOT_REPRESENTABLE for a strike of 1234.567', () => {
    const result = resolveContracts(
      [
        row({
          symbol: 'AAPL',
          assetType: 'option',
          expiry: '2026-03-20',
          strike: '1234.567',
          right: 'call',
        }),
      ],
      opts('composed'),
    );
    const err = findError(result.errors, 'OCC_STRIKE_NOT_REPRESENTABLE');
    expect(err).toMatchObject({ rowNumber: 2, tradrField: 'strike', csvColumn: 'Strike' });
    expect(err.message).toContain('1234.567');
  });

  it('OCC_DATE_RANGE for a composed expiry beyond 2049', () => {
    const result = resolveContracts(
      [
        row({
          symbol: 'SPY',
          assetType: 'option',
          expiry: '2055-01-15',
          strike: '125',
          right: 'call',
        }),
      ],
      opts('composed'),
    );
    const err = findError(result.errors, 'OCC_DATE_RANGE');
    expect(err).toMatchObject({ rowNumber: 2, tradrField: 'expiry', csvColumn: 'Expiry' });
    expect(err.message).toContain('2055-01-15');
  });

  it('OCC_COMPACT_TOO_LONG for a 6-char underlying with a high-precision strike', () => {
    const result = resolveContracts(
      [
        row({
          symbol: 'ABCDEF',
          assetType: 'option',
          expiry: '2026-03-20',
          strike: '12345.678',
          right: 'call',
        }),
      ],
      opts('composed'),
    );
    const err = findError(result.errors, 'OCC_COMPACT_TOO_LONG');
    expect(err).toMatchObject({ rowNumber: 2, tradrField: 'symbol', csvColumn: 'Symbol' });
  });
});

// ---------------------------------------------------------------------------
// resolveContracts — scoping and pass-through
// ---------------------------------------------------------------------------

describe('resolveContracts — stock rows', () => {
  it('ignores a multiplier of 1 and an A code on a stock row', () => {
    const stock = row({ symbol: 'AAPL', assetType: 'stock', multiplier: '1', eventCode: 'A' });
    const result = resolveContracts([stock], opts('composed'));
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([stock]);
  });

  it('passes a stock row through unchanged under occ-symbol', () => {
    const stock = row({ symbol: 'AAPL', assetType: 'stock' });
    const result = resolveContracts([stock], opts('occ-symbol'));
    expect(result.rows[0].values.symbol).toBe('AAPL');
    expect(result.errors).toEqual([]);
  });
});

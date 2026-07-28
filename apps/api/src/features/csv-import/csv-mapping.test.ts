import { describe, expect, it } from 'vitest';

import type { Mapping } from '@tradr/shared';

import { applyMapping, validateMappingShape } from './csv-mapping';
import type { ParsedCsv } from './csv-parse';

/** A minimal complete execution mapping over the canonical column names. */
const execMapping = (overrides: Partial<Mapping> = {}): Mapping => ({
  rowShape: 'execution',
  columns: {
    symbol: 'Symbol',
    assetType: 'AssetType',
    action: 'Action',
    quantity: 'Quantity',
    price: 'Price',
    filledAt: 'FilledAt',
  },
  ...overrides,
});

/**
 * A manually-constructed round-trip mapping — no round-trip preset ships
 * (deferral d-b394aea7), so the round-trip required-field path is exercised
 * via this fixture, not a preset.
 */
const roundTripMapping = (overrides: Partial<Mapping> = {}): Mapping => ({
  rowShape: 'round-trip',
  columns: {
    symbol: 'Symbol',
    assetType: 'AssetType',
    side: 'Side',
    entryPrice: 'EntryPrice',
    entryQuantity: 'EntryQty',
    entryDate: 'EntryDate',
    exitPrice: 'ExitPrice',
    exitQuantity: 'ExitQty',
    exitDate: 'ExitDate',
  },
  ...overrides,
});

const parsed = (headers: string[], rows: string[][]): ParsedCsv => ({
  headers,
  rows,
  rowCount: rows.length,
});

describe('validateMappingShape', () => {
  it('accepts a complete execution mapping', () => {
    const headers = ['Symbol', 'AssetType', 'Action', 'Quantity', 'Price', 'FilledAt'];
    expect(validateMappingShape(headers, execMapping())).toEqual([]);
  });

  it('reports a missing required field before any row processing (REQ-2.4)', () => {
    const m = execMapping();
    delete m.columns.price;
    const errors = validateMappingShape(
      ['Symbol', 'AssetType', 'Action', 'Quantity', 'FilledAt'],
      m,
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ code: 'MAPPING_FIELD_MISSING', tradrField: 'price' }),
    );
  });

  it('requires exactly one of type|action for execution (neither)', () => {
    const m = execMapping();
    delete m.columns.action;
    const errors = validateMappingShape(
      ['Symbol', 'AssetType', 'Quantity', 'Price', 'FilledAt'],
      m,
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ code: 'MAPPING_TYPE_OR_ACTION_REQUIRED' }),
    );
  });

  it('rejects both type and action for execution', () => {
    const m = execMapping({
      columns: { ...execMapping().columns, type: 'Type' },
    });
    const errors = validateMappingShape(
      ['Symbol', 'AssetType', 'Action', 'Type', 'Quantity', 'Price', 'FilledAt'],
      m,
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ code: 'MAPPING_TYPE_OR_ACTION_EXCLUSIVE' }),
    );
  });

  it('reports a field mapped to an absent column (REQ-2.4)', () => {
    const m = execMapping();
    const errors = validateMappingShape(
      ['Symbol', 'AssetType', 'Action', 'Quantity', 'Price'], // FilledAt absent
      m,
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        code: 'MAPPING_COLUMN_ABSENT',
        tradrField: 'filledAt',
        csvColumn: 'FilledAt',
      }),
    );
  });

  it('accepts a complete round-trip mapping (manual fixture, no preset ships)', () => {
    const headers = [
      'Symbol',
      'AssetType',
      'Side',
      'EntryPrice',
      'EntryQty',
      'EntryDate',
      'ExitPrice',
      'ExitQty',
      'ExitDate',
    ];
    expect(validateMappingShape(headers, roundTripMapping())).toEqual([]);
  });

  it('reports the round-trip required-field set when a group is unmapped', () => {
    const m = roundTripMapping();
    delete m.columns.exitDate;
    delete m.columns.exitPrice;
    const headers = [
      'Symbol',
      'AssetType',
      'Side',
      'EntryPrice',
      'EntryQty',
      'EntryDate',
      'ExitQty',
    ];
    const errors = validateMappingShape(headers, m);
    expect(errors).toContainEqual(
      expect.objectContaining({ code: 'MAPPING_FIELD_MISSING', tradrField: 'exitDate' }),
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ code: 'MAPPING_FIELD_MISSING', tradrField: 'exitPrice' }),
    );
  });
});

describe('applyMapping transforms', () => {
  it('canonicalizes side (case-insensitive, trimmed)', () => {
    const m: Mapping = { rowShape: 'execution', columns: { side: 'Side' } };
    const p = parsed(['Side'], [['  buy '], ['SELL'], ['L'], ['Sh']]);
    const { rows } = applyMapping(p, m);
    expect(rows.map((r) => r.values.side)).toEqual(['long', 'short', 'long', 'short']);
  });

  it('canonicalizes assetType', () => {
    const m: Mapping = { rowShape: 'execution', columns: { assetType: 'AT' } };
    const p = parsed(['AT'], [['stk'], ['Shares'], ['opt'], ['OPTION']]);
    const { rows } = applyMapping(p, m);
    expect(rows.map((r) => r.values.assetType)).toEqual(['stock', 'stock', 'option', 'option']);
  });

  it('canonicalizes type', () => {
    const m: Mapping = { rowShape: 'execution', columns: { type: 'T' } };
    const p = parsed(['T'], [['open'], ['Entry'], ['CLOSE'], ['exit']]);
    const { rows } = applyMapping(p, m);
    expect(rows.map((r) => r.values.type)).toEqual(['entry', 'entry', 'exit', 'exit']);
  });

  it('canonicalizes action', () => {
    const m: Mapping = { rowShape: 'execution', columns: { action: 'A' } };
    const p = parsed(['A'], [['bot'], ['BUY'], ['SLD'], ['sell']]);
    const { rows } = applyMapping(p, m);
    expect(rows.map((r) => r.values.action)).toEqual(['buy', 'buy', 'sell', 'sell']);
  });

  it('reports a located cell error for an unmatched enum value, never coercing it', () => {
    const m: Mapping = { rowShape: 'execution', columns: { side: 'Side' } };
    const p = parsed(['Side'], [['sideways']]);
    const { rows, errors } = applyMapping(p, m);
    expect(errors).toContainEqual(
      expect.objectContaining({
        code: 'TRANSFORM_NO_MATCH',
        rowNumber: 2,
        tradrField: 'side',
        csvColumn: 'Side',
      }),
    );
    expect(rows[0].values.side).toBeUndefined();
  });

  it('merges preset-declared synonyms onto the canonical map', () => {
    const m: Mapping = {
      rowShape: 'execution',
      columns: { side: 'Side' },
      transforms: { side: { kaufen: 'long', verkaufen: 'short' } },
    };
    const p = parsed(['Side'], [['Kaufen'], ['VERKAUFEN'], ['buy']]);
    const { rows, errors } = applyMapping(p, m);
    // No TRANSFORM_NO_MATCH errors — the declared synonyms resolve.
    expect(errors.some((e) => e.code === 'TRANSFORM_NO_MATCH')).toBe(false);
    expect(rows.map((r) => r.values.side)).toEqual(['long', 'short', 'long']);
  });
});

describe('applyMapping row conformance', () => {
  it('maps a complete execution row positionally', () => {
    const m = execMapping();
    const headers = ['Symbol', 'AssetType', 'Action', 'Quantity', 'Price', 'FilledAt'];
    const p = parsed(headers, [['AAPL', 'STK', 'BUY', '10', '150.00', '2024-01-02']]);
    const { rows, errors } = applyMapping(p, m);
    expect(errors).toEqual([]);
    expect(rows[0]).toEqual({
      sourceRow: 2,
      values: {
        symbol: 'AAPL',
        assetType: 'stock',
        action: 'buy',
        quantity: '10',
        price: '150.00',
        filledAt: '2024-01-02',
      },
    });
  });

  it('reports a non-conforming execution row (blank required cell) (REQ-2.7)', () => {
    const m = execMapping();
    const headers = ['Symbol', 'AssetType', 'Action', 'Quantity', 'Price', 'FilledAt'];
    // Row 1 ok, row 2 has a blank price.
    const p = parsed(headers, [
      ['AAPL', 'STK', 'BUY', '10', '150', '2024-01-02'],
      ['AAPL', 'STK', 'BUY', '10', '', '2024-01-03'],
    ]);
    const { errors } = applyMapping(p, m);
    expect(errors).toContainEqual(
      expect.objectContaining({
        code: 'ROW_MISSING_REQUIRED_FIELD',
        rowNumber: 3,
        tradrField: 'price',
      }),
    );
  });

  it('reports a non-conforming round-trip row (blank exit group) (REQ-2.7)', () => {
    const m = roundTripMapping();
    const headers = [
      'Symbol',
      'AssetType',
      'Side',
      'EntryPrice',
      'EntryQty',
      'EntryDate',
      'ExitPrice',
      'ExitQty',
      'ExitDate',
    ];
    const p = parsed(headers, [
      // Populated entry group, blank exit group -> located row errors, not coerced.
      ['AAPL', 'STK', 'BUY', '150', '10', '2024-01-02', '', '', ''],
    ]);
    const { errors } = applyMapping(p, m);
    for (const field of ['exitPrice', 'exitQuantity', 'exitDate']) {
      expect(errors).toContainEqual(
        expect.objectContaining({
          code: 'ROW_MISSING_REQUIRED_FIELD',
          rowNumber: 2,
          tradrField: field,
        }),
      );
    }
  });

  it('processes a complete round-trip row without errors', () => {
    const m = roundTripMapping();
    const headers = [
      'Symbol',
      'AssetType',
      'Side',
      'EntryPrice',
      'EntryQty',
      'EntryDate',
      'ExitPrice',
      'ExitQty',
      'ExitDate',
    ];
    const p = parsed(headers, [
      ['AAPL', 'STK', 'BUY', '150', '10', '2024-01-02', '160', '10', '2024-01-05'],
    ]);
    const { rows, errors } = applyMapping(p, m);
    expect(errors).toEqual([]);
    expect(rows[0].values).toMatchObject({
      symbol: 'AAPL',
      assetType: 'stock',
      side: 'long',
      entryPrice: '150',
      exitDate: '2024-01-05',
    });
  });
});

import { describe, it, expect } from 'vitest';

import type { CsvPreviewRequest, Mapping } from '@tradr/shared';

import { parseCsv, type ParsedCsv } from './csv-parse';
import { runPipeline } from './csv-pipeline';

// ---------------------------------------------------------------------------
// Pure pipeline tests (design Component 5, seam 2). runPipeline is DB-free — it
// composes the pure leaf modules, so these unit tests call it directly with a
// parsed CSV and a request literal; no Postgres, no `previewImport`.
// ---------------------------------------------------------------------------

function parse(csv: string): ParsedCsv {
  return parseCsv(new TextEncoder().encode(csv));
}

/** Standard execution-shape columns (matches the service/route test helpers). */
const EXEC_COLUMNS: Record<string, string> = {
  symbol: 'Symbol',
  assetType: 'Type',
  action: 'Side',
  price: 'Price',
  quantity: 'Quantity',
  filledAt: 'Date',
  fees: 'Fees',
};

function request(mapping: Mapping, top: Partial<CsvPreviewRequest> = {}): CsvPreviewRequest {
  return {
    accountId: '00000000-0000-0000-0000-000000000000',
    rowShape: mapping.rowShape,
    mapping,
    timezone: 'UTC',
    dateFormat: 'iso',
    numberFormat: 'us',
    ...top,
  };
}

describe('runPipeline — option contracts', () => {
  it('previews a valid option row as a committable, closed option position', () => {
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      'AAPL260320C250,OPTION,BUY,1.75,1,2026-01-05,0.65',
      'AAPL260320C250,OPTION,SELL,2.25,1,2026-01-06,0.65',
    ].join('\n');

    const result = runPipeline(
      parse(csv),
      request({ rowShape: 'execution', columns: EXEC_COLUMNS, contractForm: 'occ-symbol' }),
      'USD',
    );

    expect(result.errors).toHaveLength(0);
    expect(result.proposedPositions).toHaveLength(1);
    const [pos] = result.proposedPositions;
    expect(pos.scope.symbol).toBe('AAPL260320C250');
    expect(pos.scope.assetType).toBe('option');
    expect(pos.closes).toBe(true);
    // (2.25 − 1.75) × 1 × 100 − 0.65 − 0.65.
    expect(pos.proposedPnl).toBeCloseTo(48.7, 2);
  });

  it('previews a mixed stock + option file as two positions', () => {
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      'AAPL,STOCK,BUY,100,10,2026-01-01,0',
      'AAPL,STOCK,SELL,110,10,2026-01-02,0',
      'AAPL260320C250,OPTION,BUY,1.75,1,2026-01-05,0.65',
      'AAPL260320C250,OPTION,SELL,2.25,1,2026-01-06,0.65',
    ].join('\n');

    const result = runPipeline(
      parse(csv),
      request({ rowShape: 'execution', columns: EXEC_COLUMNS, contractForm: 'occ-symbol' }),
      'USD',
    );

    expect(result.errors).toHaveLength(0);
    expect(result.proposedPositions).toHaveLength(2);
    const assetTypes = result.proposedPositions.map((p) => p.scope.assetType).sort();
    expect(assetTypes).toEqual(['option', 'stock']);
  });

  it('computes REQ-1.6 long option P&L (+50) with no fees column', () => {
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date',
      'AAPL260320C250,OPTION,BUY,1.75,1,2026-01-05',
      'AAPL260320C250,OPTION,SELL,2.25,1,2026-01-06',
    ].join('\n');

    const columns: Record<string, string> = {
      symbol: 'Symbol',
      assetType: 'Type',
      action: 'Side',
      price: 'Price',
      quantity: 'Quantity',
      filledAt: 'Date',
    };
    const result = runPipeline(
      parse(csv),
      request({ rowShape: 'execution', columns, contractForm: 'occ-symbol' }),
      'USD',
    );

    expect(result.proposedPositions).toHaveLength(1);
    const [pos] = result.proposedPositions;
    expect(pos.side).toBe('long');
    expect(pos.proposedPnl).toBeCloseTo(50, 2);
  });

  it('computes REQ-1.7 short option P&L (+50) when the sell opens', () => {
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date',
      'AAPL260320C250,OPTION,SELL,2.25,1,2026-01-05',
      'AAPL260320C250,OPTION,BUY,1.75,1,2026-01-06',
    ].join('\n');

    const columns: Record<string, string> = {
      symbol: 'Symbol',
      assetType: 'Type',
      action: 'Side',
      price: 'Price',
      quantity: 'Quantity',
      filledAt: 'Date',
    };
    const result = runPipeline(
      parse(csv),
      request({ rowShape: 'execution', columns, contractForm: 'occ-symbol' }),
      'USD',
    );

    expect(result.proposedPositions).toHaveLength(1);
    const [pos] = result.proposedPositions;
    expect(pos.side).toBe('short');
    expect(pos.closes).toBe(true);
    expect(pos.proposedPnl).toBeCloseTo(50, 2);
  });

  it('resolves a round-trip option row to one closed position with two fills (REQ-2.7)', () => {
    const csv = [
      'Symbol,Type,Side,EntryPrice,EntryQty,EntryDate,ExitPrice,ExitQty,ExitDate',
      'AAPL260320C250,OPTION,BUY,1.75,1,2026-01-05,2.25,1,2026-01-06',
    ].join('\n');

    const columns: Record<string, string> = {
      symbol: 'Symbol',
      assetType: 'Type',
      side: 'Side',
      entryPrice: 'EntryPrice',
      entryQuantity: 'EntryQty',
      entryDate: 'EntryDate',
      exitPrice: 'ExitPrice',
      exitQuantity: 'ExitQty',
      exitDate: 'ExitDate',
    };
    const result = runPipeline(
      parse(csv),
      request({ rowShape: 'round-trip', columns, contractForm: 'occ-symbol' }),
      'USD',
    );

    expect(result.errors).toHaveLength(0);
    expect(result.proposedPositions).toHaveLength(1);
    const [pos] = result.proposedPositions;
    expect(pos.scope.symbol).toBe('AAPL260320C250');
    expect(pos.scope.assetType).toBe('option');
    expect(pos.closes).toBe(true);
    expect(pos.fills).toHaveLength(2);
  });
});

describe('runPipeline — mapping-errored rows are excluded (Error Handling 16)', () => {
  it('excludes a row with an empty required Symbol without crashing, keeping the others', () => {
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      'AAPL,STOCK,BUY,100,10,2026-01-01,0',
      'AAPL,STOCK,SELL,110,10,2026-01-02,0',
      ',STOCK,BUY,5,1,2026-01-03,0',
    ].join('\n');

    const result = runPipeline(
      parse(csv),
      request({ rowShape: 'execution', columns: EXEC_COLUMNS }),
      'USD',
    );

    // The empty-Symbol row (source row 4) is a located mapping error…
    expect(
      result.errors.some((e) => e.code === 'ROW_MISSING_REQUIRED_FIELD' && e.rowNumber === 4),
    ).toBe(true);
    // …and it produces no position, but the valid AAPL pair still does.
    expect(result.proposedPositions).toHaveLength(1);
    expect(result.proposedPositions[0].scope.symbol).toBe('AAPL');
  });

  it('excludes a row whose optional side cell fails to transform (no position)', () => {
    const csv = [
      'Symbol,Type,Action,Side,Price,Quantity,Date',
      'MSFT,STOCK,BUY,BOGUS,50,5,2026-01-03',
    ].join('\n');

    const columns: Record<string, string> = {
      symbol: 'Symbol',
      assetType: 'Type',
      action: 'Action',
      side: 'Side',
      price: 'Price',
      quantity: 'Quantity',
      filledAt: 'Date',
    };
    const result = runPipeline(parse(csv), request({ rowShape: 'execution', columns }), 'USD');

    expect(result.errors.some((e) => e.code === 'TRANSFORM_NO_MATCH')).toBe(true);
    // Today an unmatched optional cell previews a non-committable position; the
    // exclusion drops the whole row instead (the one benign behaviour change).
    expect(result.proposedPositions).toHaveLength(0);
  });

  it('reports mapping-shape errors at row 0 and still runs', () => {
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      'AAPL,STOCK,BUY,100,10,2026-01-01,0',
    ].join('\n');

    // Drop the required `filledAt` mapping → a MAPPING_FIELD_MISSING at row 0.
    const columns: Record<string, string> = {
      symbol: 'Symbol',
      assetType: 'Type',
      action: 'Side',
      price: 'Price',
      quantity: 'Quantity',
      fees: 'Fees',
    };
    const result = runPipeline(parse(csv), request({ rowShape: 'execution', columns }), 'USD');

    expect(result.errors.some((e) => e.rowNumber === 0 && e.code === 'MAPPING_FIELD_MISSING')).toBe(
      true,
    );
    expect(result.proposedPositions).toHaveLength(0);
  });
});

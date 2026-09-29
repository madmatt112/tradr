import { describe, expect, it } from 'vitest';

import { CSV_IMPORT_PRESETS, type CsvPreviewRequest } from '@tradr/shared';
import {
  CSV_IMPORT_SAMPLE_FILES,
  readCsvImportSample,
} from '@tradr/shared/node/csv-import-samples';

import { parseCsv } from './csv-parse';
import { runPipeline } from './csv-pipeline';

/**
 * Preset conformance (design Component 8, REQ-3.3 / REQ-7.2 / REQ-7.3): every
 * named preset's committed sample runs the service's own pure
 * pipeline (`runPipeline`) with its expected errors and the expected proposed
 * positions, symbols and P&L. The test imports neither `@/db` nor `@/app` — the
 * pipeline is DB-free.
 *
 * Datetimes in the Flex-shaped samples are offset-less (the `d-7c9626bb` seam:
 * `Date.parse` reads them in the process timezone), so the whole apps/api suite
 * is pinned to `TZ=UTC` (vitest.workspace.ts, apps/api/vitest.config.ts). The
 * guard below is the first assertion so a dropped or overridden pin fails by
 * name rather than as a mysterious segment-order diff.
 */

interface ExpectedPosition {
  symbol: string;
  assetType: 'stock' | 'option';
  side: 'long' | 'short';
  closes: boolean;
  /** Closed positions: realized P&L. */
  proposedPnl?: number;
  /** Open positions: the single fill's quantity. */
  quantity?: number;
}

// Roster clause (REQ-3.3): at least one `occ-symbol` position (IBKR + generic)
// and one `composed` position (TradeZella) are pinned by symbol below.
const EXPECTED: Record<string, ExpectedPosition[]> = {
  'interactive-brokers': [
    { symbol: 'AAPL', assetType: 'stock', side: 'long', closes: true, proposedPnl: 158 },
    {
      symbol: 'AAPL120121C400',
      assetType: 'option',
      side: 'long',
      closes: true,
      proposedPnl: 48.7,
    },
  ],
  tradezella: [
    { symbol: 'SPY', assetType: 'stock', side: 'long', closes: true, proposedPnl: 158 },
    {
      symbol: 'AAPL120121C400',
      assetType: 'option',
      side: 'long',
      closes: true,
      proposedPnl: 48.7,
    },
  ],
  tradervue: [
    // Row 2: the day-less monthly descriptor `JAN 12 125 CALL` derives to
    // SPY120120C125, an open long single contract, with a derived_expiry warning.
    { symbol: 'SPY120120C125', assetType: 'option', side: 'long', closes: false, quantity: 1 },
    // Row 3: an unmatched sell → a residual open short of 100 (as today).
    { symbol: 'SPY', assetType: 'stock', side: 'short', closes: false, quantity: 100 },
  ],
  'generic-execution': [
    { symbol: 'SPY', assetType: 'stock', side: 'long', closes: true, proposedPnl: 158 },
    {
      symbol: 'AAPL120121C400',
      assetType: 'option',
      side: 'long',
      closes: true,
      proposedPnl: 48.7,
    },
  ],
  // tastytrade (task 9): each position has its own symbol (Decision D6, Req 3.1)
  // — a closed stock round trip, a closed option round trip, the same-instant
  // short option (its closing row first in file order, so it segments `short`
  // only because positionEffect sets an explicit `type` that openRank reads
  // before `action`), and the open stock residual. The Future trade row refuses
  // (see EXPECTED_ERRORS) and imports no position.
  tastytrade: [
    { symbol: 'AAPL', assetType: 'stock', side: 'long', closes: true, proposedPnl: 798.86 },
    {
      symbol: 'AAPL180720C195',
      assetType: 'option',
      side: 'long',
      closes: true,
      proposedPnl: 57.86,
    },
    {
      symbol: 'SPY180921P250',
      assetType: 'option',
      side: 'short',
      closes: true,
      proposedPnl: 598.9,
    },
    { symbol: 'MSFT', assetType: 'stock', side: 'long', closes: false, quantity: 50 },
  ],
};

// Declared refusals per preset (REQ-3.6): a sample that legitimately errors on
// a row registers `{ code, rowNumber }` here. The loop compares against this
// order-independently, defaulting to none, so every shipped sample still
// asserts an empty error set.
const EXPECTED_ERRORS: Record<string, Array<{ code: string; rowNumber: number }>> = {
  // The tastytrade fixture's file row 11 is a `Trade` with Instrument Type
  // `Future`, which matches no assetType transform: applyMapping pushes
  // TRANSFORM_NO_MATCH on the unstored cell, and assetType being a required
  // execution field then adds ROW_MISSING_REQUIRED_FIELD on the same row
  // (design Error Handling #2, D6). Both block commit.
  tastytrade: [
    { code: 'TRANSFORM_NO_MATCH', rowNumber: 11 },
    { code: 'ROW_MISSING_REQUIRED_FIELD', rowNumber: 11 },
  ],
};

describe('csv-import preset conformance', () => {
  it('TZ pin is in force (offset-less ISO parses as UTC)', () => {
    expect(
      new Date('2012-01-05T09:30:00').toISOString(),
      'TZ=UTC pin missing — set TZ in the api vitest env / e2e apiEnv (csv-import-options, d-7c9626bb)',
    ).toBe('2012-01-05T09:30:00.000Z');
  });

  for (const id of Object.keys(CSV_IMPORT_SAMPLE_FILES)) {
    it(`${id}: sample previews through runPipeline with its expected errors and the expected positions`, () => {
      const preset = CSV_IMPORT_PRESETS.find((p) => p.id === id);
      expect(preset, `no preset for sample id "${id}"`).toBeDefined();
      if (!preset) return;

      const request: CsvPreviewRequest = {
        accountId: '00000000-0000-0000-0000-000000000000',
        rowShape: preset.rowShape,
        mapping: preset.mapping,
        presetId: preset.id,
        timezone: 'UTC',
        dateFormat: preset.dateFormat,
        numberFormat: preset.numberFormat,
      };

      // Parse with the delimiter/hasHeader the service reads off the mapping
      // (csv-import.service.ts:189-192) — both undefined for every shipped
      // preset, so comma + header, keeping the "same code path" claim honest.
      const parsed = parseCsv(readCsvImportSample(id), {
        delimiter: preset.mapping.delimiter,
        hasHeader: preset.mapping.hasHeader,
      });
      const result = runPipeline(parsed, request, 'USD');

      // Order-independent compare of each error's code and row number against
      // the preset's declared refusals (default none).
      const byCodeThenRow = (
        a: { code: string; rowNumber: number },
        b: { code: string; rowNumber: number },
      ) => a.code.localeCompare(b.code) || a.rowNumber - b.rowNumber;
      expect(
        result.errors.map((e) => ({ code: e.code, rowNumber: e.rowNumber })).sort(byCodeThenRow),
      ).toEqual([...(EXPECTED_ERRORS[id] ?? [])].sort(byCodeThenRow));

      const expectedPositions = EXPECTED[id];
      expect(expectedPositions, `no expected positions for sample id "${id}"`).toBeDefined();
      expect(result.proposedPositions).toHaveLength(expectedPositions.length);

      for (const exp of expectedPositions) {
        const pos = result.proposedPositions.find((p) => p.scope.symbol === exp.symbol);
        expect(pos, `expected a proposed position for ${exp.symbol}`).toBeDefined();
        if (!pos) continue;
        expect(pos.scope.assetType).toBe(exp.assetType);
        expect(pos.side).toBe(exp.side);
        expect(pos.closes).toBe(exp.closes);
        if (exp.proposedPnl !== undefined) {
          expect(pos.proposedPnl).toBe(exp.proposedPnl);
        }
        if (exp.quantity !== undefined) {
          expect(pos.fills).toHaveLength(1);
          expect(Number(pos.fills[0].quantity)).toBe(exp.quantity);
        }
      }

      if (id === 'tradervue') {
        // Exactly one warning — the derived-expiry note on the descriptor row;
        // nothing about collision with an OCC-form re-import (REQ-3.3's carve).
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toMatchObject({
          rowNumber: 2,
          csvColumn: 'Option',
          kind: 'derived_expiry',
        });
      }

      if (id === 'tastytrade') {
        // The two Money Movement rows are skipped before mapping and reported as
        // one file-level rows_skipped warning (design C8/D9); it is the only
        // warning (no rounding, no derived expiry, no direction inferred).
        expect(result.rowsSkipped).toBe(2);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toMatchObject({
          kind: 'rows_skipped',
          csvColumn: 'Type',
          message: 'Skipped 2 rows whose Type is not Trade: Money Movement (2).',
        });

        // Fees (Commissions plus Fees, in magnitude) and filledAt of each fill of
        // both round trips (Req 3.2). The stock round trip's opening row carries
        // Commissions -1 and Fees -0.14 (summed to 1.14); its close carries none.
        const stock = result.proposedPositions.find((p) => p.scope.symbol === 'AAPL');
        expect(stock?.fills.map((f) => [f.fees, f.filledAt])).toEqual([
          ['1.14', '2018-05-21T15:55:20.000Z'],
          ['0', '2018-05-22T14:30:00.000Z'],
        ]);
        // The option round trip: the option price cell is a per-contract premium
        // (÷100 to per share), and the fees still sum from the two cost columns.
        const option = result.proposedPositions.find((p) => p.scope.symbol === 'AAPL180720C195');
        expect(option?.fills.map((f) => [f.fees, f.filledAt])).toEqual([
          ['1.14', '2018-06-11T13:31:00.000Z'],
          ['0', '2018-06-12T19:50:00.000Z'],
        ]);
      }
    });
  }

  // AC 3.5 (tastytrade): a mapping resolves columns by name, so reordering the
  // header and every row's cells together proposes the same positions; removing a
  // mapped column reports MAPPING_COLUMN_ABSENT naming the field and the column.
  it('tastytrade: reordered columns propose the same positions, a removed mapped column refuses', () => {
    const preset = CSV_IMPORT_PRESETS.find((p) => p.id === 'tastytrade');
    expect(preset).toBeDefined();
    if (!preset) return;

    const request: CsvPreviewRequest = {
      accountId: '00000000-0000-0000-0000-000000000000',
      rowShape: preset.rowShape,
      mapping: preset.mapping,
      presetId: preset.id,
      timezone: 'UTC',
      dateFormat: preset.dateFormat,
      numberFormat: preset.numberFormat,
    };
    const parsed = parseCsv(readCsvImportSample('tastytrade'), {
      delimiter: preset.mapping.delimiter,
      hasHeader: preset.mapping.hasHeader,
    });

    // Reverse is a full permutation of the columns; move the header and each
    // row's cells together so only column order changes, not row order.
    const perm = [...parsed.headers.keys()].reverse();
    const permuted = {
      headers: perm.map((i) => parsed.headers[i]),
      rows: parsed.rows.map((r) => perm.map((i) => r[i])),
      rowCount: parsed.rowCount,
    };
    const permResult = runPipeline(permuted, request, 'USD');
    expect(permResult.proposedPositions.map((p) => p.scope.symbol).sort()).toEqual(
      ['AAPL', 'AAPL180720C195', 'MSFT', 'SPY180921P250'].sort(),
    );
    const byCodeThenRow = (
      a: { code: string; rowNumber: number },
      b: { code: string; rowNumber: number },
    ) => a.code.localeCompare(b.code) || a.rowNumber - b.rowNumber;
    expect(
      permResult.errors.map((e) => ({ code: e.code, rowNumber: e.rowNumber })).sort(byCodeThenRow),
    ).toEqual([...EXPECTED_ERRORS.tastytrade].sort(byCodeThenRow));

    // Remove the mapped `Commissions` column: fees is mapped to it, so the
    // shape check refuses at row 0 naming the field and the column.
    const dropIdx = parsed.headers.indexOf('Commissions');
    const dropped = {
      headers: parsed.headers.filter((_, i) => i !== dropIdx),
      rows: parsed.rows.map((r) => r.filter((_, i) => i !== dropIdx)),
      rowCount: parsed.rowCount,
    };
    const dropResult = runPipeline(dropped, request, 'USD');
    expect(dropResult.errors).toContainEqual(
      expect.objectContaining({
        code: 'MAPPING_COLUMN_ABSENT',
        tradrField: 'fees',
        csvColumn: 'Commissions',
        rowNumber: 0,
      }),
    );
  });
});

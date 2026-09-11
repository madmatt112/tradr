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
 * named preset's committed real-export sample runs the service's own pure
 * pipeline (`runPipeline`) with zero errors and the expected proposed
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
};

describe('csv-import preset conformance', () => {
  it('TZ pin is in force (offset-less ISO parses as UTC)', () => {
    expect(
      new Date('2012-01-05T09:30:00').toISOString(),
      'TZ=UTC pin missing — set TZ in the api vitest env / e2e apiEnv (csv-import-options, d-7c9626bb)',
    ).toBe('2012-01-05T09:30:00.000Z');
  });

  for (const id of Object.keys(CSV_IMPORT_SAMPLE_FILES)) {
    it(`${id}: sample previews through runPipeline with zero errors and the expected positions`, () => {
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

      expect(result.errors).toEqual([]);

      const expectedPositions = EXPECTED[id];
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
    });
  }
});

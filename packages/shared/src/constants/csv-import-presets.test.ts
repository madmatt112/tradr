import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CSV_IMPORT_SAMPLE_FILES, csvImportSamplePath } from '../node/csv-import-samples';
import {
  CsvPresetSchema,
  MappingSchema,
  type CsvPreset,
  type Mapping,
  type RowShape,
} from '../schemas/csv-import';

import { CSV_IMPORT_PRESETS, mappingColumns } from './csv-import-presets';

/**
 * Per-shape required-field set (REQ-2.2 / design Component 2). These are the
 * Tradr fields a mapping of each shape carries; the row-shape grounding test
 * checks that a preset's mapping keys are consistent with the declared shape
 * (the guard against d-b394aea7 — a wrong row-shape classification shipping
 * green).
 */
const EXECUTION_FIELDS = ['symbol', 'assetType', 'price', 'quantity', 'filledAt'] as const;
// execution carries exactly one of these direction fields
const EXECUTION_DIRECTION_FIELDS = ['type', 'action'] as const;
const ROUND_TRIP_ENTRY_FIELDS = ['entryPrice', 'entryQuantity', 'entryDate'] as const;
const ROUND_TRIP_EXIT_FIELDS = ['exitPrice', 'exitQuantity', 'exitDate'] as const;

function readSampleHeaders(presetId: string): string[] {
  const contents = readFileSync(csvImportSamplePath(presetId), 'utf8');
  const firstLine = contents.split(/\r?\n/)[0];
  return firstLine.split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
}

/**
 * The row-shape grounding assertion used by both the live presets and the
 * negative-proof presets: a preset's declared rowShape must be consistent with
 * its mapping keys, and every mapped column must resolve against the sample's
 * headers (when a sample is supplied).
 *
 * Throws if inconsistent (so a malformed/mis-shaped preset fails CI).
 */
function assertRowShapeGrounded(preset: CsvPreset, headers: string[] | null): void {
  const keys = Object.keys(preset.mapping.columns);
  const has = (f: string) => keys.includes(f);

  if (preset.rowShape === 'execution') {
    // No entry*/exit* keys on an execution preset.
    const roundTripKeys = [...ROUND_TRIP_ENTRY_FIELDS, ...ROUND_TRIP_EXIT_FIELDS];
    for (const f of roundTripKeys) {
      if (has(f)) {
        throw new Error(`execution preset ${preset.id} must not map round-trip field ${f}`);
      }
    }
  } else {
    // round-trip carries BOTH entry and exit groups.
    for (const f of [...ROUND_TRIP_ENTRY_FIELDS, ...ROUND_TRIP_EXIT_FIELDS]) {
      if (!has(f)) {
        throw new Error(`round-trip preset ${preset.id} must map ${f}`);
      }
    }
    // ...and carries none of the per-fill execution direction fields.
    for (const f of EXECUTION_DIRECTION_FIELDS) {
      if (has(f)) {
        throw new Error(`round-trip preset ${preset.id} must not map execution field ${f}`);
      }
    }
  }

  // Every column the mapping reads (columns, extraFeeColumns, rowFilter.column
  // — design C2's mappingColumns helper) must resolve against the sample
  // headers (REQ-1.2 / REQ-2.3 / REQ-2.4).
  if (headers) {
    for (const column of mappingColumns(preset.mapping)) {
      if (!headers.includes(column)) {
        throw new Error(
          `preset ${preset.id} reads column "${column}" but that column is absent from the sample`,
        );
      }
    }
  }
}

describe('csv-import-presets', () => {
  it('ships exactly the pinned roster, all execution, no round-trip preset', () => {
    const ids = CSV_IMPORT_PRESETS.map((p) => p.id).sort();
    expect(ids).toEqual(
      [
        'generic-execution',
        'generic-manual',
        'interactive-brokers',
        'tastytrade',
        'tradervue',
        'tradezella',
      ].sort(),
    );
    // d-b394aea7 guard: no shipped preset declares round-trip.
    for (const preset of CSV_IMPORT_PRESETS) {
      expect(preset.rowShape).toBe<RowShape>('execution');
      expect(preset.mapping.rowShape).toBe<RowShape>('execution');
    }
  });

  it('every preset parses against CsvPresetSchema and MappingSchema', () => {
    for (const preset of CSV_IMPORT_PRESETS) {
      expect(() => CsvPresetSchema.parse(preset)).not.toThrow();
      expect(() => MappingSchema.parse(preset.mapping)).not.toThrow();
    }
  });

  // --- Task 1 contract (broker-csv-presets, Requirement 2.7) ---
  // Pre-condition: MappingSchema is the shared Zod contract for a csv-import
  // mapping; design C1 / Data Models add five optional fields to it
  // (rowFilter, extraFeeColumns, positionEffect, signedPrice,
  // optionPriceIsContractValue) with the exact shapes shown in "MappingSchema
  // additions (all optional)".
  // Call (the Test: line's seam): `MappingSchema.parse(mapping)`.
  // Observable result / source of expected value:
  //   - a mapping literal carrying all five fields round-trips through parse
  //     unchanged (source: the design's Data Models shapes — the fields are
  //     additive, so nothing about them is stripped or coerced);
  //   - a `rowFilter` whose `values` array is empty fails parse (source:
  //     design's `values: z.array(z.string().min(1)).min(1)` — an empty array
  //     violates the `.min(1)` on the array itself).
  it('MappingSchema accepts a mapping carrying all five new optional fields', () => {
    const mapping = {
      rowShape: 'execution',
      columns: { symbol: 'Symbol' },
      rowFilter: { column: 'Type', values: ['Trade'] },
      extraFeeColumns: ['Commissions', 'Fees'],
      positionEffect: { BUY_TO_OPEN: 'entry', SELL_TO_CLOSE: 'exit' },
      signedPrice: true,
      optionPriceIsContractValue: true,
    };
    expect(MappingSchema.parse(mapping)).toEqual(mapping);
  });

  it('MappingSchema rejects a rowFilter with an empty values list', () => {
    const mapping = {
      rowShape: 'execution',
      columns: { symbol: 'Symbol' },
      rowFilter: { column: 'Type', values: [] },
    };
    expect(() => MappingSchema.parse(mapping)).toThrow();
  });

  it('generic-manual has no pre-filled mapping', () => {
    const manual = CSV_IMPORT_PRESETS.find((p) => p.id === 'generic-manual')!;
    expect(manual.mapping.columns).toEqual({});
  });

  it("each named preset's declared rowShape is consistent with its mapping and sample headers", () => {
    for (const preset of CSV_IMPORT_PRESETS) {
      const hasFixture = preset.id in CSV_IMPORT_SAMPLE_FILES;
      const headers = hasFixture ? readSampleHeaders(preset.id) : null;
      expect(() => assertRowShapeGrounded(preset, headers)).not.toThrow();
    }
  });

  it('each execution preset carries the execution required fields it claims to pre-fill', () => {
    // generic-manual intentionally pre-fills nothing; the rest pre-fill the
    // execution core they can source from their sample (assetType may be left
    // for the user per REQ-3.4).
    for (const preset of CSV_IMPORT_PRESETS) {
      if (preset.id === 'generic-manual') continue;
      const keys = Object.keys(preset.mapping.columns);
      // symbol/price/quantity/filledAt are present in every shipped sample.
      for (const f of ['symbol', 'price', 'quantity', 'filledAt'] as const) {
        expect(keys).toContain(f);
      }
      // exactly one direction field (type|action).
      const directionCount = EXECUTION_DIRECTION_FIELDS.filter((f) => keys.includes(f)).length;
      expect(directionCount).toBe(1);
    }
    // assertion above references EXECUTION_FIELDS' core indirectly
    expect(EXECUTION_FIELDS).toContain('symbol');
  });

  it('tradezella declares the Single->option synonym in mapping.transforms, not at preset level', () => {
    const tradezella = CSV_IMPORT_PRESETS.find((p) => p.id === 'tradezella')!;
    expect(tradezella.mapping.transforms?.assetType?.Single).toBe('option');
    expect(tradezella.transforms).toBeUndefined();
  });

  it('every preset declaring the composed contract form also declares an expiryFormat', () => {
    for (const preset of CSV_IMPORT_PRESETS) {
      if (preset.mapping.contractForm === 'composed') {
        expect(preset.mapping.expiryFormat).toBeDefined();
      }
    }
  });

  it('every preset declaring the descriptor contract form maps a descriptor column', () => {
    for (const preset of CSV_IMPORT_PRESETS) {
      if (preset.mapping.contractForm === 'descriptor') {
        expect(preset.mapping.columns.descriptor).toBeDefined();
      }
    }
  });

  // --- Negative proofs: deliberately broken presets must fail ---

  it('a malformed preset fails schema validation', () => {
    const malformed = {
      id: 'broken',
      label: 'Broken',
      // missing dateFormat / numberFormat, bad rowShape
      rowShape: 'sideways',
      mapping: { rowShape: 'execution', columns: { symbol: 'Symbol' } },
    };
    expect(() => CsvPresetSchema.parse(malformed)).toThrow();
  });

  it('a preset mapping an invented (absent) column fails the sample-resolution check', () => {
    const headers = readSampleHeaders('tradezella');
    const invented: CsvPreset = {
      id: 'invented',
      label: 'Invented header',
      rowShape: 'execution',
      dateFormat: 'us',
      numberFormat: 'us',
      mapping: {
        rowShape: 'execution',
        columns: { symbol: 'TickerSymbolThatDoesNotExist' },
      },
    };
    expect(() => assertRowShapeGrounded(invented, headers)).toThrow();
  });

  it('a preset whose declared rowShape contradicts its mapping fails (d-b394aea7 guard)', () => {
    // Declares round-trip but maps execution fields with no entry/exit groups —
    // exactly the v4 defect. Must throw.
    const misShaped: CsvPreset = {
      id: 'mis-shaped',
      label: 'Wrong shape',
      rowShape: 'round-trip',
      dateFormat: 'us',
      numberFormat: 'us',
      mapping: {
        rowShape: 'round-trip',
        columns: { symbol: 'Symbol', action: 'Buy/Sell', price: 'Price' },
      },
    };
    const headers = readSampleHeaders('tradezella');
    expect(() => assertRowShapeGrounded(misShaped, headers)).toThrow();
  });

  // --- Task 2 contract (broker-csv-presets, Requirements 1.2, 2.3, 2.4) ---
  // Pre-condition: design C2 specifies `mappingColumns(mapping: Mapping): string[]`
  // as the values of `columns`, then `extraFeeColumns`, then `rowFilter.column`,
  // deduplicated, in that order; design C3 merges the two fixture registries into
  // the single `CSV_IMPORT_SAMPLE_FILES`/`csvImportSamplePath` pair so the
  // grounding check above resolves every column a mapping reads from one
  // registry.
  // Call (the Test: line's seam): `mappingColumns(mapping)`, and
  // `assertRowShapeGrounded(preset, headers)` for the negative proof.
  // Observable result / source of expected value:
  //   - a mapping whose `columns`, `extraFeeColumns` and `rowFilter.column`
  //     values overlap returns each distinct column once, in that stage order
  //     (source: design C2's stated interface — "the values of columns, then
  //     extraFeeColumns, then rowFilter.column, deduplicated, in that order");
  //   - a mapping with no `extraFeeColumns`/`rowFilter` returns only its
  //     `columns` values (source: design C2 — the later stages contribute
  //     nothing when absent);
  //   - a preset whose `extraFeeColumns` names a column absent from its
  //     fixture's header fails `assertRowShapeGrounded`, because it now
  //     resolves every column `mappingColumns` returns, not only `columns`
  //     (source: Req 1.2/2.3/2.4 — the grounding check resolves every column a
  //     mapping reads, from one registry).
  it("mappingColumns returns columns' values, then extraFeeColumns, then rowFilter.column, deduplicated, in that order", () => {
    const mapping: Mapping = {
      rowShape: 'execution',
      columns: { symbol: 'Symbol', price: 'Price', fees: 'Fees' },
      extraFeeColumns: ['Fees', 'Commissions'],
      rowFilter: { column: 'Commissions', values: ['Trade'] },
    };
    expect(mappingColumns(mapping)).toEqual(['Symbol', 'Price', 'Fees', 'Commissions']);
  });

  it('mappingColumns returns only the columns values for a mapping with no extras', () => {
    const mapping: Mapping = {
      rowShape: 'execution',
      columns: { symbol: 'Symbol', price: 'Price' },
    };
    expect(mappingColumns(mapping)).toEqual(['Symbol', 'Price']);
  });

  it('a preset whose extraFeeColumns names an absent column fails the grounding check', () => {
    const headers = readSampleHeaders('tradezella');
    const invented: CsvPreset = {
      id: 'invented-fee-column',
      label: 'Invented fee column',
      rowShape: 'execution',
      dateFormat: 'us',
      numberFormat: 'us',
      mapping: {
        rowShape: 'execution',
        columns: { symbol: 'Symbol' },
        extraFeeColumns: ['ColumnThatDoesNotExist'],
      },
    };
    expect(() => assertRowShapeGrounded(invented, headers)).toThrow(/ColumnThatDoesNotExist/);
  });
});

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CsvPresetSchema,
  MappingSchema,
  type CsvPreset,
  type RowShape,
} from '../schemas/csv-import';

import { CSV_IMPORT_PRESETS } from './csv-import-presets';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.resolve(__dirname, '__fixtures__/csv-import-samples');

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

// Named presets each ship a committed real-export sample fixture (REQ-3.3).
// generic-manual has no mapping, so no fixture.
const SAMPLE_FILES: Record<string, string> = {
  'interactive-brokers': 'interactive-brokers.csv',
  tradezella: 'tradezella.csv',
  tradervue: 'tradervue.csv',
  'generic-execution': 'generic-execution.csv',
};

function readSampleHeaders(file: string): string[] {
  const contents = readFileSync(path.join(SAMPLES_DIR, file), 'utf8');
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

  // Every mapped column must resolve against the sample headers (REQ-3.3).
  if (headers) {
    for (const [field, column] of Object.entries(preset.mapping.columns)) {
      if (!headers.includes(column)) {
        throw new Error(
          `preset ${preset.id} maps ${field} -> "${column}" but that column is absent from the sample`,
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

  it('generic-manual has no pre-filled mapping', () => {
    const manual = CSV_IMPORT_PRESETS.find((p) => p.id === 'generic-manual')!;
    expect(manual.mapping.columns).toEqual({});
  });

  it("each named preset's declared rowShape is consistent with its mapping and sample headers", () => {
    for (const preset of CSV_IMPORT_PRESETS) {
      const file = SAMPLE_FILES[preset.id];
      const headers = file ? readSampleHeaders(file) : null;
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
    const headers = readSampleHeaders(SAMPLE_FILES.tradezella);
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
    const headers = readSampleHeaders(SAMPLE_FILES.tradezella);
    expect(() => assertRowShapeGrounded(misShaped, headers)).toThrow();
  });
});

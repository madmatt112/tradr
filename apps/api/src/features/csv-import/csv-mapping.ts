import type { Mapping, RowShape } from '@tradr/shared';

import type { ParsedCsv } from './csv-parse';

/**
 * Mapping + transforms — pure leaf module (no HTTP, no DB).
 *
 * Applies a {@link Mapping} (CSV column -> Tradr field, per row shape) and the
 * canonical value transforms to produce typed-but-unnormalized cells, and
 * reports mapping-level errors. Implements design Component 2 (REQ-2).
 *
 * Two guarantees this module upholds:
 *  - Mapping-shape errors (a required field unmapped, or mapped to a column the
 *    file does not contain) are reported BEFORE any row is processed (REQ-2.4).
 *  - A cell is never silently dropped, defaulted, or coerced: a value with no
 *    transform match, or a row that fails its declared shape's required fields,
 *    surfaces as a located error (REQ-2.3, REQ-2.7).
 */

/** A field whose value is canonicalized via a transform map. */
type TransformField = 'side' | 'assetType' | 'type' | 'action';

/**
 * A mapping-level error, reported before any row processing. Located by Tradr
 * field and/or CSV column where applicable (REQ-2.2, REQ-2.4).
 */
export interface MappingError {
  /** Tradr target field the error concerns, when applicable. */
  tradrField?: string;
  /** CSV column the field was mapped to, when applicable. */
  csvColumn?: string;
  /** Stable machine code. */
  code: string;
  /** Human-readable message. */
  message: string;
}

/** A located cell- or row-level error produced while processing a row. */
export interface MappedCellError {
  /** 1-based source row number; the header counts as row 1. */
  rowNumber: number;
  /** Tradr target field the error concerns, when applicable. */
  tradrField?: string;
  /** CSV column the cell came from, when applicable. */
  csvColumn?: string;
  /** Stable machine code. */
  code: string;
  /** Human-readable message. */
  message: string;
}

/**
 * One mapped CSV row: Tradr field -> raw-but-canonicalized cell value. Enum
 * fields (`side`/`assetType`/`type`/`action`) hold their canonical token;
 * numeric/date/text fields hold the trimmed raw string for the normalizer
 * (Component 3) to parse. Cells the row did not populate are absent.
 */
export interface MappedRow {
  /** 1-based source row number; the header counts as row 1. */
  sourceRow: number;
  /** Tradr field -> value. */
  values: Record<string, string>;
}

/** Result of {@link applyMapping}: mapped rows plus any located cell/row errors. */
export interface ApplyMappingResult {
  rows: MappedRow[];
  errors: MappedCellError[];
}

/**
 * Required Tradr fields per row shape, exactly as REQ-2.2.
 *
 * `execution` additionally requires EXACTLY ONE of (`type` | `action`); that
 * one-of rule is checked separately in {@link validateMappingShape}.
 */
const REQUIRED_FIELDS: Record<RowShape, string[]> = {
  execution: ['symbol', 'assetType', 'price', 'quantity', 'filledAt'],
  'round-trip': [
    'symbol',
    'assetType',
    'side',
    'entryPrice',
    'entryQuantity',
    'entryDate',
    'exitPrice',
    'exitQuantity',
    'exitDate',
  ],
};

/**
 * Canonical transform maps (REQ-2.3). Keys are UPPER-CASE; lookups upper-case
 * the trimmed cell, so matching is case-insensitive and whitespace-tolerant.
 */
const CANONICAL_TRANSFORMS: Record<TransformField, Record<string, string>> = {
  side: {
    B: 'long',
    BUY: 'long',
    L: 'long',
    LONG: 'long',
    S: 'short',
    SELL: 'short',
    SH: 'short',
    SHORT: 'short',
  },
  assetType: {
    EQ: 'stock',
    STK: 'stock',
    STOCK: 'stock',
    SHARES: 'stock',
    CS: 'stock',
    OPT: 'option',
    OPTION: 'option',
    O: 'option',
  },
  type: {
    OPEN: 'entry',
    O: 'entry',
    ENTRY: 'entry',
    CLOSE: 'exit',
    C: 'exit',
    EXIT: 'exit',
  },
  action: {
    B: 'buy',
    BUY: 'buy',
    BOT: 'buy',
    S: 'sell',
    SELL: 'sell',
    SLD: 'sell',
  },
};

const TRANSFORM_FIELDS: TransformField[] = ['side', 'assetType', 'type', 'action'];

/**
 * Build the effective transform map for a field: the canonical map with any
 * preset/mapping-declared synonyms merged on top (REQ-2.3). Declared synonym
 * keys are upper-cased so they match the same way canonical keys do.
 */
function effectiveTransformMap(field: TransformField, mapping: Mapping): Record<string, string> {
  const declared = mapping.transforms?.[field];
  if (!declared) return CANONICAL_TRANSFORMS[field];
  const merged: Record<string, string> = { ...CANONICAL_TRANSFORMS[field] };
  for (const [k, v] of Object.entries(declared)) {
    merged[k.trim().toUpperCase()] = v;
  }
  return merged;
}

/**
 * Validate mapping shape against the file's headers (REQ-2.2, REQ-2.4). Returns
 * every detected error; an empty array means the mapping is structurally sound.
 *
 * Checks, in order:
 *  - each required field for the declared shape is mapped (missing -> error);
 *  - for `execution`, exactly one of (`type` | `action`) is mapped;
 *  - every mapped column actually exists in the file's headers.
 */
export function validateMappingShape(headers: string[], mapping: Mapping): MappingError[] {
  const errors: MappingError[] = [];
  const columns = mapping.columns;
  const headerSet = new Set(headers);

  // 1. Required fields present.
  for (const field of REQUIRED_FIELDS[mapping.rowShape]) {
    if (!columns[field]) {
      errors.push({
        tradrField: field,
        code: 'MAPPING_FIELD_MISSING',
        message: `Required field "${field}" is not mapped to a column.`,
      });
    }
  }

  // 2. execution: exactly one of (type | action).
  if (mapping.rowShape === 'execution') {
    const hasType = Boolean(columns.type);
    const hasAction = Boolean(columns.action);
    if (!hasType && !hasAction) {
      errors.push({
        code: 'MAPPING_TYPE_OR_ACTION_REQUIRED',
        message: 'An execution mapping must map exactly one of "type" or "action".',
      });
    } else if (hasType && hasAction) {
      errors.push({
        code: 'MAPPING_TYPE_OR_ACTION_EXCLUSIVE',
        message: 'An execution mapping must map exactly one of "type" or "action", not both.',
      });
    }
  }

  // 3. Every mapped column exists in the file.
  for (const [field, column] of Object.entries(columns)) {
    if (column && !headerSet.has(column)) {
      errors.push({
        tradrField: field,
        csvColumn: column,
        code: 'MAPPING_COLUMN_ABSENT',
        message: `Field "${field}" is mapped to column "${column}", which is not in the file.`,
      });
    }
  }

  return errors;
}

/**
 * Apply the mapping to the parsed rows (REQ-2.3, REQ-2.7).
 *
 * PRECONDITION: callers MUST run {@link validateMappingShape} first and refuse
 * the import if it returns any error — mapping errors precede row processing
 * (REQ-2.4). This function maps columns positionally and assumes mapped columns
 * exist; an unresolved column is skipped (its cell is absent), never invented.
 *
 * Per cell:
 *  - the trimmed value is stored; an empty cell is omitted (the row-shape check
 *    then reports it as a missing required field — never defaulted);
 *  - enum fields are canonicalized via their transform map; no match ->
 *    located cell error (REQ-2.3), the cell omitted (not silently coerced);
 *  - after mapping, a row missing any required field for the declared shape ->
 *    located row error (REQ-2.7), never coerced into the other shape.
 */
export function applyMapping(parsed: ParsedCsv, mapping: Mapping): ApplyMappingResult {
  const rows: MappedRow[] = [];
  const errors: MappedCellError[] = [];

  // Map Tradr field -> column index, resolved once.
  const headerIndex = new Map<string, number>();
  parsed.headers.forEach((h, i) => headerIndex.set(h, i));

  const fieldColumns: Array<{ field: string; index: number }> = [];
  for (const [field, column] of Object.entries(mapping.columns)) {
    const index = headerIndex.get(column);
    if (index !== undefined) fieldColumns.push({ field, index });
  }

  const required = REQUIRED_FIELDS[mapping.rowShape];

  parsed.rows.forEach((rawRow, i) => {
    // 1-based source row number; the header counts as row 1 (REQ-5.5).
    const sourceRow = i + 2;
    const values: Record<string, string> = {};

    for (const { field, index } of fieldColumns) {
      const raw = (rawRow[index] ?? '').trim();
      if (raw === '') continue; // empty cell -> field absent, never defaulted

      if (isTransformField(field)) {
        const map = effectiveTransformMap(field, mapping);
        const canonical = map[raw.toUpperCase()];
        if (canonical === undefined) {
          errors.push({
            rowNumber: sourceRow,
            tradrField: field,
            csvColumn: mapping.columns[field],
            code: 'TRANSFORM_NO_MATCH',
            message: `Value "${raw}" for field "${field}" has no matching transform.`,
          });
          continue; // do not store an unmatched enum cell
        }
        values[field] = canonical;
      } else {
        values[field] = raw;
      }
    }

    // Non-conforming row: a required field absent after mapping/transform is a
    // located row error, never coerced into the other shape (REQ-2.7).
    const missing = required.filter((f) => values[f] === undefined);
    for (const field of missing) {
      errors.push({
        rowNumber: sourceRow,
        tradrField: field,
        csvColumn: mapping.columns[field],
        code: 'ROW_MISSING_REQUIRED_FIELD',
        message: `Row is missing required field "${field}" for the "${mapping.rowShape}" row shape.`,
      });
    }

    // execution: exactly one of (type | action) must be present per row.
    if (mapping.rowShape === 'execution') {
      const hasType = values.type !== undefined;
      const hasAction = values.action !== undefined;
      if (!hasType && !hasAction) {
        errors.push({
          rowNumber: sourceRow,
          code: 'ROW_MISSING_TYPE_OR_ACTION',
          message: 'Row is missing both "type" and "action"; exactly one is required.',
        });
      }
    }

    rows.push({ sourceRow, values });
  });

  return { rows, errors };
}

function isTransformField(field: string): field is TransformField {
  return (TRANSFORM_FIELDS as string[]).includes(field);
}

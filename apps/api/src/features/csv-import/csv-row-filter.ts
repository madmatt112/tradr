import type { ParsedCsv } from './csv-parse';

/**
 * Row filter — pure leaf module (no HTTP, no DB). Implements design C4.
 *
 * Skips non-trade rows before mapping and keeps their file row numbers, so a
 * broker export that interleaves money-movement or lifecycle rows with trades
 * can be imported with a visible skipped count (AC 4.1, 4.2).
 */

export type RowFilter = { column: string; values: string[] };

export interface RowFilterResult {
  /** Kept rows, with `rowNumbers` set to each kept row's original file position. */
  parsed: ParsedCsv;
  /** Distinct skipped values in first-seen order, each with its count. */
  skipped: Array<{ value: string; count: number }>;
  /** Sum of the skipped counts. */
  rowsSkipped: number;
}

/**
 * Keep only the rows whose filter-column cell matches a declared value.
 *
 * With no filter, or when the filter column is not in `parsed.headers`, the
 * input is returned unchanged with an empty `skipped` (the absent column is
 * reported by `validateMappingShape`). Otherwise one pass keeps a row when its
 * trimmed cell, upper-cased, is in the upper-cased `values` — the transform
 * matching rule at `csv-mapping.ts:148-156`. A skipped row is tallied by its
 * trimmed raw value in first-seen order, an empty cell as `(empty)`. Kept rows
 * carry their 1-based file row number (0-based index in `parsed.rows` plus 2).
 */
export function filterRows(parsed: ParsedCsv, rowFilter?: RowFilter): RowFilterResult {
  const columnIndex = rowFilter ? parsed.headers.indexOf(rowFilter.column) : -1;
  if (!rowFilter || columnIndex === -1) {
    return { parsed, skipped: [], rowsSkipped: 0 };
  }

  const allowed = new Set(rowFilter.values.map((v) => v.trim().toUpperCase()));
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  const skippedCounts = new Map<string, number>();

  for (let i = 0; i < parsed.rows.length; i++) {
    const row = parsed.rows[i];
    const raw = (row[columnIndex] ?? '').trim();
    if (allowed.has(raw.toUpperCase())) {
      rows.push(row);
      rowNumbers.push(i + 2);
      continue;
    }
    const key = raw === '' ? '(empty)' : raw;
    skippedCounts.set(key, (skippedCounts.get(key) ?? 0) + 1);
  }

  const skipped = Array.from(skippedCounts, ([value, count]) => ({ value, count }));
  const rowsSkipped = skipped.reduce((sum, s) => sum + s.count, 0);

  return {
    parsed: { ...parsed, rows, rowCount: rows.length, rowNumbers },
    skipped,
    rowsSkipped,
  };
}

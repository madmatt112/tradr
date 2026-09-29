import { describe, expect, it } from 'vitest';

import type { ParsedCsv } from './csv-parse';
import { filterRows } from './csv-row-filter';

describe('filterRows', () => {
  it('returns parsed unchanged with no filter declared', () => {
    // Pre-condition: a ParsedCsv, no rowFilter argument.
    const parsed: ParsedCsv = {
      headers: ['Type', 'Amount'],
      rows: [
        ['Trade', '10'],
        ['Dividend', '5'],
      ],
      rowCount: 2,
    };

    // Call: filterRows(parsed, rowFilter) with rowFilter omitted.
    const result = filterRows(parsed);

    // Observable result / source: design C4 — "With no filter ... it returns
    // parsed unchanged and skipped: []" and the RowFilterResult shape
    // (skipped: [], rowsSkipped: sum of counts = 0).
    expect(result.parsed).toEqual(parsed);
    expect(result.skipped).toEqual([]);
    expect(result.rowsSkipped).toBe(0);
  });

  it('returns parsed unchanged when the filter column is absent from headers', () => {
    // Pre-condition: a ParsedCsv whose headers do not include the filter's column.
    const parsed: ParsedCsv = {
      headers: ['Type', 'Amount'],
      rows: [
        ['Trade', '10'],
        ['Dividend', '5'],
      ],
      rowCount: 2,
    };

    // Call: filterRows(parsed, rowFilter) with a column not in parsed.headers.
    const result = filterRows(parsed, { column: 'Category', values: ['Trade'] });

    // Observable result / source: design C4 — "or when the filter column is
    // not in parsed.headers, it returns parsed unchanged and skipped: []".
    expect(result.parsed).toEqual(parsed);
    expect(result.skipped).toEqual([]);
    expect(result.rowsSkipped).toBe(0);
  });

  it('tallies skipped rows by trimmed raw value in first-seen order', () => {
    // Pre-condition: a ParsedCsv with two distinct non-matching values, the
    // second value repeated, interleaved with a matching row.
    const parsed: ParsedCsv = {
      headers: ['Type', 'Amount'],
      rows: [
        ['Trade', '10'],
        ['Money Movement', '1'],
        ['Dividend', '2'],
        ['Money Movement', '3'],
      ],
      rowCount: 4,
    };

    // Call: filterRows(parsed, rowFilter) with a declared trade value.
    const result = filterRows(parsed, { column: 'Type', values: ['Trade'] });

    // Observable result / source: design C4 — "A skipped row is tallied by
    // its trimmed raw value" and Data Models RowFilterResult.skipped —
    // "Array<{ value, count }> // first-seen order". Money Movement is
    // seen before Dividend, so it sorts first despite fewer total rows
    // overall; rowsSkipped is the sum of counts.
    expect(result.skipped).toEqual([
      { value: 'Money Movement', count: 2 },
      { value: 'Dividend', count: 1 },
    ]);
    expect(result.rowsSkipped).toBe(3);
  });

  it('tallies an empty cell as (empty)', () => {
    // Pre-condition: a ParsedCsv with one row whose filter-column cell is empty.
    const parsed: ParsedCsv = {
      headers: ['Type', 'Amount'],
      rows: [
        ['Trade', '10'],
        ['', '1'],
      ],
      rowCount: 2,
    };

    // Call: filterRows(parsed, rowFilter).
    const result = filterRows(parsed, { column: 'Type', values: ['Trade'] });

    // Observable result / source: design C4 — "an empty cell tallies as
    // (empty)".
    expect(result.skipped).toEqual([{ value: '(empty)', count: 1 }]);
    expect(result.rowsSkipped).toBe(1);
  });

  it("sets rowNumbers to each kept row's original file position", () => {
    // Pre-condition: a ParsedCsv where the second of three rows is skipped,
    // so the kept rows' original positions are not contiguous with a
    // kept-array index.
    const parsed: ParsedCsv = {
      headers: ['Type', 'Amount'],
      rows: [
        ['Trade', '10'], // parsed.rows index 0 -> file row 2
        ['Dividend', '1'], // parsed.rows index 1 -> file row 3 (skipped)
        ['Trade', '20'], // parsed.rows index 2 -> file row 4
      ],
      rowCount: 3,
    };

    // Call: filterRows(parsed, rowFilter).
    const result = filterRows(parsed, { column: 'Type', values: ['Trade'] });

    // Observable result / source: design Data Models — ParsedCsv.rowNumbers
    // "1-based file row per data row" and the task prompt — "rowNumbers set
    // to each kept row's original file position (its 0-based index in
    // parsed.rows plus 2, not the kept-array index)": kept rows are at
    // original indices 0 and 2, so rowNumbers is [2, 4], not [2, 3].
    expect(result.parsed.rowNumbers).toEqual([2, 4]);
    expect(result.parsed.rows).toEqual([
      ['Trade', '10'],
      ['Trade', '20'],
    ]);
  });

  it('keeps a row whose trimmed, upper-cased cell matches a declared value', () => {
    // Pre-condition: a ParsedCsv whose filter-column cells vary in case and
    // surrounding whitespace against a single declared value.
    const parsed: ParsedCsv = {
      headers: ['Type', 'Amount'],
      rows: [
        [' trade ', '10'],
        ['TRADE', '20'],
        ['other', '5'],
      ],
      rowCount: 3,
    };

    // Call: filterRows(parsed, rowFilter).
    const result = filterRows(parsed, { column: 'Type', values: ['Trade'] });

    // Observable result / source: design C4 — "A row is kept when its
    // trimmed cell, upper-cased, is in the upper-cased values", reusing the
    // matching rule at apps/api/src/features/csv-import/csv-mapping.ts:148-156.
    expect(result.parsed.rows).toEqual([
      [' trade ', '10'],
      ['TRADE', '20'],
    ]);
    expect(result.rowsSkipped).toBe(1);
  });
});

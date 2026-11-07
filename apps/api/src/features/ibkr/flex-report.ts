// The raw-report rules the preview cannot see (design C5). Pure, no I/O.

import type { CsvPreviewResponse } from '@tradr/shared';

import type { ParsedCsv } from '@/features/csv-import/csv-parse';
import { AppError } from '@/lib/errors';

import { FLEX_ACCOUNT_COLUMN } from './flex-wire';

const ACCOUNT_UNPROVEN_MESSAGE =
  'A Flex query must cover one IBKR account and export the account field, as one Trades section with no header or trailer rows';

/**
 * Proves the report names exactly one IBKR account: the column exists and
 * every row's cell holds the same non-blank value. Never surfaces the
 * account number itself — only this fixed refusal.
 */
export function proveSingleAccount(parsed: ParsedCsv): void {
  const columnIndex = parsed.headers.indexOf(FLEX_ACCOUNT_COLUMN);

  if (columnIndex === -1) {
    throw new AppError(422, 'IBKR_FLEX_ACCOUNT_UNPROVEN', ACCOUNT_UNPROVEN_MESSAGE);
  }

  let seen: string | undefined;

  for (const row of parsed.rows) {
    const cell = row[columnIndex];

    if (!cell) {
      throw new AppError(422, 'IBKR_FLEX_ACCOUNT_UNPROVEN', ACCOUNT_UNPROVEN_MESSAGE);
    }

    if (seen === undefined) {
      seen = cell;
    } else if (cell !== seen) {
      throw new AppError(422, 'IBKR_FLEX_ACCOUNT_UNPROVEN', ACCOUNT_UNPROVEN_MESSAGE);
    }
  }
}

/**
 * Gives the UTC calendar dates of the earliest and latest fill across every
 * position, or null when no fill exists.
 */
export function reportTradeSpan(
  preview: CsvPreviewResponse,
): { start: string; end: string } | null {
  const instants = preview.positions.flatMap((position) =>
    position.fills.map((fill) => fill.filledAt),
  );

  if (instants.length === 0) {
    return null;
  }

  const dates = instants.map((instant) => new Date(instant).toISOString().slice(0, 10)).sort();

  return { start: dates[0], end: dates[dates.length - 1] };
}

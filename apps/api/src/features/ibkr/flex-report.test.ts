// Red-first (task 10): `flex-report.ts` does not exist yet. This file fixes
// the contract the implementer builds to for design C5's two pure functions.
//
// `proveSingleAccount(parsed: ParsedCsv): void` throws an `AppError` with
// design Error Handling row 8's code (`IBKR_FLEX_ACCOUNT_UNPROVEN`), status
// (422) and message, unless the `FLEX_ACCOUNT_COLUMN` header exists and every
// row holds the same non-blank value. `reportTradeSpan(preview:
// CsvPreviewResponse): { start: string; end: string } | null` gives the UTC
// dates of the earliest and latest `filledAt` across `positions[].fills[]`,
// or null with no fill.
//
// | Criterion                                                        | Pre-condition                                                              | Call (seam)                      | Observable result                                                        | Source |
// |-------------------------------------------------------------------|-----------------------------------------------------------------------------|-----------------------------------|---------------------------------------------------------------------------|--------|
// | Absent column refuses                                              | parsed CSV with no `ClientAccountID` header                                 | proveSingleAccount(parsed)        | throws `{ statusCode: 422, code: 'IBKR_FLEX_ACCOUNT_UNPROVEN', message }` | design C5; Error Handling row 8; Req 2.8 |
// | Blank cell refuses                                                 | parsed CSV with the column present, one row's cell blank                    | proveSingleAccount(parsed)        | throws the same triplet                                                   | design C5 ("A blank cell refuses"); Req 2.8 |
// | Two distinct values refuse                                        | parsed CSV with the column present, two rows naming different accounts      | proveSingleAccount(parsed)        | throws the same triplet                                                   | design C5; Req 2.8 |
// | A header/trailer first line refuses because the column is absent  | parsed CSV whose first line is report metadata, pushing the real header row into the data rows | proveSingleAccount(parsed) | throws the same triplet (absent column)                                   | design C5 ("a header/trailer line becomes the 'header' row, so the column is absent") |
// | A repeated section header refuses as a second value                | parsed CSV with a real header row, a data row, then the header row repeated as data, then another data row | proveSingleAccount(parsed) | throws the same triplet (two distinct values)                             | design C5 ("a repeated section header adds a second distinct value") |
// | One value on every row passes                                     | parsed CSV with the column present, every row naming the same account       | proveSingleAccount(parsed)        | returns, does not throw                                                   | design C5 |
// | reportTradeSpan gives the earliest/latest UTC trade dates          | a preview with two positions whose fills carry distinct `filledAt` instants  | reportTradeSpan(preview)          | `{ start, end }` holding the UTC calendar dates of the earliest/latest instant | design C5; Req 7.1 |
// | reportTradeSpan gives null with no fill                            | a preview with no positions                                                 | reportTradeSpan(preview)          | `null`                                                                     | design C5 ("null with no fill"); Req 7.1 |
// | The span result holds only two dates                               | the same preview as the earliest/latest case                                | reportTradeSpan(preview)          | the returned object's own keys are exactly `start` and `end`              | Req 7.4 |

import { describe, expect, it } from 'vitest';

import type { CsvPreviewResponse, ProposedFill, ProposedPosition } from '@tradr/shared';

import { parseCsv } from '@/features/csv-import/csv-parse';

import { proveSingleAccount, reportTradeSpan } from './flex-report';
import { FLEX_ACCOUNT_COLUMN } from './flex-wire';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const ACCOUNT_UNPROVEN = {
  statusCode: 422,
  code: 'IBKR_FLEX_ACCOUNT_UNPROVEN',
  message:
    'A Flex query must cover one IBKR account and export the account field, as one Trades section with no header or trailer rows',
};

function expectAccountUnproven(fn: () => void): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toMatchObject(ACCOUNT_UNPROVEN);
}

function fill(filledAt: string, sourceRow: number): ProposedFill {
  return { type: 'entry', price: '100', quantity: '1', fees: '0', filledAt, sourceRow };
}

function position(symbol: string, fills: ProposedFill[]): ProposedPosition {
  return {
    scope: { symbol, assetType: 'stock' },
    side: 'long',
    closes: false,
    fills,
  };
}

function preview(positions: ProposedPosition[]): CsvPreviewResponse {
  return {
    token: '00000000-0000-4000-8000-000000000000',
    summary: { rowsParsed: 0, rowsValid: 0, rowsWithErrors: 0, positions: 0, fills: 0 },
    positions,
    errors: [],
    warnings: [],
    timezone: 'UTC',
    committable: true,
    requiresDuplicateAffirmation: false,
    groupProposals: [],
    events: [],
  };
}

describe('proveSingleAccount', () => {
  it('refuses when the account column is absent', () => {
    const parsed = parseCsv(enc('Symbol,Quantity\nAAPL,100\n'));

    expectAccountUnproven(() => proveSingleAccount(parsed));
  });

  it('refuses when a row holds a blank cell for the account column', () => {
    const parsed = parseCsv(
      enc(`Symbol,${FLEX_ACCOUNT_COLUMN},Quantity\nAAPL,U1234567,100\nAAPL,,50\n`),
    );

    expectAccountUnproven(() => proveSingleAccount(parsed));
  });

  it('refuses when rows hold two distinct account values', () => {
    const parsed = parseCsv(
      enc(`Symbol,${FLEX_ACCOUNT_COLUMN},Quantity\nAAPL,U1234567,100\nMSFT,U7654321,50\n`),
    );

    expectAccountUnproven(() => proveSingleAccount(parsed));
  });

  it('refuses because the column is absent when a header/trailer first line pushes the real header into the data rows', () => {
    const parsed = parseCsv(
      enc(`Statement,Custom Flex Query,,\nSymbol,${FLEX_ACCOUNT_COLUMN},Quantity\nAAPL,U1234567,100\n`),
    );

    expectAccountUnproven(() => proveSingleAccount(parsed));
  });

  it('refuses as a second distinct value when a section header repeats as a data row', () => {
    const parsed = parseCsv(
      enc(
        `Symbol,${FLEX_ACCOUNT_COLUMN},Quantity\n` +
          'AAPL,U1234567,100\n' +
          `Symbol,${FLEX_ACCOUNT_COLUMN},Quantity\n` +
          'MSFT,U1234567,50\n',
      ),
    );

    expectAccountUnproven(() => proveSingleAccount(parsed));
  });

  it('passes when every row names the same account', () => {
    const parsed = parseCsv(
      enc(`Symbol,${FLEX_ACCOUNT_COLUMN},Quantity\nAAPL,U1234567,100\nMSFT,U1234567,50\n`),
    );

    expect(() => proveSingleAccount(parsed)).not.toThrow();
  });
});

describe('reportTradeSpan', () => {
  it('gives the UTC calendar dates of the earliest and latest filledAt across positions and fills', () => {
    const result = reportTradeSpan(
      preview([
        position('AAPL', [fill('2026-01-07T15:00:00.000Z', 2)]),
        position('MSFT', [
          fill('2026-01-06T10:00:00.000Z', 3),
          fill('2026-01-05T09:30:00.000Z', 1),
        ]),
      ]),
    );

    expect(result).toEqual({ start: '2026-01-05', end: '2026-01-07' });
  });

  it('gives null when no position carries a fill', () => {
    const result = reportTradeSpan(preview([]));

    expect(result).toBeNull();
  });

  it('holds only the two dates', () => {
    const result = reportTradeSpan(
      preview([
        position('AAPL', [fill('2026-01-07T15:00:00.000Z', 2)]),
        position('MSFT', [fill('2026-01-05T09:30:00.000Z', 1)]),
      ]),
    );

    expect(Object.keys(result!).sort()).toEqual(['end', 'start']);
  });
});

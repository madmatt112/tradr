// Deterministic fixture builders for the expenses-tax bench (`bench/expenses.bench.ts`).
//
// All large-row producers emit the postgres COPY text format (tab-delimited,
// `\N` for NULL, no header) so the bench can stream them straight into
// `COPY <table> (...) FROM STDIN`. Plain Drizzle inserts of hundreds of
// thousands of rows take minutes on a dev box; COPY drops it to a few seconds.
//
// Mirrors the byte layout produced by `ledger-fixture.ts` — see that file for
// the escape rules.

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { mulberry32 } from '@/db/seed/rng';

// COPY default text format escapes (tab, newline, CR, backslash). Our generated
// values (UUIDs, ISO timestamps, fixed strings) contain none of these, so this
// is defensive — keeps the helper safe if a caller widens the value set.
const NULL_TOKEN = '\\N';

function escapeTsv(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

// ---------------------------------------------------------------------------
// expenses fixture (Scenario 1 — LIST 500 rows)
// ---------------------------------------------------------------------------

export const EXPENSES_COPY_COLUMNS = [
  'id',
  'user_id',
  'category',
  'description',
  'amount',
  'currency',
  'occurred_at',
  'notes',
  'created_at',
  'updated_at',
] as const;

const EXPENSE_CATEGORIES_LITE = [
  'software',
  'subscriptions',
  'education',
  'hardware',
  'office',
  'other',
] as const;

export interface ExpensesFixtureParams {
  userId: string;
  /** total expense rows to emit. */
  count: number;
  /** earliest occurredAt year (inclusive). */
  startYear: number;
  /** latest occurredAt year (inclusive). */
  endYear: number;
  /** PRNG seed — pin for byte-stable output. */
  rngSeed: number;
  /** Currencies to round-robin across. */
  currencies: readonly string[];
}

/**
 * TSV stream for `COPY expenses (...) FROM STDIN`. Years are round-robined
 * across `[startYear, endYear]`; currencies are round-robined; amounts are
 * positive (CHECK constraint).
 */
export function buildExpensesCopyStream(params: ExpensesFixtureParams): Readable {
  const { userId, count, startYear, endYear, rngSeed, currencies } = params;
  if (currencies.length === 0) {
    throw new Error('buildExpensesCopyStream: currencies must be non-empty');
  }
  if (endYear < startYear) {
    throw new Error('buildExpensesCopyStream: endYear must be >= startYear');
  }
  const yearSpan = endYear - startYear + 1;
  const rng = mulberry32(rngSeed);

  let emitted = 0;
  return new Readable({
    read() {
      const BATCH = 500;
      let chunk = '';
      const upper = Math.min(emitted + BATCH, count);
      for (let i = emitted; i < upper; i++) {
        const year = startYear + (i % yearSpan);
        const month = 1 + Math.floor(rng() * 12);
        const day = 1 + Math.floor(rng() * 28);
        const occurredAt = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const createdAt = `${occurredAt}T12:00:00Z`;
        const category = EXPENSE_CATEGORIES_LITE[i % EXPENSE_CATEGORIES_LITE.length]!;
        const currency = currencies[i % currencies.length]!;
        // amount in [0.01, 999.99] at 2dp — well inside numeric(18,4).
        const amountCents = 1 + Math.floor(rng() * 99998);
        const amountStr = (amountCents / 100).toFixed(4);
        const cells = [
          randomUUID(),
          userId,
          category,
          `bench-expense-${i}`,
          amountStr,
          currency,
          occurredAt,
          NULL_TOKEN, // notes
          createdAt,
          createdAt,
        ];
        chunk += cells.map(escapeTsv).join('\t') + '\n';
      }
      emitted = upper;
      if (chunk.length > 0) this.push(chunk);
      if (emitted >= count) this.push(null);
    },
  });
}

// ---------------------------------------------------------------------------
// positions fixture (Scenarios 2 & 3 — 500k fills join + 5k positions)
// ---------------------------------------------------------------------------

export const POSITIONS_COPY_COLUMNS = [
  'id',
  'user_id',
  'account_id',
  'symbol',
  'side',
  'asset_type',
  'status',
  'notes',
  'opened_at',
  'closed_at',
  'created_at',
  'updated_at',
] as const;

export interface PositionsFixtureParams {
  userId: string;
  /** account ids — positions are distributed round-robin across them. */
  accountIds: string[];
  /** total position rows to emit. */
  count: number;
  /** Per-position opened_at falls inside [openedStart, openedEnd]. */
  openedStart: Date;
  openedEnd: Date;
  /** PRNG seed — pin for byte-stable output. */
  rngSeed: number;
  /** When set, every position closes inside [closedStart, closedEnd]. */
  closedRange?: { start: Date; end: Date };
  /** symbol pool — round-robined. Defaults to a small US-equity list. */
  symbols?: readonly string[];
}

const DEFAULT_SYMBOLS = ['AAPL', 'MSFT', 'GOOG', 'AMZN', 'NVDA', 'META', 'TSLA', 'NFLX'] as const;

/**
 * Returns `{ stream, positionIds }`. `positionIds` is the list of ids the
 * stream will emit, exposed so the caller can later stream fills referencing
 * those ids. Capture before piping (the array is built eagerly, but the TSV
 * rows are streamed lazily).
 */
export function buildPositionsCopyStream(params: PositionsFixtureParams): {
  stream: Readable;
  positionIds: string[];
  positionAccountIds: string[];
} {
  const { userId, accountIds, count, openedStart, openedEnd, rngSeed, closedRange } = params;
  if (accountIds.length === 0) {
    throw new Error('buildPositionsCopyStream: accountIds must be non-empty');
  }
  const openedSpanMs = openedEnd.getTime() - openedStart.getTime();
  if (openedSpanMs <= 0) {
    throw new Error('buildPositionsCopyStream: openedEnd must be after openedStart');
  }
  const closedSpanMs = closedRange ? closedRange.end.getTime() - closedRange.start.getTime() : 0;
  if (closedRange && closedSpanMs <= 0) {
    throw new Error('buildPositionsCopyStream: closedRange.end must be after closedRange.start');
  }
  const symbols = params.symbols ?? DEFAULT_SYMBOLS;
  const rng = mulberry32(rngSeed);

  // Pre-generate ids so the caller can reference them for child rows (fills).
  const positionIds: string[] = new Array(count);
  const positionAccountIds: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    positionIds[i] = randomUUID();
    positionAccountIds[i] = accountIds[i % accountIds.length]!;
  }

  let emitted = 0;
  const stream = new Readable({
    read() {
      const BATCH = 500;
      let chunk = '';
      const upper = Math.min(emitted + BATCH, count);
      for (let i = emitted; i < upper; i++) {
        const id = positionIds[i]!;
        const accountId = positionAccountIds[i]!;
        const symbol = symbols[i % symbols.length]!;
        const side = i % 2 === 0 ? 'long' : 'short';
        // Keep all positions as `stock` so the tax-summary's wash-sale helper
        // doesn't need an OCC parser path (Scenario 3 is about plan shape).
        const assetType = 'stock';
        const status = closedRange ? 'closed' : 'open';
        const openedAt = new Date(openedStart.getTime() + rng() * openedSpanMs).toISOString();
        const closedAt = closedRange
          ? new Date(closedRange.start.getTime() + rng() * closedSpanMs).toISOString()
          : NULL_TOKEN;
        const cells = [
          id,
          userId,
          accountId,
          symbol,
          side,
          assetType,
          status,
          NULL_TOKEN, // notes
          openedAt,
          closedAt,
          openedAt, // created_at
          openedAt, // updated_at
        ];
        chunk += cells.map(escapeTsv).join('\t') + '\n';
      }
      emitted = upper;
      if (chunk.length > 0) this.push(chunk);
      if (emitted >= count) this.push(null);
    },
  });
  return { stream, positionIds, positionAccountIds };
}

// ---------------------------------------------------------------------------
// fills fixture (Scenario 2 — 50 accounts × 10k fills/year = 500k rows)
// ---------------------------------------------------------------------------

export const FILLS_COPY_COLUMNS = [
  'id',
  'position_id',
  'type',
  'price',
  'quantity',
  'fees',
  'notes',
  'filled_at',
  'created_at',
] as const;

export interface FillsFixtureParams {
  /** Position ids to attach fills to — round-robined. */
  positionIds: string[];
  /** Total fill rows to emit. */
  count: number;
  /** filled_at falls inside [filledStart, filledEnd]. */
  filledStart: Date;
  filledEnd: Date;
  rngSeed: number;
}

/**
 * TSV stream for `COPY fills (...) FROM STDIN`. Distributes fills round-robin
 * across `positionIds`, so the join cardinality from positions→fills is even.
 */
export function buildFillsCopyStream(params: FillsFixtureParams): Readable {
  const { positionIds, count, filledStart, filledEnd, rngSeed } = params;
  if (positionIds.length === 0) {
    throw new Error('buildFillsCopyStream: positionIds must be non-empty');
  }
  const spanMs = filledEnd.getTime() - filledStart.getTime();
  if (spanMs <= 0) {
    throw new Error('buildFillsCopyStream: filledEnd must be after filledStart');
  }
  const rng = mulberry32(rngSeed);

  let emitted = 0;
  return new Readable({
    read() {
      const BATCH = 1000;
      let chunk = '';
      const upper = Math.min(emitted + BATCH, count);
      for (let i = emitted; i < upper; i++) {
        const positionId = positionIds[i % positionIds.length]!;
        const type = i % 2 === 0 ? 'open' : 'close';
        // price in [10, 510), quantity 1 share, fees in [0.01, 5.00].
        const price = (10 + rng() * 500).toFixed(8);
        const quantity = '1.00000000';
        const feeCents = 1 + Math.floor(rng() * 499);
        const fees = (feeCents / 100).toFixed(8);
        const filledAt = new Date(filledStart.getTime() + rng() * spanMs).toISOString();
        const cells = [
          randomUUID(),
          positionId,
          type,
          price,
          quantity,
          fees,
          NULL_TOKEN, // notes
          filledAt,
          filledAt, // created_at
        ];
        chunk += cells.map(escapeTsv).join('\t') + '\n';
      }
      emitted = upper;
      if (chunk.length > 0) this.push(chunk);
      if (emitted >= count) this.push(null);
    },
  });
}

// ---------------------------------------------------------------------------
// ledger_entries fixture (Scenario 3 — position_pnl rows for 1k in-year closes)
// ---------------------------------------------------------------------------

export const LEDGER_PNL_COPY_COLUMNS = [
  'id',
  'user_id',
  'account_id',
  'position_id',
  'entry_type',
  'direction',
  'amount',
  'currency',
  'symbol',
  'occurred_at',
  'created_at',
  'group_id',
  'reverses_group_id',
] as const;

export interface LedgerPnlFixtureParams {
  userId: string;
  /** One ledger row per position pair below. */
  positionPairs: Array<{ positionId: string; accountId: string; closedAt: Date }>;
  /** Subset (by index) of positionPairs that should produce a LOSS (debit). */
  lossIndices: ReadonlySet<number>;
  /** All ledger rows use this currency. */
  currency: string;
  rngSeed: number;
}

/**
 * TSV stream for `COPY ledger_entries (...) FROM STDIN` emitting exactly ONE
 * `position_pnl` row per supplied position. Loss positions are emitted as a
 * `debit` (loss reduces account balance); the rest are `credit` (gain). The
 * `occurred_at` matches the position's `closedAt` so the year-bounded window
 * filter in `listRealisedPositionsForYear` will include the row iff the
 * position closed in the requested year.
 */
export function buildLedgerPnlCopyStream(params: LedgerPnlFixtureParams): Readable {
  const { userId, positionPairs, lossIndices, currency, rngSeed } = params;
  const rng = mulberry32(rngSeed);

  let emitted = 0;
  return new Readable({
    read() {
      const BATCH = 1000;
      let chunk = '';
      const upper = Math.min(emitted + BATCH, positionPairs.length);
      for (let i = emitted; i < upper; i++) {
        const { positionId, accountId, closedAt } = positionPairs[i]!;
        const isLoss = lossIndices.has(i);
        const direction = isLoss ? 'debit' : 'credit';
        // P&L magnitude in [10.00, 1010.00].
        const amountCents = 1000 + Math.floor(rng() * 100000);
        const amountStr = (amountCents / 100).toFixed(4);
        const occurredAt = closedAt.toISOString();
        const cells = [
          randomUUID(),
          userId,
          accountId,
          positionId,
          'position_pnl',
          direction,
          amountStr,
          currency,
          NULL_TOKEN, // symbol
          occurredAt,
          occurredAt, // created_at
          randomUUID(), // group_id
          NULL_TOKEN, // reverses_group_id
        ];
        chunk += cells.map(escapeTsv).join('\t') + '\n';
      }
      emitted = upper;
      if (chunk.length > 0) this.push(chunk);
      if (emitted >= positionPairs.length) this.push(null);
    },
  });
}

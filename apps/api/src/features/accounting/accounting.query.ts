import Decimal from 'decimal.js';
import { and, asc, desc, eq, inArray, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type { Database, Transaction } from '@/db';
import { accounts, exchangeRates, ledgerEntries, users } from '@/db/schema';

// All ledger reads filter `entryType IN ('position_pnl', 'position_pnl_reversal')`.
// v1 emits only `'position_pnl'`; the wider filter ships in v1 so the future
// reversal spec (d-536e8750) does not need to touch these query sites.
const PNL_ENTRY_TYPES = ['position_pnl', 'position_pnl_reversal'] as const;

// ---------------------------------------------------------------------------
// Row / input types
// ---------------------------------------------------------------------------

export type LedgerEntryRow = typeof ledgerEntries.$inferSelect;
export type NewLedgerEntry = typeof ledgerEntries.$inferInsert;
export type ExchangeRateRow = typeof exchangeRates.$inferSelect;
export type NewExchangeRate = typeof exchangeRates.$inferInsert;

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Insert one or more ledger entries. Transaction-only — the close hook owns
 * the surrounding transaction and these rows must commit atomically with the
 * position-status update.
 */
export function insertLedgerEntries(
  tx: Transaction,
  entries: NewLedgerEntry[],
): Promise<LedgerEntryRow[]> {
  return tx.insert(ledgerEntries).values(entries).returning();
}

/**
 * Reverse every UN-REVERSED `position_pnl` row for a position by INSERTing a
 * flipped-direction `position_pnl_reversal` row per un-reversed original
 * (design.md §Amendment C9; Req 7.1, 7.2, 7.9). Append-only — this NEVER
 * DELETEs or UPDATEs an existing ledger row; neutralization is by insertion.
 *
 * "Un-reversed" set = the `position_pnl` rows for `(userId, positionId)` whose
 * `groupId` is NOT referenced by any `position_pnl_reversal.reversesGroupId`
 * for the same position. Found via a `NOT EXISTS` correlated subquery over an
 * aliased `ledger_entries` (`rev`). The close hook never returns the `groupId`
 * it generates, so reversal recovers its targets by `positionId` — no groupId
 * threading through the close path.
 *
 * Each reversal copies the original's `amount` VERBATIM (the string is already
 * aligned to the account currency's minor units by the close hook, Req 2.10 /
 * 7.9 — never `parseFloat`/re-round it), plus `currency`, `symbol`, `accountId`,
 * `userId`, `positionId`; flips `direction` (credit↔debit); gets a fresh
 * `groupId`; and sets `reversesGroupId = original.groupId`. `occurredAt` is the
 * caller-supplied reversal event time (reopen/delete timestamp) or `now()`.
 *
 * Idempotent: an empty un-reversed set (never-closed position, or one already
 * fully reversed) inserts nothing and returns `[]`. Transaction-only — the
 * reversal must commit atomically with the reopen/delete that triggered it
 * (Req 7.9), and `insertLedgerEntries` (the sole ledger writer) is reused so
 * every ledger INSERT shares one code path.
 */
export async function reverseCloseForPosition(
  tx: Transaction,
  { userId, positionId, occurredAt }: { userId: string; positionId: string; occurredAt?: Date },
): Promise<LedgerEntryRow[]> {
  // Alias the same table for the correlated subquery so `rev` (candidate
  // reversal rows) is disambiguated from the outer `position_pnl` rows.
  const rev = alias(ledgerEntries, 'rev');
  const unreversed = await tx
    .select()
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.userId, userId),
        eq(ledgerEntries.positionId, positionId),
        eq(ledgerEntries.entryType, 'position_pnl'),
        notExists(
          tx
            .select({ id: rev.id })
            .from(rev)
            .where(
              and(
                eq(rev.entryType, 'position_pnl_reversal'),
                eq(rev.positionId, positionId),
                eq(rev.reversesGroupId, ledgerEntries.groupId),
              ),
            ),
        ),
      ),
    );

  if (unreversed.length === 0) {
    // Idempotent no-op: never-closed or already fully reversed.
    return [];
  }

  const reversals: NewLedgerEntry[] = unreversed.map((row) => ({
    userId: row.userId,
    accountId: row.accountId,
    positionId: row.positionId,
    entryType: 'position_pnl_reversal',
    // Flip direction. `amount` stays a non-negative magnitude
    // (`ledger_amount_nonneg_chk`); the sign is carried by `direction`.
    direction: row.direction === 'credit' ? 'debit' : 'credit',
    // Verbatim copy — already minor-unit aligned; keep it a string.
    amount: row.amount,
    currency: row.currency,
    symbol: row.symbol,
    occurredAt: occurredAt ?? new Date(),
    groupId: crypto.randomUUID(),
    reversesGroupId: row.groupId,
  }));

  return insertLedgerEntries(tx, reversals);
}

/**
 * Plain insert of an exchange rate. Throws on `(userId, base, quote, effectiveDate)`
 * uniqueness violation — callers that want upsert semantics use
 * `upsertExchangeRate` instead.
 */
export async function insertExchangeRate(
  db: Database | Transaction,
  rate: NewExchangeRate,
): Promise<ExchangeRateRow> {
  const rows = await db.insert(exchangeRates).values(rate).returning();
  return rows[0];
}

/**
 * Upsert by `(userId, baseCurrency, quoteCurrency, effectiveDate)` — re-entry
 * of the same pair-and-date replaces `rate` (Req 4.2).
 */
export async function upsertExchangeRate(
  db: Database | Transaction,
  rate: NewExchangeRate,
): Promise<ExchangeRateRow> {
  const rows = await db
    .insert(exchangeRates)
    .values(rate)
    .onConflictDoUpdate({
      target: [
        exchangeRates.userId,
        exchangeRates.baseCurrency,
        exchangeRates.quoteCurrency,
        exchangeRates.effectiveDate,
      ],
      set: { rate: rate.rate },
    })
    .returning();
  return rows[0];
}

export async function deleteExchangeRate(
  db: Database | Transaction,
  userId: string,
  id: string,
): Promise<{ deleted: boolean }> {
  const rows = await db
    .delete(exchangeRates)
    .where(and(eq(exchangeRates.id, id), eq(exchangeRates.userId, userId)))
    .returning({ id: exchangeRates.id });
  return { deleted: rows.length > 0 };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function listExchangeRatesForUser(
  db: Database | Transaction,
  userId: string,
): Promise<ExchangeRateRow[]> {
  return db
    .select()
    .from(exchangeRates)
    .where(eq(exchangeRates.userId, userId))
    .orderBy(
      asc(exchangeRates.baseCurrency),
      asc(exchangeRates.quoteCurrency),
      desc(exchangeRates.effectiveDate),
    );
}

/**
 * Page of ledger entries for an account plus the cumulative balance up to
 * (exclusive) the first row of the page so the frontend can fold per-row
 * running balance forward through the page. The anchor includes the account's
 * user-entered starting balance so per-row running balances tie out to the
 * derived account balance (starting_balance + SUM over ledger_entries).
 *
 * `hasMore` is computed here via a `limit + 1` fetch: we request one extra
 * row and report `hasMore = rows.length > limit`, returning at most `limit`
 * rows in `entries`.
 *
 * Empty-page behavior: when `offset` is at or past the account's total entry
 * count, `entries` is `[]`, `hasMore` is `false`, and
 * `runningBalanceAtFirstRow` is `'0.00'`. The anchor balance is only
 * meaningful when `entries.length > 0` — the `'0.00'` value for an empty
 * page is a safe default the caller should ignore.
 *
 * `page` / `pageSize` are NOT this layer's concern — the route maps
 * `page → offset` and supplies pagination metadata in the response.
 */
export async function listLedgerEntriesForAccount(
  db: Database | Transaction,
  params: {
    userId: string;
    accountId: string;
    limit: number;
    offset: number;
  },
): Promise<{
  entries: LedgerEntryRow[];
  runningBalanceAtFirstRow: string;
  hasMore: boolean;
}> {
  const { userId, accountId, limit, offset } = params;

  // Fetch limit + 1 so we can detect "there is a next page" without a
  // second COUNT query.
  const rowsPlusOne = await db
    .select()
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.userId, userId),
        eq(ledgerEntries.accountId, accountId),
        inArray(ledgerEntries.entryType, [...PNL_ENTRY_TYPES]),
      ),
    )
    .orderBy(desc(ledgerEntries.occurredAt), desc(ledgerEntries.createdAt))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = rowsPlusOne.length > limit;
  const entries = hasMore ? rowsPlusOne.slice(0, limit) : rowsPlusOne;

  if (entries.length === 0) {
    // No anchor row — running-balance value is undefined; '0.00' is a
    // safe default the caller should ignore when entries is empty.
    return { entries, runningBalanceAtFirstRow: '0.00', hasMore: false };
  }

  // Running balance is computed over rows strictly AFTER the page's first
  // row in sort order (`occurredAt DESC, createdAt DESC`). "After in sort
  // order" with a DESC sort means rows that are older — i.e. rows whose
  // `(occurredAt, createdAt)` tuple is lexicographically less than the
  // first page row. SUM(credit) − SUM(debit) over those older rows is the
  // cumulative balance up to (exclusive) the first page row.
  const first = entries[0];
  // Serialize to ISO strings: these params are embedded in a raw `db.execute`
  // (sql.unsafe) query, whose path does NOT type-encode a JS Date — passing a
  // Date object throws `TypeError: ... Received an instance of Date` in
  // postgres-js's Bind, 500ing the endpoint for any non-empty account. Postgres
  // casts the text literal back to timestamptz for the comparison.
  const pageFirstOccurredAt = new Date(first.occurredAt).toISOString();
  const pageFirstCreatedAt = new Date(first.createdAt).toISOString();

  const aggregate = await db.execute<{ balance: string }>(sql`
    SELECT
      (
        COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)
        - COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'),  0)
      )::text AS balance
    FROM ledger_entries
    WHERE user_id = ${userId}
      AND account_id = ${accountId}
      AND entry_type IN ('position_pnl', 'position_pnl_reversal')
      AND (
        occurred_at < ${pageFirstOccurredAt}
        OR (occurred_at = ${pageFirstOccurredAt} AND created_at < ${pageFirstCreatedAt})
      )
  `);

  const accountRows = await db
    .select({ startingBalance: accounts.startingBalance })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)))
    .limit(1);
  const startingBalance = new Decimal(accountRows[0]?.startingBalance ?? '0');

  // `numeric` comes back as a string — pass straight to Decimal to format
  // at exactly 2dp for the API contract. NEVER parseFloat: a numeric(18,4)
  // value at the edge of representable range would lose precision through
  // a JS double.
  const balanceRaw = aggregate[0]?.balance ?? '0';
  const runningBalanceAtFirstRow = startingBalance.plus(balanceRaw).toFixed(2);

  return { entries, runningBalanceAtFirstRow, hasMore };
}

/**
 * Aggregate per-account balances as starting_balance + ledger aggregate, the
 * ledger part computed in a single GROUP BY over the partial covering index
 * `ledger_user_account_direction_amount_pnl_idx`. Accounts with no ledger
 * entries are returned with their starting balance alone.
 *
 * Returns a Map keyed by `accountId`; callers should expect every requested
 * `accountId` to be present in the map (the explicit-default merge below
 * handles the no-entries case).
 */
export async function aggregateBalancesForAccounts(
  db: Database | Transaction,
  userId: string,
  accountIds: string[],
): Promise<Map<string, string>> {
  const balances = new Map<string, string>();
  for (const id of accountIds) {
    balances.set(id, '0.00');
  }
  if (accountIds.length === 0) {
    return balances;
  }

  // Seed with each account's user-entered starting balance. Kept at full
  // scale-4 precision in `startingBalances` — the map above holds the 2dp
  // API-contract rendering, so summing from it would drop sub-cent digits.
  const startingBalances = new Map<string, Decimal>();
  const accountRows = await db
    .select({ id: accounts.id, startingBalance: accounts.startingBalance })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), inArray(accounts.id, accountIds)));
  for (const row of accountRows) {
    startingBalances.set(row.id, new Decimal(row.startingBalance));
    balances.set(row.id, new Decimal(row.startingBalance).toFixed(2));
  }

  const rows = await db
    .select({
      accountId: ledgerEntries.accountId,
      balance: sql<string>`
        (
          COALESCE(SUM(${ledgerEntries.amount}) FILTER (WHERE ${ledgerEntries.direction} = 'credit'), 0)
          - COALESCE(SUM(${ledgerEntries.amount}) FILTER (WHERE ${ledgerEntries.direction} = 'debit'),  0)
        )::text
      `,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.userId, userId),
        inArray(ledgerEntries.accountId, accountIds),
        inArray(ledgerEntries.entryType, [...PNL_ENTRY_TYPES]),
      ),
    )
    .groupBy(ledgerEntries.accountId);

  for (const row of rows) {
    // `numeric` is a string; format at exactly 2dp for the API contract.
    const starting = startingBalances.get(row.accountId) ?? new Decimal(0);
    balances.set(row.accountId, starting.plus(row.balance).toFixed(2));
  }

  return balances;
}

/**
 * Look up the spot rate for `base → quote` as of `asOf` (a UTC date).
 *
 * Lookup order (Req 4.3):
 *   1. Direct (base → quote) with the latest `effectiveDate ≤ asOf`.
 *   2. Inverse of (quote → base) with the latest `effectiveDate ≤ asOf`,
 *      computed as `new Decimal(1).dividedBy(directRate)`.
 *   3. `source: null`.
 *
 * Triangulation is forbidden (Req 4.4) — we never chain through a third
 * currency.
 *
 * Intentional staleness ordering (Req 4.3 / Req 4.15): a direct rate wins
 * over an inverse regardless of which has the fresher `effectiveDate`. A
 * January `USD → GBP` direct rate beats a May `GBP → USD` inverse. This is
 * per requirements, NOT a bug — the user is responsible for keeping direct
 * and inverse rows mutually consistent, and the spec accepts that a
 * single-direction edit may produce a stale-direct/fresh-inverse window.
 * A future "fresher wins" change would be a deliberate amendment;
 * `accounting.query.test.ts` (Task 16) pins this ordering so it cannot
 * regress accidentally.
 *
 * Inverse precision: the returned `rate` is computed at the global Decimal
 * precision of 20 significant figures (pinned by `bootstrap()`) and returned
 * **unrounded**. Rounding to 4dp happens at the convert-amount call site
 * (Req 4.5), not here.
 *
 * `opts.upperBound` (optional): when supplied, the effective `asOf` used for
 * the row-selection date is clamped to `min(asOf, upperBound)`. Introduced for
 * the `expenses-tax` spec's tax-summary and fee-rollup year-end rate lookups
 * (design §Component 5, Open Q1 resolution): callers pass `asOf = new Date()`
 * (today) and `upperBound = ${year}-12-31T23:59:59.999Z` so that an
 * in-progress year picks today's rate while a past year is pinned to its
 * year-end. When omitted, behavior is bit-identical to the pre-extension
 * call path.
 *
 * `effectiveDate` (return field): the `effective_date` of the source row used
 * (direct or inverse), as a `YYYY-MM-DD` string; `null` when `source === null`.
 * Callers that need reproducibility (e.g. fee-rollup `usedRates`) record this
 * per-rate rather than the upper-bound `asOf` (Req 4.5.6).
 */
export async function findSpotRate(
  db: Database | Transaction,
  userId: string,
  base: string,
  quote: string,
  asOf: Date,
  opts?: { upperBound?: Date },
): Promise<{ rate: Decimal; source: 'direct' | 'inverse' | null; effectiveDate: string | null }> {
  // Clamp the effective asOf to the optional upperBound. When `upperBound`
  // is undefined this is a no-op and the path matches the pre-extension
  // behavior bit-for-bit.
  const effectiveAsOf = opts?.upperBound
    ? new Date(Math.min(asOf.getTime(), opts.upperBound.getTime()))
    : asOf;
  // `effective_date` is a UTC `date` column — we compare against the date
  // portion of `effectiveAsOf` as `YYYY-MM-DD`.
  const asOfDate = effectiveAsOf.toISOString().slice(0, 10);

  const directRows = await db
    .select({ rate: exchangeRates.rate, effectiveDate: exchangeRates.effectiveDate })
    .from(exchangeRates)
    .where(
      and(
        eq(exchangeRates.userId, userId),
        eq(exchangeRates.baseCurrency, base),
        eq(exchangeRates.quoteCurrency, quote),
        sql`${exchangeRates.effectiveDate} <= ${asOfDate}`,
      ),
    )
    .orderBy(desc(exchangeRates.effectiveDate))
    .limit(1);

  if (directRows.length > 0) {
    return {
      rate: new Decimal(directRows[0].rate),
      source: 'direct',
      effectiveDate: directRows[0].effectiveDate,
    };
  }

  const inverseRows = await db
    .select({ rate: exchangeRates.rate, effectiveDate: exchangeRates.effectiveDate })
    .from(exchangeRates)
    .where(
      and(
        eq(exchangeRates.userId, userId),
        eq(exchangeRates.baseCurrency, quote),
        eq(exchangeRates.quoteCurrency, base),
        sql`${exchangeRates.effectiveDate} <= ${asOfDate}`,
      ),
    )
    .orderBy(desc(exchangeRates.effectiveDate))
    .limit(1);

  if (inverseRows.length > 0) {
    // Unrounded `1 / rate` at the pinned global precision. The convert
    // call site rounds to 4dp.
    return {
      rate: new Decimal(1).dividedBy(new Decimal(inverseRows[0].rate)),
      source: 'inverse',
      effectiveDate: inverseRows[0].effectiveDate,
    };
  }

  return { rate: new Decimal(0), source: null, effectiveDate: null };
}

/**
 * Look up the user's preferred display currency. Returns `null` when the user
 * has not yet picked one (the pre-first-account window). Service callers use
 * this to short-circuit dashboard / preview aggregates that are not meaningful
 * before a display currency is chosen.
 */
export async function findUserDisplayCurrency(
  db: Database | Transaction,
  userId: string,
): Promise<string | null> {
  const rows = await db
    .select({ displayCurrency: users.displayCurrency })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (rows.length === 0) return null;
  return rows[0].displayCurrency ?? null;
}

/**
 * Set the user's preferred `display_currency` (unconditional — overwrites any
 * prior value). The route layer guards this behind authentication; only the
 * authenticated user may update their own row.
 */
export async function setUserDisplayCurrency(
  db: Database | Transaction,
  userId: string,
  currency: string,
): Promise<void> {
  await db.update(users).set({ displayCurrency: currency }).where(eq(users.id, userId));
}

/**
 * Look up a single exchange-rate row by id, scoped to the owning user. Returns
 * `null` if the row does not exist or belongs to a different user. The
 * `previewRateChangeImpact` service uses this to close the concurrent-tab race
 * where Tab A previews a delete after Tab B has committed it.
 */
export async function findExchangeRateById(
  db: Database | Transaction,
  userId: string,
  id: string,
): Promise<ExchangeRateRow | null> {
  const rows = await db
    .select()
    .from(exchangeRates)
    .where(and(eq(exchangeRates.id, id), eq(exchangeRates.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

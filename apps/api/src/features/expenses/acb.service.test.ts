/**
 * ca-acb-pooling task 6 — the ACB loader (design C4; requirements AC 3.2,
 * 3.9, 3.10, 4.3, 4.7, 5.7, 6.2, 6.3, NFR Performance, NFR Reliability, NFR
 * Security).
 *
 * `getAcbDispositionsForYear` and the three queries it batches
 * (`listTaxableFillsForAcb`, `listCadRatesForUser`, `listTransferLinksForUser`)
 * do not exist at base — every case below fails at import before it fails on
 * an assertion. Runs against the real test database via `src/test-setup.ts`
 * (migrations already applied; each test wrapped in a rolled-back
 * transaction). Links are seeded by direct inserts into the task 1
 * `fill_transfer_links` table — the write route (task 9) does not exist yet.
 *
 * Contract:
 *  1. a registered account's fills produce no row and do not change a
 *     taxable row (AC 3.2). Pre: one taxable and one registered account,
 *     same symbol/side, the registered side funded with figures that would
 *     visibly distort the taxable pool's ACB share if wrongly counted.
 *     Call: getAcbDispositionsForYear(db, userId, 2026). Observe: exactly
 *     one row (the taxable exit) with the ACB the taxable-only pool implies.
 *     Source: design C4 query `listTaxableFillsForAcb` ("Registered fills
 *     never enter"), requirements AC 3.2.
 *  2. a USD fill with a rate dated on its trade date prices, both entry and
 *     exit (AC 4.3). Pre: a USD account with a direct USD/CAD rate on each
 *     fill's exact trade date. Call: getAcbDispositionsForYear(...).
 *     Observe: a priced row whose cadRate, proceeds, acb and gain reflect
 *     each fill's own exact-date rate. Source: design C4 post-condition 2,
 *     requirements AC 4.3.
 *  3. a rate dated the day before the exit's trade date leaves it
 *     missing_rate (AC 4.3 — exact date only, unlike findSpotRate). Pre: the
 *     entry's trade date is rated so the pool itself is priced; the exit's
 *     trade date has no rate, only the day before. Call:
 *     getAcbDispositionsForYear(...). Observe: one row, reason
 *     'missing_rate', all four money fields and cadRate null, and the
 *     top-level missingRates list carries exactly the exit's own
 *     (currency, trade date) pair. Source: design C4 post-condition 2,
 *     requirements AC 4.3, 4.5.
 *  4. an inverse CAD/USD row prices a fill at 1 ÷ rate (AC 4.3). Pre: only
 *     (CAD, USD) rows stored for both the entry's and exit's trade dates, no
 *     (USD, CAD) row. Call: getAcbDispositionsForYear(...). Observe: the
 *     row's cadRate is 1 ÷ the stored rate and proceeds/acb/gain are
 *     computed from it. Source: design C4 post-condition 2, requirements
 *     AC 4.3.
 *  5. a 2025 entry feeds a 2026 exit's ACB and only 2026 rows return (AC
 *     3.9). Pre: one entry and two exits of the same pool — one exit in
 *     2025, one in 2026 — so the 2026 exit's ACB share depends on the pool
 *     already having shrunk from the 2025 exit. Call:
 *     getAcbDispositionsForYear(db, userId, 2026). Observe: exactly one row
 *     (the 2026 exit) whose ACB reflects the pool state after the 2025
 *     exit, not the original entry amount. Source: design C4 post-condition
 *     4, requirements AC 3.3, 3.9.
 *  6. a fill filled at 2027-01-01T00:00:00Z is not read for 2026 (AC 3.9).
 *     Pre: an entry in 2026 and an exit at exactly the half-open upper
 *     boundary of the year-2026 window. Call:
 *     getAcbDispositionsForYear(db, userId, 2026). Observe: no row — the
 *     boundary fill is not surfaced for 2026. Source: design C4
 *     post-condition 1 (the fills `before` bound is `${year+1}-01-01…`,
 *     half-open), requirements AC 3.9.
 *  7. deleting a position removes its fills from the next result (AC 5.7).
 *     Pre: one taxable position with an entry and a matching exit. Call:
 *     getAcbDispositionsForYear once (observing the row), delete the
 *     position (its fills cascade), then call again. Observe: the second
 *     call returns no rows. Source: design C4 query `listTaxableFillsForAcb`
 *     ("Deleted positions have no fills"), requirements AC 5.7.
 *  8. a valid taxable-to-taxable link removes both fills' effect and
 *     returns the entry in ignoredEntryFillIds (AC 6.2). Pre: an entry and
 *     an at-cost transfer-out exit in account A, a transfer-in entry in
 *     taxable account B, and a final exit in B selling the transferred
 *     position at a price that would realise a different gain if the
 *     transfer pair were wrongly counted. Call:
 *     getAcbDispositionsForYear(...). Observe: one row (the final exit)
 *     whose ACB is the original entry's cost, not the transfer-out's
 *     price, and ignoredEntryFillIds holds the transfer-in entry's id, not
 *     the original entry's. Source: design C4 post-condition 3, 4,
 *     requirements AC 6.2.
 *  9. a taxable-to-registered link leaves the taxable exit an ordinary
 *     disposition (AC 6.3). Pre: a taxable exit linked to a registered
 *     entry (a contribution in kind). Call: getAcbDispositionsForYear(...).
 *     Observe: one row for the taxable exit, priced at its own recorded
 *     price against the pool it actually sat in, and an empty
 *     ignoredEntryFillIds. Source: design C4 post-condition 3 ("a link with
 *     a registered side adds nothing"), requirements AC 6.3.
 * 10. an invalid link is ignored and logged (NFR Reliability). Pre: a
 *     stored link whose two fills' quantities differ (quantity_mismatch) —
 *     seeded directly, bypassing the not-yet-built write-path validation.
 *     Call: getAcbDispositionsForYear(...). Observe: the linked fills are
 *     NOT excluded from the pool (the exit still realises against both
 *     accounts' combined entries) and logger.warn fires once with
 *     'acb_transfer_link_invalid' naming the link id. Source: design C4
 *     post-condition 3, requirements NFR Reliability.
 * 11. missingRates lists each pair once, sorted (AC 4.7). Pre: two pools —
 *     one USD pool whose unpriced entry taints two later exits with the
 *     same (currency, trade date) pair (a duplicate across rows), and one
 *     GBP pool whose exit alone is missing a different pair. Call:
 *     getAcbDispositionsForYear(...). Observe: the top-level missingRates
 *     has exactly two entries, the USD/GBP duplicate collapsed to one, in
 *     currency-then-date order. Source: design C4 post-condition 4,
 *     requirements AC 4.7.
 * 12. the function is deterministic for equal inputs (AC 3.10). Pre: one
 *     simple taxable entry/exit pair. Call: getAcbDispositionsForYear(db,
 *     userId, 2026) twice against the same unchanged data. Observe: the two
 *     results serialise identically. Source: design C3 post-condition 10 /
 *     C4 (the loader composes the pure engine with its own batched reads),
 *     requirements AC 3.10.
 * 13. three queries per call whatever the fill count (NFR Performance). Pre:
 *     one taxable position with six fills. Call: getAcbDispositionsForYear
 *     once, having spied (pass-through, not mocked) on
 *     listTaxableFillsForAcb, listCadRatesForUser and
 *     listTransferLinksForUser. Observe: each of the three is called
 *     exactly once, not once per fill. Source: design C4 "each one
 *     statement"; requirements NFR Performance.
 * 14. every query filters by user_id — another user's fills, rates and
 *     links never enter (NFR Security). Pre: two users, each with a taxable
 *     USD position; user B's entry has no rate on its trade date, so a leak
 *     would surface in user A's row set or missingRates. Call:
 *     getAcbDispositionsForYear(db, userA.id, 2026). Observe: the result
 *     contains only user A's row and no trace of user B's symbol or missing
 *     pair. Source: design C4 ("each filtered by user_id"), requirements
 *     NFR Security.
 */
import Decimal from 'decimal.js';
import { eq } from 'drizzle-orm';
import { describe, it, expect, vi } from 'vitest';

import { db } from '@/db';
import { accounts, exchangeRates, fillTransferLinks, fills, positions, users } from '@/db/schema';
import { createPosition } from '@/features/positions/positions.service';
import { logger } from '@/lib/logger';

import { getAcbDispositionsForYear } from './acb.service';
import * as expensesQuery from './expenses.query';

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

let counter = 0;

function uniqueEmail(): string {
  return `acbsvc-${Date.now()}-${++counter}@example.com`;
}

async function seedUser(): Promise<{ id: string }> {
  const [user] = await db
    .insert(users)
    .values({ email: uniqueEmail(), passwordHash: 'x'.repeat(60) })
    .returning();
  return { id: user!.id };
}

async function seedAccount(
  userId: string,
  opts: { currency: string; taxTreatment: 'taxable' | 'registered'; timezone?: string },
): Promise<{ id: string }> {
  const [account] = await db
    .insert(accounts)
    .values({
      userId,
      name: `Acct-${++counter}`,
      currency: opts.currency,
      timezone: opts.timezone ?? 'UTC',
      taxTreatment: opts.taxTreatment,
    })
    .returning();
  return { id: account!.id };
}

async function seedPosition(
  userId: string,
  accountId: string,
  opts: { symbol: string; side: 'long' | 'short'; assetType?: 'stock' | 'option' },
): Promise<{ id: string }> {
  const position = await createPosition(
    db,
    userId,
    { accountId, symbol: opts.symbol, side: opts.side, assetType: opts.assetType ?? 'stock' },
    { isAdmin: false },
  );
  return { id: position.id };
}

async function seedFill(
  positionId: string,
  opts: {
    type: 'entry' | 'exit';
    price: string;
    quantity: string;
    fees?: string;
    filledAt: string;
  },
): Promise<{ id: string }> {
  const [fill] = await db
    .insert(fills)
    .values({
      positionId,
      type: opts.type,
      price: opts.price,
      quantity: opts.quantity,
      fees: opts.fees ?? '0',
      filledAt: new Date(opts.filledAt),
    })
    .returning();
  return { id: fill!.id };
}

async function seedRate(
  userId: string,
  opts: { base: string; quote: string; rate: string; effectiveDate: string },
): Promise<void> {
  await db.insert(exchangeRates).values({
    userId,
    baseCurrency: opts.base,
    quoteCurrency: opts.quote,
    rate: opts.rate,
    effectiveDate: opts.effectiveDate,
  });
}

async function seedLink(
  userId: string,
  exitFillId: string,
  entryFillId: string,
): Promise<{ id: string }> {
  const [link] = await db
    .insert(fillTransferLinks)
    .values({ userId, exitFillId, entryFillId })
    .returning();
  return { id: link!.id };
}

function str(x: Decimal | null | undefined): string | null {
  return x === null || x === undefined ? null : x.toString();
}

// ---------------------------------------------------------------------------
// 1. AC 3.2 — registered accounts never enter the pool
// ---------------------------------------------------------------------------

describe('getAcbDispositionsForYear — registered accounts excluded (AC 3.2)', () => {
  it("a registered account's fills produce no row and do not change a taxable row", async () => {
    const user = await seedUser();
    const taxAcct = await seedAccount(user.id, { currency: 'CAD', taxTreatment: 'taxable' });
    const regAcct = await seedAccount(user.id, { currency: 'CAD', taxTreatment: 'registered' });
    const posTax = await seedPosition(user.id, taxAcct.id, { symbol: 'AAPL', side: 'long' });
    const posReg = await seedPosition(user.id, regAcct.id, { symbol: 'AAPL', side: 'long' });

    await seedFill(posReg.id, {
      type: 'entry',
      price: '1.00',
      quantity: '1000',
      filledAt: '2026-01-01T00:00:00Z',
    });
    await seedFill(posTax.id, {
      type: 'entry',
      price: '10.00',
      quantity: '100',
      filledAt: '2026-01-02T00:00:00Z',
    });
    const taxExit = await seedFill(posTax.id, {
      type: 'exit',
      price: '12.00',
      quantity: '50',
      filledAt: '2026-01-03T00:00:00Z',
    });
    await seedFill(posReg.id, {
      type: 'exit',
      price: '2.00',
      quantity: '500',
      filledAt: '2026-01-04T00:00:00Z',
    });

    const result = await getAcbDispositionsForYear(db, user.id, 2026);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.exitFillId).toBe(taxExit.id);
    expect(str(result.rows[0]!.proceeds)).toBe('600');
    expect(str(result.rows[0]!.acb)).toBe('500');
    expect(str(result.rows[0]!.gain)).toBe('100');
  });
});

// ---------------------------------------------------------------------------
// 2-4. AC 4.3 — exact trade-date CAD conversion
// ---------------------------------------------------------------------------

describe('getAcbDispositionsForYear — exact trade-date rate (AC 4.3)', () => {
  it('a USD fill with a rate dated on its trade date prices', async () => {
    const user = await seedUser();
    const acct = await seedAccount(user.id, {
      currency: 'USD',
      taxTreatment: 'taxable',
      timezone: 'UTC',
    });
    const pos = await seedPosition(user.id, acct.id, { symbol: 'MSFT', side: 'long' });

    await seedRate(user.id, {
      base: 'USD',
      quote: 'CAD',
      rate: '1.35',
      effectiveDate: '2026-02-02',
    });
    await seedRate(user.id, {
      base: 'USD',
      quote: 'CAD',
      rate: '1.40',
      effectiveDate: '2026-02-03',
    });

    await seedFill(pos.id, {
      type: 'entry',
      price: '10.00',
      quantity: '100',
      filledAt: '2026-02-02T15:00:00Z',
    });
    const exit = await seedFill(pos.id, {
      type: 'exit',
      price: '12.00',
      quantity: '50',
      filledAt: '2026-02-03T15:00:00Z',
    });

    const result = await getAcbDispositionsForYear(db, user.id, 2026);

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.exitFillId).toBe(exit.id);
    expect(row.unpricedReason).toBeNull();
    expect(str(row.cadRate)).toBe('1.4');
    expect(str(row.proceeds)).toBe('840');
    expect(str(row.acb)).toBe('675');
    expect(str(row.gain)).toBe('165');
  });

  it('a rate dated the day before the trade date leaves the exit missing_rate', async () => {
    const user = await seedUser();
    const acct = await seedAccount(user.id, {
      currency: 'USD',
      taxTreatment: 'taxable',
      timezone: 'UTC',
    });
    const pos = await seedPosition(user.id, acct.id, { symbol: 'NFLX', side: 'long' });

    // Only the entry's trade date is rated — the pool itself is priced.
    await seedRate(user.id, {
      base: 'USD',
      quote: 'CAD',
      rate: '1.30',
      effectiveDate: '2026-03-02',
    });

    await seedFill(pos.id, {
      type: 'entry',
      price: '10.00',
      quantity: '10',
      filledAt: '2026-03-02T12:00:00Z',
    });
    // The exit's own trade date (2026-03-03) has no rate; only the day
    // before does. findSpotRate's "latest on or before" would wrongly use
    // it — AC 4.3 forbids that.
    const exit = await seedFill(pos.id, {
      type: 'exit',
      price: '12.00',
      quantity: '5',
      filledAt: '2026-03-03T12:00:00Z',
    });

    const result = await getAcbDispositionsForYear(db, user.id, 2026);

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.exitFillId).toBe(exit.id);
    expect(row.unpricedReason).toBe('missing_rate');
    expect(str(row.cadRate)).toBeNull();
    expect(str(row.proceeds)).toBeNull();
    expect(str(row.outlays)).toBeNull();
    expect(str(row.acb)).toBeNull();
    expect(str(row.gain)).toBeNull();
    expect(result.missingRates).toEqual([{ currency: 'USD', tradeDate: '2026-03-03' }]);
  });

  it('an inverse CAD/USD row prices a fill at 1 ÷ rate', async () => {
    const user = await seedUser();
    const acct = await seedAccount(user.id, {
      currency: 'USD',
      taxTreatment: 'taxable',
      timezone: 'UTC',
    });
    const pos = await seedPosition(user.id, acct.id, { symbol: 'GOOG', side: 'long' });

    // Only the inverse pair (CAD, USD) is stored — no direct (USD, CAD) row.
    await seedRate(user.id, {
      base: 'CAD',
      quote: 'USD',
      rate: '0.8',
      effectiveDate: '2026-04-01',
    });
    await seedRate(user.id, {
      base: 'CAD',
      quote: 'USD',
      rate: '0.8',
      effectiveDate: '2026-04-02',
    });

    await seedFill(pos.id, {
      type: 'entry',
      price: '10.00',
      quantity: '10',
      filledAt: '2026-04-01T00:00:00Z',
    });
    const exit = await seedFill(pos.id, {
      type: 'exit',
      price: '15.00',
      quantity: '10',
      filledAt: '2026-04-02T00:00:00Z',
    });

    const result = await getAcbDispositionsForYear(db, user.id, 2026);

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.exitFillId).toBe(exit.id);
    expect(row.unpricedReason).toBeNull();
    expect(str(row.cadRate)).toBe('1.25');
    expect(str(row.proceeds)).toBe('187.5');
    expect(str(row.acb)).toBe('125');
    expect(str(row.gain)).toBe('62.5');
  });
});

// ---------------------------------------------------------------------------
// 5-6. AC 3.9 — UTC-year bucketing
// ---------------------------------------------------------------------------

describe('getAcbDispositionsForYear — UTC-year bucketing (AC 3.9)', () => {
  it("a 2025 entry feeds a 2026 exit's ACB and only 2026 rows return", async () => {
    const user = await seedUser();
    const acct = await seedAccount(user.id, { currency: 'CAD', taxTreatment: 'taxable' });
    const pos = await seedPosition(user.id, acct.id, { symbol: 'IBM', side: 'long' });

    await seedFill(pos.id, {
      type: 'entry',
      price: '10.00',
      quantity: '100',
      filledAt: '2025-06-01T00:00:00Z',
    });
    await seedFill(pos.id, {
      type: 'exit',
      price: '11.00',
      quantity: '20',
      filledAt: '2025-07-01T00:00:00Z',
    });
    const exit2026 = await seedFill(pos.id, {
      type: 'exit',
      price: '12.00',
      quantity: '30',
      filledAt: '2026-01-15T00:00:00Z',
    });

    const result = await getAcbDispositionsForYear(db, user.id, 2026);

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.exitFillId).toBe(exit2026.id);
    expect(str(row.proceeds)).toBe('360');
    expect(str(row.acb)).toBe('300');
    expect(str(row.gain)).toBe('60');
  });

  it('a fill filled at 2027-01-01T00:00:00Z is not read for 2026', async () => {
    const user = await seedUser();
    const acct = await seedAccount(user.id, { currency: 'CAD', taxTreatment: 'taxable' });
    const pos = await seedPosition(user.id, acct.id, { symbol: 'ORCL', side: 'long' });

    await seedFill(pos.id, {
      type: 'entry',
      price: '10.00',
      quantity: '10',
      filledAt: '2026-06-01T00:00:00Z',
    });
    await seedFill(pos.id, {
      type: 'exit',
      price: '11.00',
      quantity: '10',
      filledAt: '2027-01-01T00:00:00Z',
    });

    const result = await getAcbDispositionsForYear(db, user.id, 2026);

    expect(result.rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. AC 5.7 — deleted positions leave the pool
// ---------------------------------------------------------------------------

describe('getAcbDispositionsForYear — position deletion (AC 5.7)', () => {
  it('deleting a position removes its fills from the next result', async () => {
    const user = await seedUser();
    const acct = await seedAccount(user.id, { currency: 'CAD', taxTreatment: 'taxable' });
    const pos = await seedPosition(user.id, acct.id, { symbol: 'DEL', side: 'long' });

    await seedFill(pos.id, {
      type: 'entry',
      price: '10.00',
      quantity: '10',
      filledAt: '2026-01-01T00:00:00Z',
    });
    await seedFill(pos.id, {
      type: 'exit',
      price: '12.00',
      quantity: '10',
      filledAt: '2026-01-02T00:00:00Z',
    });

    const before = await getAcbDispositionsForYear(db, user.id, 2026);
    expect(before.rows).toHaveLength(1);
    expect(str(before.rows[0]!.gain)).toBe('20');

    await db.delete(positions).where(eq(positions.id, pos.id));

    const after = await getAcbDispositionsForYear(db, user.id, 2026);
    expect(after.rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8-9. Requirement 6 — in-kind transfer links
// ---------------------------------------------------------------------------

describe('getAcbDispositionsForYear — taxable-to-taxable link (AC 6.2)', () => {
  it("a valid taxable-to-taxable link removes both fills' effect and returns the entry in ignoredEntryFillIds", async () => {
    const user = await seedUser();
    const acctA = await seedAccount(user.id, { currency: 'CAD', taxTreatment: 'taxable' });
    const acctB = await seedAccount(user.id, { currency: 'CAD', taxTreatment: 'taxable' });
    const posA = await seedPosition(user.id, acctA.id, { symbol: 'XFER', side: 'long' });
    const posB = await seedPosition(user.id, acctB.id, { symbol: 'XFER', side: 'long' });

    await seedFill(posA.id, {
      type: 'entry',
      price: '10.00',
      quantity: '100',
      filledAt: '2026-01-01T00:00:00Z',
    });
    // Transfer-out: priced well away from the original cost, so a wrongly
    // counted disposition here would be unmistakable.
    const transferOut = await seedFill(posA.id, {
      type: 'exit',
      price: '15.00',
      quantity: '100',
      filledAt: '2026-02-01T00:00:00Z',
    });
    const transferIn = await seedFill(posB.id, {
      type: 'entry',
      price: '10.00',
      quantity: '100',
      filledAt: '2026-02-01T00:00:00Z',
    });
    const finalExit = await seedFill(posB.id, {
      type: 'exit',
      price: '12.00',
      quantity: '100',
      filledAt: '2026-03-01T00:00:00Z',
    });

    await seedLink(user.id, transferOut.id, transferIn.id);

    const result = await getAcbDispositionsForYear(db, user.id, 2026);

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.exitFillId).toBe(finalExit.id);
    // ACB carries the original entry's cost (1000), not the transfer-out's
    // price — proving the transfer pair never touched the pool.
    expect(str(row.acb)).toBe('1000');
    expect(str(row.gain)).toBe('200');
    expect(result.ignoredEntryFillIds.has(transferIn.id)).toBe(true);
    expect(result.ignoredEntryFillIds.size).toBe(1);
  });
});

describe('getAcbDispositionsForYear — taxable-to-registered link (AC 6.3)', () => {
  it('a taxable-to-registered link leaves the taxable exit an ordinary disposition', async () => {
    const user = await seedUser();
    const taxAcct = await seedAccount(user.id, { currency: 'CAD', taxTreatment: 'taxable' });
    const regAcct = await seedAccount(user.id, { currency: 'CAD', taxTreatment: 'registered' });
    const posTax = await seedPosition(user.id, taxAcct.id, { symbol: 'INK', side: 'long' });
    const posReg = await seedPosition(user.id, regAcct.id, { symbol: 'INK', side: 'long' });

    await seedFill(posTax.id, {
      type: 'entry',
      price: '10.00',
      quantity: '100',
      filledAt: '2026-01-01T00:00:00Z',
    });
    const taxExit = await seedFill(posTax.id, {
      type: 'exit',
      price: '15.00',
      quantity: '100',
      filledAt: '2026-02-01T00:00:00Z',
    });
    const regEntry = await seedFill(posReg.id, {
      type: 'entry',
      price: '10.00',
      quantity: '100',
      filledAt: '2026-02-01T00:00:00Z',
    });

    await seedLink(user.id, taxExit.id, regEntry.id);

    const result = await getAcbDispositionsForYear(db, user.id, 2026);

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.exitFillId).toBe(taxExit.id);
    expect(str(row.proceeds)).toBe('1500');
    expect(str(row.acb)).toBe('1000');
    expect(str(row.gain)).toBe('500');
    expect(result.ignoredEntryFillIds.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 10. NFR Reliability — invalid stored link
// ---------------------------------------------------------------------------

describe('getAcbDispositionsForYear — invalid link (NFR Reliability)', () => {
  it('an invalid link (mismatched quantities) is ignored and logged', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const user = await seedUser();
    const acctA = await seedAccount(user.id, { currency: 'CAD', taxTreatment: 'taxable' });
    const acctB = await seedAccount(user.id, { currency: 'CAD', taxTreatment: 'taxable' });
    const posA = await seedPosition(user.id, acctA.id, { symbol: 'BAD', side: 'long' });
    const posB = await seedPosition(user.id, acctB.id, { symbol: 'BAD', side: 'long' });

    await seedFill(posA.id, {
      type: 'entry',
      price: '10.00',
      quantity: '100',
      filledAt: '2026-01-01T00:00:00Z',
    });
    const exit = await seedFill(posA.id, {
      type: 'exit',
      price: '15.00',
      quantity: '100',
      filledAt: '2026-02-01T00:00:00Z',
    });
    // Quantity (40) differs from the exit's (100) — AC 6.1 refuses this at
    // write time, but this row is seeded directly to simulate a stored
    // invalid link the read path must defend against.
    const entry = await seedFill(posB.id, {
      type: 'entry',
      price: '10.00',
      quantity: '40',
      filledAt: '2026-01-15T00:00:00Z',
    });
    const link = await seedLink(user.id, exit.id, entry.id);

    const result = await getAcbDispositionsForYear(db, user.id, 2026);

    // Ignored, not applied: the exit still realises against the combined
    // pool of both accounts' entries (140 @ 1400 total cost).
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.exitFillId).toBe(exit.id);
    expect(str(row.acb)).toBe('1000');
    expect(str(row.gain)).toBe('500');

    expect(warnSpy).toHaveBeenCalledWith(
      'acb_transfer_link_invalid',
      expect.objectContaining({ event: 'acb_transfer_link_invalid', linkId: link.id }),
    );

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 11. AC 4.7 — missingRates sorted and distinct
// ---------------------------------------------------------------------------

describe('getAcbDispositionsForYear — missingRates (AC 4.7)', () => {
  it('missingRates lists each pair once, sorted by currency then date', async () => {
    const user = await seedUser();
    const acctUsd = await seedAccount(user.id, {
      currency: 'USD',
      taxTreatment: 'taxable',
      timezone: 'UTC',
    });
    const acctGbp = await seedAccount(user.id, {
      currency: 'GBP',
      taxTreatment: 'taxable',
      timezone: 'UTC',
    });
    const posUsd = await seedPosition(user.id, acctUsd.id, { symbol: 'MMA', side: 'long' });
    const posGbp = await seedPosition(user.id, acctGbp.id, { symbol: 'MMB', side: 'long' });

    // MMA's entry has no rate — every later exit of its pool is
    // pool_unpriced on the SAME (USD, 2026-05-01) pair.
    await seedFill(posUsd.id, {
      type: 'entry',
      price: '10.00',
      quantity: '10',
      filledAt: '2026-05-01T00:00:00Z',
    });
    await seedRate(user.id, {
      base: 'USD',
      quote: 'CAD',
      rate: '1.3',
      effectiveDate: '2026-05-02',
    });
    await seedRate(user.id, {
      base: 'USD',
      quote: 'CAD',
      rate: '1.3',
      effectiveDate: '2026-05-03',
    });
    await seedFill(posUsd.id, {
      type: 'exit',
      price: '12.00',
      quantity: '5',
      filledAt: '2026-05-02T00:00:00Z',
    });
    await seedFill(posUsd.id, {
      type: 'exit',
      price: '13.00',
      quantity: '5',
      filledAt: '2026-05-03T00:00:00Z',
    });

    // MMB's own exit rate is missing, a distinct pair.
    await seedRate(user.id, {
      base: 'GBP',
      quote: 'CAD',
      rate: '1.6',
      effectiveDate: '2026-06-01',
    });
    await seedFill(posGbp.id, {
      type: 'entry',
      price: '10.00',
      quantity: '10',
      filledAt: '2026-06-01T00:00:00Z',
    });
    await seedFill(posGbp.id, {
      type: 'exit',
      price: '12.00',
      quantity: '10',
      filledAt: '2026-06-02T00:00:00Z',
    });

    const result = await getAcbDispositionsForYear(db, user.id, 2026);

    expect(result.rows).toHaveLength(3);
    expect(result.missingRates).toEqual([
      { currency: 'GBP', tradeDate: '2026-06-02' },
      { currency: 'USD', tradeDate: '2026-05-01' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 12. AC 3.10 — determinism
// ---------------------------------------------------------------------------

describe('getAcbDispositionsForYear — determinism (AC 3.10)', () => {
  it('two calls against unchanged data return identical results', async () => {
    const user = await seedUser();
    const acct = await seedAccount(user.id, { currency: 'CAD', taxTreatment: 'taxable' });
    const pos = await seedPosition(user.id, acct.id, { symbol: 'DET', side: 'long' });

    await seedFill(pos.id, {
      type: 'entry',
      price: '10.00',
      quantity: '10',
      filledAt: '2026-01-01T00:00:00Z',
    });
    await seedFill(pos.id, {
      type: 'exit',
      price: '12.00',
      quantity: '10',
      filledAt: '2026-01-02T00:00:00Z',
    });

    function serialize(result: Awaited<ReturnType<typeof getAcbDispositionsForYear>>) {
      return {
        rows: result.rows.map((r) => ({
          exitFillId: r.exitFillId,
          symbol: r.symbol,
          tradeDate: r.tradeDate,
          realisedAt: r.realisedAt.toISOString(),
          quantity: str(r.quantity),
          cadRate: str(r.cadRate),
          proceeds: str(r.proceeds),
          outlays: str(r.outlays),
          acb: str(r.acb),
          gain: str(r.gain),
          unpricedReason: r.unpricedReason,
        })),
        missingRates: result.missingRates,
        ignoredEntryFillIds: [...result.ignoredEntryFillIds].sort(),
      };
    }

    const first = serialize(await getAcbDispositionsForYear(db, user.id, 2026));
    const second = serialize(await getAcbDispositionsForYear(db, user.id, 2026));

    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// 13. NFR Performance — batched, not per-fill
// ---------------------------------------------------------------------------

describe('getAcbDispositionsForYear — batched reads (NFR Performance)', () => {
  it('calls each of the three loader queries exactly once regardless of fill count', async () => {
    const user = await seedUser();
    const acct = await seedAccount(user.id, { currency: 'CAD', taxTreatment: 'taxable' });
    const pos = await seedPosition(user.id, acct.id, { symbol: 'BATCH', side: 'long' });

    for (let i = 0; i < 3; i++) {
      await seedFill(pos.id, {
        type: 'entry',
        price: '10.00',
        quantity: '10',
        filledAt: `2026-01-0${i + 1}T00:00:00Z`,
      });
      await seedFill(pos.id, {
        type: 'exit',
        price: '12.00',
        quantity: '10',
        filledAt: `2026-02-0${i + 1}T00:00:00Z`,
      });
    }

    const fillsSpy = vi.spyOn(expensesQuery, 'listTaxableFillsForAcb');
    const ratesSpy = vi.spyOn(expensesQuery, 'listCadRatesForUser');
    const linksSpy = vi.spyOn(expensesQuery, 'listTransferLinksForUser');

    const result = await getAcbDispositionsForYear(db, user.id, 2026);
    expect(result.rows).toHaveLength(3);

    expect(fillsSpy).toHaveBeenCalledTimes(1);
    expect(ratesSpy).toHaveBeenCalledTimes(1);
    expect(linksSpy).toHaveBeenCalledTimes(1);

    fillsSpy.mockRestore();
    ratesSpy.mockRestore();
    linksSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 14. NFR Security — user_id isolation
// ---------------------------------------------------------------------------

describe('getAcbDispositionsForYear — user isolation (NFR Security)', () => {
  it("another user's fills, rates and links never enter the result", async () => {
    const userA = await seedUser();
    const acctA = await seedAccount(userA.id, { currency: 'CAD', taxTreatment: 'taxable' });
    const posA = await seedPosition(userA.id, acctA.id, { symbol: 'SAFE', side: 'long' });
    await seedFill(posA.id, {
      type: 'entry',
      price: '10.00',
      quantity: '10',
      filledAt: '2026-01-01T00:00:00Z',
    });
    const exitA = await seedFill(posA.id, {
      type: 'exit',
      price: '12.00',
      quantity: '10',
      filledAt: '2026-01-02T00:00:00Z',
    });

    const userB = await seedUser();
    const acctB = await seedAccount(userB.id, {
      currency: 'USD',
      taxTreatment: 'taxable',
      timezone: 'UTC',
    });
    const posB = await seedPosition(userB.id, acctB.id, { symbol: 'LEAK', side: 'long' });
    // No rate seeded at all — if user B's data leaked, this would surface
    // in user A's missingRates.
    await seedFill(posB.id, {
      type: 'entry',
      price: '10.00',
      quantity: '10',
      filledAt: '2026-01-01T00:00:00Z',
    });
    await seedFill(posB.id, {
      type: 'exit',
      price: '12.00',
      quantity: '10',
      filledAt: '2026-01-02T00:00:00Z',
    });

    const result = await getAcbDispositionsForYear(db, userA.id, 2026);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.exitFillId).toBe(exitA.id);
    expect(result.rows[0]!.symbol).toBe('SAFE');
    expect(result.missingRates).toEqual([]);
    expect(result.ignoredEntryFillIds.size).toBe(0);
  });
});

import Decimal from 'decimal.js';
import { describe, it, expect } from 'vitest';

import {
  computeAcbDispositions,
  tradeDateKey,
  type AcbFill,
  type AcbDisposition,
} from './acb-pool';

// ---------------------------------------------------------------------------
// Contract block — one entry per success criterion named in task 4's prompt
// (design C3 post-conditions 1-10 / requirements AC 3.1, 3.3-3.8, 3.10, 3.11,
// 4.1, 4.2, 4.4-4.6). `apps/api/src/features/expenses/acb-pool.ts` does not
// exist at base: every case below fails at import before it fails on an
// assertion.
//
// 1. tradeDateKey crosses UTC midnight (AC 4.2)
//    Pre-condition: a Date at 2026-03-03T02:30:00Z.
//    Call: tradeDateKey(at, timeZone).
//    Observable: '2026-03-02' in America/New_York, '2026-03-03' in UTC.
//    Source: design C3 post-condition 1 (probe-zoned-date.mjs cited there).
//
// 2. fills are processed in canonical order, not input array order (AC 3.3)
//    Pre-condition: two entries tied on filledAt and createdAt, and an exit
//    at the same filledAt but a later createdAt, fed to the function in
//    exit-first array order.
//    Call: computeAcbDispositions(fills, cadRateFor, ignoredFillIds).
//    Observable: the exit sees both entries already pooled (reason
//    'pool_unpriced', not 'insufficient_pool' from an empty pool).
//    Source: design C3 post-condition 2, requirements AC 3.3.
//
// 3. pool key is (symbol, side) — a same-symbol opposite-side pool and a
//    different-symbol pool never contaminate it (AC 3.1)
//    Pre-condition: XYZ long, XYZ short and ABC long pools funded; one XYZ
//    long exit.
//    Call: computeAcbDispositions(...).
//    Observable: the exit's ACB reflects only the XYZ-long pool's amount.
//    Source: design C3 post-condition 3, requirements AC 3.1.
//
// 4. CAD fills take no rate lookup; a foreign fill's row carries the looked
//    up rate (AC 4.1)
//    Pre-condition: a CAD entry and a USD exit; cadRateFor throws if called
//    with 'CAD'.
//    Call: computeAcbDispositions(...).
//    Observable: no throw, and the row's cadRate equals the USD rate used.
//    Source: design C3 post-condition 4 and 7, requirements AC 4.1.
//
// 5. the AC 3.11 worked example (AC 3.11)
//    Pre-condition: CAD account A (100 @ 10.00), USD account B (100 @ 8.00,
//    rate 1.35), a 50-share sell in A @ 12.00.
//    Call: computeAcbDispositions(...).
//    Observable: one row, proceeds 600, ACB 520, gain 80.
//    Source: requirements AC 3.11.
//
// 6. an option fill uses multiplier 100 (AC 3.4, 3.5)
//    Pre-condition: an option entry and full exit at distinct prices.
//    Call: computeAcbDispositions(...).
//    Observable: proceeds/ACB/gain scaled by 100, not 1.
//    Source: design C3 post-condition 4, requirements AC 3.4/3.5.
//
// 7. short entry then buyback maps to the AC 3.6 row shape (AC 3.6)
//    Pre-condition: a short entry, then a full buyback exit.
//    Call: computeAcbDispositions(...).
//    Observable: proceeds = pooled proceeds share, ACB = buyback cost,
//    outlays = buyback fees.
//    Source: design C3 post-condition 7, requirements AC 3.6.
//
// 8. gain is exact when the pool share is a repeating decimal (AC 3.8)
//    Pre-condition: a partial exit whose share (amount × q ÷ quantity) does
//    not terminate at two decimal places.
//    Call: computeAcbDispositions(...).
//    Observable: proceeds, outlays and ACB each round to cents and
//    gain = proceeds − outlays − ACB exactly.
//    Source: design C3 post-condition 7, requirements AC 3.8.
//
// 9. an exit beyond the pool is insufficient_pool and leaves the pool
//    unchanged (AC 3.7)
//    Pre-condition: an exit whose quantity exceeds the priced pool, followed
//    by a second exit that exactly drains the original (untouched) pool.
//    Call: computeAcbDispositions(...).
//    Observable: the first row is unpriced with reason 'insufficient_pool';
//    the second row prices normally off the original, unshrunk pool.
//    Source: design C3 post-condition 6(b), requirements AC 3.7.
//
// 10. an unrated entry still grows the pool and pool_unpriced outranks
//     insufficient_pool (AC 4.4)
//     Pre-condition: an entry in a currency with no rate, then an exit whose
//     quantity exceeds that entry's quantity.
//     Call: computeAcbDispositions(...).
//     Observable: no row for the entry; the exit is unpriced with reason
//     'pool_unpriced' (not 'insufficient_pool'), with null money fields and
//     the entry's (currency, trade date) in missingRates.
//     Source: design C3 post-condition 6(a), requirements AC 4.4.
//
// 11. an exit with no rate on a priced pool is missing_rate and the pool
//     still shrinks (AC 4.5)
//     Pre-condition: a priced CAD pool, an unrated exit smaller than it,
//     then a further CAD entry and a full CAD exit.
//     Call: computeAcbDispositions(...).
//     Observable: the unrated exit is unpriced with reason 'missing_rate';
//     the later priced exit's ACB reflects the pool as shrunk by the
//     unrated exit's share, not the pre-shrink amount.
//     Source: design C3 post-condition 6(c), requirements AC 4.5.
//
// 12. a pool that returns to zero resets, so its next priced entry prices the
//     following exit (design D3)
//     Pre-condition: a pool driven to zero quantity by a pool_unpriced exit,
//     then a fresh priced entry and a full exit of it.
//     Call: computeAcbDispositions(...).
//     Observable: the final exit prices normally (unpriced state and stale
//     ACB do not survive the zero-quantity reset).
//     Source: design C3 post-condition 8, design decision D3.
//
// 13. a fill in ignoredFillIds changes nothing
//     Pre-condition: two entries at very different prices, one of them in
//     ignoredFillIds, then a full exit.
//     Call: computeAcbDispositions(fills, cadRateFor, ignoredFillIds).
//     Observable: the exit's ACB reflects only the non-ignored entry.
//     Source: design C3 post-condition 2.
//
// 14. equal inputs give equal outputs (AC 3.10)
//     Pre-condition: the same scenario built twice from fresh object
//     literals, Set and callback.
//     Call: computeAcbDispositions(...) twice.
//     Observable: the serialised rows are deep-equal.
//     Source: design C3 post-condition 10, requirements AC 3.10.
// ---------------------------------------------------------------------------

function fill(over: {
  id: string;
  type: 'entry' | 'exit';
  side: 'long' | 'short';
  price: string;
  quantity: string;
  fees: string;
  filledAt: string;
  createdAt?: string;
  currency?: string;
  timezone?: string;
  symbol?: string;
  assetType?: 'stock' | 'option';
  positionId?: string;
  accountId?: string;
}): AcbFill {
  return {
    id: over.id,
    positionId: over.positionId ?? `pos-${over.id}`,
    accountId: over.accountId ?? `acct-${over.id}`,
    symbol: over.symbol ?? 'XYZ',
    side: over.side,
    assetType: over.assetType ?? 'stock',
    type: over.type,
    price: over.price,
    quantity: over.quantity,
    fees: over.fees,
    filledAt: new Date(over.filledAt),
    createdAt: new Date(over.createdAt ?? over.filledAt),
    currency: over.currency ?? 'CAD',
    timezone: over.timezone ?? 'UTC',
    positionOpenedAt: null,
    positionClosedAt: null,
  };
}

function str(x: Decimal | null): string | null {
  return x === null ? null : x.toString();
}

function throwsOnCad(currency: string): Decimal | null {
  if (currency === 'CAD') throw new Error('unexpected CAD rate lookup');
  return null;
}

function byId(rows: AcbDisposition[], exitFillId: string): AcbDisposition {
  const row = rows.find((r) => r.exitFillId === exitFillId);
  if (!row) throw new Error(`no row for ${exitFillId}`);
  return row;
}

// ---------------------------------------------------------------------------
// 1. tradeDateKey
// ---------------------------------------------------------------------------

describe('tradeDateKey', () => {
  it('uses the zone-local calendar date, crossing UTC midnight (AC 4.2)', () => {
    const at = new Date('2026-03-03T02:30:00Z');
    expect(tradeDateKey(at, 'America/New_York')).toBe('2026-03-02');
    expect(tradeDateKey(at, 'UTC')).toBe('2026-03-03');
  });
});

// ---------------------------------------------------------------------------
// 2. canonical fill order
// ---------------------------------------------------------------------------

describe('computeAcbDispositions — canonical order', () => {
  it('processes fills by filledAt, then createdAt, then id, never the input array order (AC 3.3)', () => {
    const tiedEntryA = fill({
      id: 'c',
      type: 'entry',
      side: 'long',
      currency: 'USD',
      price: '8',
      quantity: '5',
      fees: '0',
      filledAt: '2026-01-05T00:00:00Z',
      createdAt: '2026-01-05T00:00:00Z',
    });
    const tiedEntryB = fill({
      id: 'a',
      type: 'entry',
      side: 'long',
      currency: 'CAD',
      price: '10',
      quantity: '5',
      fees: '0',
      filledAt: '2026-01-05T00:00:00Z',
      createdAt: '2026-01-05T00:00:00Z',
    });
    const laterCreatedExit = fill({
      id: 'b',
      type: 'exit',
      side: 'long',
      currency: 'CAD',
      price: '12',
      quantity: '3',
      fees: '0',
      filledAt: '2026-01-05T00:00:00Z',
      createdAt: '2026-01-05T00:00:01Z',
    });

    const rows = computeAcbDispositions(
      [laterCreatedExit, tiedEntryA, tiedEntryB],
      throwsOnCad,
      new Set(),
    );

    expect(rows).toHaveLength(1);
    const row = byId(rows, 'b');
    expect(row.unpricedReason).toBe('pool_unpriced');
    expect(str(row.proceeds)).toBeNull();
    expect(str(row.outlays)).toBeNull();
    expect(str(row.acb)).toBeNull();
    expect(str(row.gain)).toBeNull();
    expect(str(row.cadRate)).toBeNull();
    expect(row.missingRates).toEqual([
      { currency: 'USD', tradeDate: tradeDateKey(tiedEntryA.filledAt, 'UTC') },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. pool key is (symbol, side)
// ---------------------------------------------------------------------------

describe('computeAcbDispositions — pool key', () => {
  it('keys the pool by symbol and side, never mixing an opposite side or another symbol (AC 3.1)', () => {
    const xyzLongEntry = fill({
      id: 'xyz-long-entry',
      type: 'entry',
      side: 'long',
      symbol: 'XYZ',
      price: '10',
      quantity: '10',
      fees: '0',
      filledAt: '2026-01-01T00:00:00Z',
    });
    const xyzShortEntry = fill({
      id: 'xyz-short-entry',
      type: 'entry',
      side: 'short',
      symbol: 'XYZ',
      price: '20',
      quantity: '5',
      fees: '0',
      filledAt: '2026-01-01T00:00:00Z',
    });
    const abcLongEntry = fill({
      id: 'abc-long-entry',
      type: 'entry',
      side: 'long',
      symbol: 'ABC',
      price: '5',
      quantity: '3',
      fees: '0',
      filledAt: '2026-01-01T00:00:00Z',
    });
    const xyzLongExit = fill({
      id: 'xyz-long-exit',
      type: 'exit',
      side: 'long',
      symbol: 'XYZ',
      price: '12',
      quantity: '10',
      fees: '0',
      filledAt: '2026-01-02T00:00:00Z',
    });

    const rows = computeAcbDispositions(
      [xyzLongEntry, xyzShortEntry, abcLongEntry, xyzLongExit],
      throwsOnCad,
      new Set(),
    );

    const row = byId(rows, 'xyz-long-exit');
    expect(str(row.proceeds)).toBe('120');
    expect(str(row.acb)).toBe('100');
    expect(str(row.gain)).toBe('20');
  });
});

// ---------------------------------------------------------------------------
// 4. CAD needs no rate lookup; a foreign row carries the rate used
// ---------------------------------------------------------------------------

describe('computeAcbDispositions — currency', () => {
  it('never looks up a rate for CAD, and carries the looked-up rate on a foreign row (AC 4.1)', () => {
    const cadEntry = fill({
      id: 'cad-entry',
      type: 'entry',
      side: 'long',
      currency: 'CAD',
      price: '10',
      quantity: '10',
      fees: '0',
      filledAt: '2026-02-01T00:00:00Z',
    });
    const usdExit = fill({
      id: 'usd-exit',
      type: 'exit',
      side: 'long',
      currency: 'USD',
      price: '12',
      quantity: '10',
      fees: '0',
      filledAt: '2026-02-10T12:00:00Z',
      timezone: 'UTC',
    });

    const cadRateFor = (currency: string, tradeDate: string): Decimal | null => {
      if (currency === 'CAD') throw new Error('unexpected CAD rate lookup');
      if (currency === 'USD' && tradeDate === '2026-02-10') return new Decimal('1.35');
      throw new Error(`unexpected lookup: ${currency} ${tradeDate}`);
    };

    const rows = computeAcbDispositions([cadEntry, usdExit], cadRateFor, new Set());

    const row = byId(rows, 'usd-exit');
    expect(str(row.cadRate)).toBe('1.35');
    expect(str(row.proceeds)).toBe('162');
    expect(str(row.outlays)).toBe('0');
    expect(str(row.acb)).toBe('100');
    expect(str(row.gain)).toBe('62');
  });
});

// ---------------------------------------------------------------------------
// 5. AC 3.11 worked example
// ---------------------------------------------------------------------------

describe('computeAcbDispositions — AC 3.11 worked example', () => {
  it('gives proceeds 600, ACB 520 and gain 80 across a CAD and a USD account', () => {
    const entryA = fill({
      id: 'entryA',
      positionId: 'posA',
      accountId: 'acctA',
      type: 'entry',
      side: 'long',
      symbol: 'XYZ',
      currency: 'CAD',
      price: '10.00',
      quantity: '100',
      fees: '0',
      filledAt: '2026-01-01T00:00:00Z',
    });
    const entryB = fill({
      id: 'entryB',
      positionId: 'posB',
      accountId: 'acctB',
      type: 'entry',
      side: 'long',
      symbol: 'XYZ',
      currency: 'USD',
      price: '8.00',
      quantity: '100',
      fees: '0',
      filledAt: '2026-01-02T00:00:00Z',
    });
    const exitA = fill({
      id: 'exitA',
      positionId: 'posA',
      accountId: 'acctA',
      type: 'exit',
      side: 'long',
      symbol: 'XYZ',
      currency: 'CAD',
      price: '12.00',
      quantity: '50',
      fees: '0',
      filledAt: '2026-01-03T00:00:00Z',
    });

    const cadRateFor = (currency: string, tradeDate: string): Decimal | null => {
      if (currency === 'CAD') throw new Error('unexpected CAD rate lookup');
      if (currency === 'USD' && tradeDate === '2026-01-02') return new Decimal('1.35');
      throw new Error(`unexpected lookup: ${currency} ${tradeDate}`);
    };

    const rows = computeAcbDispositions([entryA, entryB, exitA], cadRateFor, new Set());

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.exitFillId).toBe('exitA');
    expect(row.positionId).toBe('posA');
    expect(row.accountId).toBe('acctA');
    expect(row.symbol).toBe('XYZ');
    expect(row.side).toBe('long');
    expect(row.assetType).toBe('stock');
    expect(row.currency).toBe('CAD');
    expect(str(row.quantity)).toBe('50');
    expect(row.cadRate).toBeNull();
    expect(str(row.proceeds)).toBe('600');
    expect(str(row.outlays)).toBe('0');
    expect(str(row.acb)).toBe('520');
    expect(str(row.gain)).toBe('80');
    expect(row.unpricedReason).toBeNull();
    expect(row.realisedAt.getTime()).toBe(exitA.filledAt.getTime());
    expect(row.tradeDate).toBe(tradeDateKey(exitA.filledAt, 'UTC'));
  });
});

// ---------------------------------------------------------------------------
// 6. option multiplier
// ---------------------------------------------------------------------------

describe('computeAcbDispositions — option multiplier', () => {
  it('scales an option fill by 100, not 1 (AC 3.4, AC 3.5)', () => {
    const entry = fill({
      id: 'opt-entry',
      type: 'entry',
      side: 'long',
      assetType: 'option',
      price: '5',
      quantity: '2',
      fees: '0',
      filledAt: '2026-01-01T00:00:00Z',
    });
    const exit = fill({
      id: 'opt-exit',
      type: 'exit',
      side: 'long',
      assetType: 'option',
      price: '6',
      quantity: '2',
      fees: '0',
      filledAt: '2026-01-02T00:00:00Z',
    });

    const rows = computeAcbDispositions([entry, exit], throwsOnCad, new Set());

    const row = byId(rows, 'opt-exit');
    expect(row.assetType).toBe('option');
    expect(str(row.proceeds)).toBe('1200');
    expect(str(row.acb)).toBe('1000');
    expect(str(row.outlays)).toBe('0');
    expect(str(row.gain)).toBe('200');
  });
});

// ---------------------------------------------------------------------------
// 7. short entry then buyback
// ---------------------------------------------------------------------------

describe('computeAcbDispositions — short side', () => {
  it('maps a buyback to proceeds = pooled share, ACB = buyback cost, outlays = buyback fees (AC 3.6)', () => {
    const shortEntry = fill({
      id: 'short-entry',
      type: 'entry',
      side: 'short',
      price: '10',
      quantity: '5',
      fees: '1',
      filledAt: '2026-01-01T00:00:00Z',
    });
    const buyback = fill({
      id: 'buyback',
      type: 'exit',
      side: 'short',
      price: '8',
      quantity: '5',
      fees: '0.5',
      filledAt: '2026-01-02T00:00:00Z',
    });

    const rows = computeAcbDispositions([shortEntry, buyback], throwsOnCad, new Set());

    const row = byId(rows, 'buyback');
    expect(row.side).toBe('short');
    expect(str(row.proceeds)).toBe('49');
    expect(str(row.acb)).toBe('40');
    expect(str(row.outlays)).toBe('0.5');
    expect(str(row.gain)).toBe('8.5');
  });
});

// ---------------------------------------------------------------------------
// 8. exact gain on a repeating-decimal share
// ---------------------------------------------------------------------------

describe('computeAcbDispositions — rounding', () => {
  it('rounds proceeds, outlays and ACB to cents once and keeps gain exact (AC 3.8)', () => {
    const entry = fill({
      id: 'round-entry',
      type: 'entry',
      side: 'long',
      price: '10',
      quantity: '3',
      fees: '1',
      filledAt: '2026-01-01T00:00:00Z',
    });
    const exit = fill({
      id: 'round-exit',
      type: 'exit',
      side: 'long',
      price: '12',
      quantity: '1',
      fees: '0.5',
      filledAt: '2026-01-02T00:00:00Z',
    });

    const rows = computeAcbDispositions([entry, exit], throwsOnCad, new Set());

    const row = byId(rows, 'round-exit');
    // amount = 10*3*1+1 = 31; share = 31*1/3 = 10.333... -> rounds to 10.33
    expect(str(row.proceeds)).toBe('12');
    expect(str(row.outlays)).toBe('0.5');
    expect(str(row.acb)).toBe('10.33');
    expect(str(row.gain)).toBe('1.17');
  });
});

// ---------------------------------------------------------------------------
// 9. insufficient_pool leaves the pool unchanged
// ---------------------------------------------------------------------------

describe('computeAcbDispositions — insufficient_pool', () => {
  it('is unpriced with reason insufficient_pool and leaves the pool unchanged for the next exit (AC 3.7)', () => {
    const entry = fill({
      id: 'ip-entry',
      type: 'entry',
      side: 'long',
      price: '10',
      quantity: '5',
      fees: '0',
      filledAt: '2026-01-01T00:00:00Z',
    });
    const tooBigExit = fill({
      id: 'ip-too-big',
      type: 'exit',
      side: 'long',
      price: '12',
      quantity: '10',
      fees: '0',
      filledAt: '2026-01-02T00:00:00Z',
    });
    const fullDrainExit = fill({
      id: 'ip-full-drain',
      type: 'exit',
      side: 'long',
      price: '11',
      quantity: '5',
      fees: '0',
      filledAt: '2026-01-03T00:00:00Z',
    });

    const rows = computeAcbDispositions([entry, tooBigExit, fullDrainExit], throwsOnCad, new Set());

    const tooBigRow = byId(rows, 'ip-too-big');
    expect(tooBigRow.unpricedReason).toBe('insufficient_pool');
    expect(str(tooBigRow.proceeds)).toBeNull();
    expect(str(tooBigRow.outlays)).toBeNull();
    expect(str(tooBigRow.acb)).toBeNull();
    expect(str(tooBigRow.gain)).toBeNull();

    const drainRow = byId(rows, 'ip-full-drain');
    expect(drainRow.unpricedReason).toBeNull();
    expect(str(drainRow.proceeds)).toBe('55');
    expect(str(drainRow.acb)).toBe('50');
    expect(str(drainRow.gain)).toBe('5');
  });
});

// ---------------------------------------------------------------------------
// 10. unrated entry grows the pool; pool_unpriced outranks insufficient_pool
// ---------------------------------------------------------------------------

describe('computeAcbDispositions — pool_unpriced precedence', () => {
  it('still grows the pool from an unrated entry, and pool_unpriced wins over insufficient_pool (AC 4.4)', () => {
    const unratedEntry = fill({
      id: 'pu-entry',
      type: 'entry',
      side: 'long',
      currency: 'USD',
      price: '8',
      quantity: '10',
      fees: '0',
      filledAt: '2026-03-01T00:00:00Z',
    });
    const exceedingExit = fill({
      id: 'pu-exit',
      type: 'exit',
      side: 'long',
      currency: 'CAD',
      price: '12',
      quantity: '15',
      fees: '0',
      filledAt: '2026-03-02T00:00:00Z',
    });

    const cadRateFor = (currency: string): Decimal | null => {
      if (currency === 'CAD') throw new Error('unexpected CAD rate lookup');
      return null;
    };

    const rows = computeAcbDispositions([unratedEntry, exceedingExit], cadRateFor, new Set());

    expect(rows).toHaveLength(1);
    const row = byId(rows, 'pu-exit');
    expect(row.unpricedReason).toBe('pool_unpriced');
    expect(str(row.proceeds)).toBeNull();
    expect(str(row.outlays)).toBeNull();
    expect(str(row.acb)).toBeNull();
    expect(str(row.gain)).toBeNull();
    expect(row.missingRates).toEqual([
      { currency: 'USD', tradeDate: tradeDateKey(unratedEntry.filledAt, 'UTC') },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 11. missing_rate exit still shrinks the pool
// ---------------------------------------------------------------------------

describe('computeAcbDispositions — missing_rate', () => {
  it('is unpriced with reason missing_rate and still shrinks the pool by its share (AC 4.5)', () => {
    const entry1 = fill({
      id: 'mr-entry1',
      type: 'entry',
      side: 'long',
      price: '10',
      quantity: '10',
      fees: '0',
      filledAt: '2026-01-01T00:00:00Z',
    });
    const unratedExit = fill({
      id: 'mr-exit1',
      type: 'exit',
      side: 'long',
      currency: 'USD',
      price: '9',
      quantity: '4',
      fees: '0',
      filledAt: '2026-01-02T00:00:00Z',
    });
    const entry2 = fill({
      id: 'mr-entry2',
      type: 'entry',
      side: 'long',
      price: '20',
      quantity: '6',
      fees: '0',
      filledAt: '2026-01-03T00:00:00Z',
    });
    const finalExit = fill({
      id: 'mr-exit2',
      type: 'exit',
      side: 'long',
      price: '25',
      quantity: '12',
      fees: '0',
      filledAt: '2026-01-04T00:00:00Z',
    });

    const cadRateFor = (currency: string): Decimal | null => {
      if (currency === 'CAD') throw new Error('unexpected CAD rate lookup');
      return null; // USD never has a rate in this scenario
    };

    const rows = computeAcbDispositions(
      [entry1, unratedExit, entry2, finalExit],
      cadRateFor,
      new Set(),
    );

    const unratedRow = byId(rows, 'mr-exit1');
    expect(unratedRow.unpricedReason).toBe('missing_rate');
    expect(str(unratedRow.proceeds)).toBeNull();
    expect(str(unratedRow.acb)).toBeNull();
    expect(unratedRow.missingRates).toEqual([
      { currency: 'USD', tradeDate: tradeDateKey(unratedExit.filledAt, 'UTC') },
    ]);

    // If the pool had NOT shrunk by mr-exit1's share (amount 100*4/10=40,
    // quantity 10->6, amount 100->60), entry2 would blend into amount 220 /
    // quantity 16 and this exit's ACB would be 165, not 180.
    const finalRow = byId(rows, 'mr-exit2');
    expect(finalRow.unpricedReason).toBeNull();
    expect(str(finalRow.proceeds)).toBe('300');
    expect(str(finalRow.acb)).toBe('180');
    expect(str(finalRow.gain)).toBe('120');
  });
});

// ---------------------------------------------------------------------------
// 12. zero-quantity reset
// ---------------------------------------------------------------------------

describe('computeAcbDispositions — zero-quantity reset', () => {
  it('resets ACB and clears unpriced state once the pool drains to zero (design D3)', () => {
    const entry1 = fill({
      id: 'zr-entry1',
      type: 'entry',
      side: 'long',
      price: '10',
      quantity: '10',
      fees: '0',
      filledAt: '2026-01-01T00:00:00Z',
    });
    const unratedEntry = fill({
      id: 'zr-entry2',
      type: 'entry',
      side: 'long',
      currency: 'USD',
      price: '1',
      quantity: '10',
      fees: '0',
      filledAt: '2026-01-02T00:00:00Z',
    });
    const drainingExit = fill({
      id: 'zr-exit1',
      type: 'exit',
      side: 'long',
      price: '99',
      quantity: '20',
      fees: '0',
      filledAt: '2026-01-03T00:00:00Z',
    });
    const freshEntry = fill({
      id: 'zr-entry3',
      type: 'entry',
      side: 'long',
      price: '20',
      quantity: '5',
      fees: '0',
      filledAt: '2026-01-04T00:00:00Z',
    });
    const finalExit = fill({
      id: 'zr-exit2',
      type: 'exit',
      side: 'long',
      price: '25',
      quantity: '5',
      fees: '0',
      filledAt: '2026-01-05T00:00:00Z',
    });

    const cadRateFor = (currency: string): Decimal | null => {
      if (currency === 'CAD') throw new Error('unexpected CAD rate lookup');
      return null;
    };

    const rows = computeAcbDispositions(
      [entry1, unratedEntry, drainingExit, freshEntry, finalExit],
      cadRateFor,
      new Set(),
    );

    const drainingRow = byId(rows, 'zr-exit1');
    expect(drainingRow.unpricedReason).toBe('pool_unpriced');

    // If the reset had not cleared `unpriced`, or had not zeroed `amount`,
    // this row would still be unpriced, or its ACB would carry a stale
    // residue from the drained pool rather than freshEntry's 100 alone.
    const finalRow = byId(rows, 'zr-exit2');
    expect(finalRow.unpricedReason).toBeNull();
    expect(str(finalRow.proceeds)).toBe('125');
    expect(str(finalRow.acb)).toBe('100');
    expect(str(finalRow.gain)).toBe('25');
  });
});

// ---------------------------------------------------------------------------
// 13. ignoredFillIds
// ---------------------------------------------------------------------------

describe('computeAcbDispositions — ignoredFillIds', () => {
  it('skips a fill named in ignoredFillIds entirely: no quantity, no amount', () => {
    const keptEntry = fill({
      id: 'gi-kept',
      type: 'entry',
      side: 'long',
      price: '10',
      quantity: '10',
      fees: '0',
      filledAt: '2026-01-01T00:00:00Z',
    });
    const ignoredEntry = fill({
      id: 'gi-ignored',
      type: 'entry',
      side: 'long',
      price: '100',
      quantity: '10',
      fees: '0',
      filledAt: '2026-01-02T00:00:00Z',
    });
    const exit = fill({
      id: 'gi-exit',
      type: 'exit',
      side: 'long',
      price: '12',
      quantity: '10',
      fees: '0',
      filledAt: '2026-01-03T00:00:00Z',
    });

    const rows = computeAcbDispositions(
      [keptEntry, ignoredEntry, exit],
      throwsOnCad,
      new Set(['gi-ignored']),
    );

    const row = byId(rows, 'gi-exit');
    // If gi-ignored had counted, amount would be 1100 / quantity 20, and
    // this full-10 exit's ACB would be 550, not 100.
    expect(str(row.proceeds)).toBe('120');
    expect(str(row.acb)).toBe('100');
    expect(str(row.gain)).toBe('20');
  });
});

// ---------------------------------------------------------------------------
// 14. determinism
// ---------------------------------------------------------------------------

describe('computeAcbDispositions — determinism', () => {
  function buildScenario() {
    const entry1 = fill({
      id: 'det-entry1',
      type: 'entry',
      side: 'long',
      price: '10',
      quantity: '10',
      fees: '0',
      filledAt: '2026-01-01T00:00:00Z',
    });
    const unratedEntry = fill({
      id: 'det-entry2',
      type: 'entry',
      side: 'long',
      currency: 'USD',
      price: '8',
      quantity: '5',
      fees: '0',
      filledAt: '2026-01-02T00:00:00Z',
    });
    const exit = fill({
      id: 'det-exit',
      type: 'exit',
      side: 'long',
      price: '12',
      quantity: '8',
      fees: '0',
      filledAt: '2026-01-03T00:00:00Z',
    });
    const cadRateFor = (currency: string): Decimal | null => {
      if (currency === 'CAD') throw new Error('unexpected CAD rate lookup');
      return null;
    };
    return { fills: [entry1, unratedEntry, exit], cadRateFor, ignored: new Set<string>() };
  }

  function serialize(rows: AcbDisposition[]) {
    return rows.map((r) => ({
      exitFillId: r.exitFillId,
      positionId: r.positionId,
      accountId: r.accountId,
      symbol: r.symbol,
      side: r.side,
      assetType: r.assetType,
      currency: r.currency,
      tradeDate: r.tradeDate,
      realisedAt: r.realisedAt.toISOString(),
      quantity: str(r.quantity),
      cadRate: str(r.cadRate),
      proceeds: str(r.proceeds),
      outlays: str(r.outlays),
      acb: str(r.acb),
      gain: str(r.gain),
      unpricedReason: r.unpricedReason,
      missingRates: r.missingRates,
    }));
  }

  it('returns deep-equal rows for two independently-built but equal inputs (AC 3.10)', () => {
    const run1 = buildScenario();
    const run2 = buildScenario();

    const rows1 = computeAcbDispositions(run1.fills, run1.cadRateFor, run1.ignored);
    const rows2 = computeAcbDispositions(run2.fills, run2.cadRateFor, run2.ignored);

    expect(serialize(rows1)).toEqual(serialize(rows2));
  });
});

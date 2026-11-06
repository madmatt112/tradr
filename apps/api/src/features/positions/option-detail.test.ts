/**
 * Settlements, roll chain and entry Greeks on the detail read (design C2,
 * Data Models; task 12 of option-lifecycle-events). Black-box over
 * `getPositionDetail` directly — the house style from
 * `option-settlement.test.ts`/`option-roll.test.ts`: seed via the existing
 * `settleLeg`/`rollLeg`/`upsertEntryGreeks` seams, drive the function under
 * test, assert on its returned detail object.
 *
 * Contract block — one entry per success criterion this task covers.
 * Pre-condition → call through the seam → observable result → source of the
 * expected value.
 *
 * A. A leg after assignment reads one settlement, role leg, the opened
 *    stock id (AC 8.1)
 *   Pre: a short put leg assigned (opens a new long stock row, design C3).
 *   Call: `getPositionDetail(db, legId, userId)`.
 *   Result: `detail.settlements` has length 1; its entry carries
 *     `role: 'leg'`, `legPositionId` equal to `legId`, and `stockPositionIds`
 *     containing the opened stock row's id.
 *   Source: design C2 Detail additions, Data Models `detail.settlements[]`;
 *     requirements AC 8.1.
 *
 * B. The opened stock row reads the same settlement, role stock_opened,
 *    the leg id (AC 8.1)
 *   Pre: same assignment as A.
 *   Call: `getPositionDetail(db, openedStockId, userId)`.
 *   Result: `detail.settlements` has one entry with the same `settlementId`
 *     as A, `role: 'stock_opened'`, `legPositionId` equal to `legId`.
 *   Source: design C2 ("so a stock row reaches unsettle"), Data Models
 *     `detail.settlements[]`; requirements AC 8.1.
 *
 * C. An exited stock row reads role stock_exit (AC 8.1)
 *   Pre: a short call leg assigned against a pre-existing held long stock
 *     row that the assignment fully exits (design C3 post-condition 3).
 *   Call: `getPositionDetail(db, heldRowId, userId)`.
 *   Result: `detail.settlements` has one entry with `role: 'stock_exit'`
 *     and `legPositionId` equal to the leg's id.
 *   Source: design C2 Detail additions; requirements AC 8.1.
 *
 * D. A chain leg reads rollChain with ordered legs and one netCredit (AC 5.2)
 *   Pre: a short put sold at 2.00, rolled at 1.00/2.50, then rolled again at
 *     1.50/3.00 — requirements AC 5.3's own fixture (0 fees).
 *   Call: `getPositionDetail(db, legId, userId)`.
 *   Result: `detail.rollChain.legs` names the three legs' position ids in
 *     roll order; `detail.rollChain.netCredit` is 500.
 *   Source: design Data Models `detail.rollChain`; requirements AC 5.2, AC
 *     5.3 (the exact 500 value).
 *
 * E. A leg with Greeks reads entryGreeks with rhoPerPct nullable (AC 8.1)
 *   Pre: a leg carrying a chain-sourced entry-Greeks row (`rhoPerPct: null`,
 *     design C7 "chain" source never has rho).
 *   Call: `getPositionDetail(db, legId, userId)`.
 *   Result: `detail.entryGreeks` carries `delta`/`gamma`/`thetaPerDay`/
 *     `vegaPerPct` equal to the stored row, `rhoPerPct: null`, and
 *     `source: 'chain'`.
 *   Source: design Data Models `detail.entryGreeks` ("rhoPerPct nullable");
 *     requirements AC 8.1.
 *
 * F. After unsettle the settlements key is gone (AC 8.2)
 *   Pre: a leg settled worthless, then unsettled.
 *   Call: `getPositionDetail(db, legId, userId)` after `unsettle`.
 *   Result: `detail.settlements` is `undefined`.
 *   Source: requirements AC 8.2 ("its record and timeline entry SHALL go").
 *
 * G. A plain position has none of the three keys (design C2 value-keyed
 *    convention)
 *   Pre: an open option leg with no settlement, roll or Greeks capture.
 *   Call: `getPositionDetail(db, legId, userId)`.
 *   Result: `detail.settlements`, `detail.rollChain` and `detail.entryGreeks`
 *     are all `undefined`.
 *   Source: design C2 ("each key added only when it has a value");
 *     task 12 Success ("a plain position has none of the three keys").
 *
 * Folded/out-of-scope criteria:
 *  - AC 4.3 (unsettle deletes the opened stock row through `deletePosition`,
 *    never `removePosition`) is exercised only incidentally by F, which
 *    settles worthless (no stock row opens) — its own seam coverage lives in
 *    `option-settlement.test.ts`'s unsettle describe blocks. Not retested
 *    here; task 12 only needs F's `settlements`-key-removal observation.
 *  - AC 11.5 (swagger/`tradr-api.json` regeneration) is a generated-artifact
 *    checklist item, not a function-level success criterion with a seam to
 *    call from this file.
 */
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { accounts, positions, users } from '@/db/schema';
import { type EntryGreeksData, upsertEntryGreeks } from '@/features/positions/entry-greeks.query';
import { getRollChain } from '@/features/positions/option-roll.query';
import { rollLeg } from '@/features/positions/option-roll.service';
import { settleLeg, unsettle } from '@/features/positions/option-settlement.service';
import {
  addFillTx,
  createPositionTx,
  getPositionDetail,
  openPositionTx,
} from '@/features/positions/positions.service';
import { withTransaction } from '@/lib/transaction';

const UNDERLYING = 'AAPL';
const GATE = { isAdmin: false };
const BEFORE_EXPIRY = '2026-06-01T00:00:00.000Z';
const OPENED_AT = '2026-06-01T00:00:00.000Z';

afterEach(() => {
  vi.restoreAllMocks();
});

let counter = 0;
function uniqueEmail() {
  return `option-detail-${Date.now()}-${++counter}@example.com`;
}

function occSymbol(underlying: string, type: 'C' | 'P', strike: number) {
  const strikeField = Math.round(strike * 1000)
    .toString()
    .padStart(8, '0');
  return `${underlying}260717${type}${strikeField}`;
}

async function seedUserAndAccount() {
  const [user] = await db
    .insert(users)
    .values({ email: uniqueEmail(), passwordHash: 'x'.repeat(60) })
    .returning();
  const [account] = await db
    .insert(accounts)
    .values({ userId: user!.id, name: 'Detail Account', currency: 'USD' })
    .returning();
  return { userId: user!.id, accountId: account!.id };
}

async function createOptionLeg(params: {
  side: 'long' | 'short';
  symbol: string;
  entryPrice: string;
  entryQty: string;
  filledAt: string;
}) {
  const { userId, accountId } = await seedUserAndAccount();
  const { legId } = await withTransaction(db, async (tx) => {
    const pos = await createPositionTx(tx, userId, {
      accountId,
      symbol: params.symbol,
      side: params.side,
      assetType: 'option',
    });
    await addFillTx(tx, pos!.id, userId, {
      type: 'entry',
      price: params.entryPrice,
      quantity: params.entryQty,
      fees: '0',
      filledAt: params.filledAt,
    });
    await openPositionTx(tx, pos!.id, userId, params.filledAt);
    return { legId: pos!.id };
  });
  return { userId, accountId, legId };
}

async function createStockRow(params: {
  userId: string;
  accountId: string;
  side: 'long' | 'short';
  symbol: string;
  entryPrice: string;
  entryQty: string;
  entryFilledAt: string;
}) {
  return withTransaction(db, async (tx) => {
    const pos = await createPositionTx(tx, params.userId, {
      accountId: params.accountId,
      symbol: params.symbol,
      side: params.side,
      assetType: 'stock',
    });
    await addFillTx(tx, pos!.id, params.userId, {
      type: 'entry',
      price: params.entryPrice,
      quantity: params.entryQty,
      fees: '0',
      filledAt: params.entryFilledAt,
    });
    await openPositionTx(tx, pos!.id, params.userId, params.entryFilledAt);
    return { positionId: pos!.id };
  });
}

async function getStockRowId(accountId: string, excludeId: string): Promise<string> {
  const rows = await db
    .select({ id: positions.id })
    .from(positions)
    .where(and(eq(positions.accountId, accountId), eq(positions.assetType, 'stock')));
  const row = rows.find((r) => r.id !== excludeId);
  return row!.id;
}

describe('getPositionDetail — a leg after assignment reads one settlement, role leg (AC 8.1)', () => {
  it('carries settlements[0] with role leg, legPositionId the leg itself, stockPositionIds the opened stock row', async () => {
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: occSymbol(UNDERLYING, 'P', 50),
      entryPrice: '2.50',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
    });

    await settleLeg(db, userId, legId, { outcome: 'assigned', fees: '0.65' });
    const stockId = await getStockRowId(accountId, legId);

    const detail = await getPositionDetail(db, legId, userId);

    expect(detail.settlements).toHaveLength(1);
    const entry = detail.settlements[0];
    expect(entry.role).toBe('leg');
    expect(entry.legPositionId).toBe(legId);
    expect(entry.stockPositionIds).toContain(stockId);
  });
});

describe('getPositionDetail — the opened stock row reads the same settlement, role stock_opened (AC 8.1)', () => {
  it('carries the same settlementId, role stock_opened, legPositionId the leg', async () => {
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: occSymbol(UNDERLYING, 'P', 50),
      entryPrice: '2.50',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
    });

    const result = await settleLeg(db, userId, legId, { outcome: 'assigned', fees: '0.65' });
    const stockId = await getStockRowId(accountId, legId);

    const legDetail = await getPositionDetail(db, legId, userId);
    const stockDetail = await getPositionDetail(db, stockId, userId);

    expect(stockDetail.settlements).toHaveLength(1);
    const entry = stockDetail.settlements[0];
    expect(entry.settlementId).toBe(result.settlementId);
    expect(entry.settlementId).toBe(legDetail.settlements[0].settlementId);
    expect(entry.role).toBe('stock_opened');
    expect(entry.legPositionId).toBe(legId);
  });
});

describe('getPositionDetail — an exited stock row reads role stock_exit (AC 8.1)', () => {
  it('carries a settlement with role stock_exit and legPositionId the leg', async () => {
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: occSymbol(UNDERLYING, 'C', 100),
      entryPrice: '3',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
    });
    const { positionId: heldRowId } = await createStockRow({
      userId,
      accountId,
      side: 'long',
      symbol: UNDERLYING,
      entryPrice: '90',
      entryQty: '100',
      entryFilledAt: BEFORE_EXPIRY,
    });

    await settleLeg(db, userId, legId, { outcome: 'assigned', fees: '2.00' });

    const heldDetail = await getPositionDetail(db, heldRowId, userId);

    expect(heldDetail.settlements).toHaveLength(1);
    const entry = heldDetail.settlements[0];
    expect(entry.role).toBe('stock_exit');
    expect(entry.legPositionId).toBe(legId);
  });
});

describe('getPositionDetail — a chain leg reads rollChain with ordered legs and one netCredit (AC 5.2, AC 5.3)', () => {
  it('names the three legs in roll order and a netCredit of 500', async () => {
    const symbol1 = occSymbol(UNDERLYING, 'P', 150);
    const symbol2 = occSymbol(UNDERLYING, 'P', 145);
    const symbol3 = occSymbol(UNDERLYING, 'P', 140);
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: symbol1,
      entryPrice: '2.00',
      entryQty: '1',
      filledAt: OPENED_AT,
    });

    const roll1 = await rollLeg(
      db,
      userId,
      legId,
      {
        newSymbol: symbol2,
        quantity: '1',
        closePrice: '1.00',
        openPrice: '2.50',
        rolledAt: '2026-06-10T00:00:00.000Z',
      },
      GATE,
    );
    const roll2 = await rollLeg(
      db,
      userId,
      roll1.toPositionId,
      {
        newSymbol: symbol3,
        quantity: '1',
        closePrice: '1.50',
        openPrice: '3.00',
        rolledAt: '2026-06-20T00:00:00.000Z',
      },
      GATE,
    );

    // Cross-check against the chain read task 10 already shipped, so a
    // failure here is this task's bridge, not a regression in getRollChain.
    const directChain = await getRollChain(db, legId);
    expect(Number(directChain.netCredit)).toBe(500);

    const detail = await getPositionDetail(db, legId, userId);

    expect(
      (detail.rollChain.legs as Array<{ positionId: string }>).map((l) => l.positionId),
    ).toEqual([legId, roll1.toPositionId, roll2.toPositionId]);
    expect(Number(detail.rollChain.netCredit)).toBe(500);
  });
});

describe('getPositionDetail — a leg with Greeks reads entryGreeks, rhoPerPct nullable (AC 8.1)', () => {
  it('carries delta/gamma/thetaPerDay/vegaPerPct, rhoPerPct null, source chain', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'long',
      symbol: occSymbol(UNDERLYING, 'C', 150),
      entryPrice: '4',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
    });

    const greeks: EntryGreeksData = {
      delta: '0.500000000000',
      gamma: '0.020000000000',
      thetaPerDay: '-0.030000000000',
      vegaPerPct: '0.120000000000',
      rhoPerPct: null,
      source: 'chain',
      volatility: null,
      spot: null,
      rate: null,
      dividendYield: null,
      capturedAt: new Date('2026-06-02T00:00:00.000Z'),
    };
    await withTransaction(db, (tx) => upsertEntryGreeks(tx, legId, greeks));

    const detail = await getPositionDetail(db, legId, userId);

    expect(detail.entryGreeks).toBeDefined();
    expect(Number(detail.entryGreeks.delta)).toBe(0.5);
    expect(Number(detail.entryGreeks.gamma)).toBe(0.02);
    expect(Number(detail.entryGreeks.thetaPerDay)).toBe(-0.03);
    expect(Number(detail.entryGreeks.vegaPerPct)).toBe(0.12);
    expect(detail.entryGreeks.rhoPerPct).toBeNull();
    expect(detail.entryGreeks.source).toBe('chain');
  });
});

describe('getPositionDetail — after unsettle the settlements key is gone (AC 8.2)', () => {
  it('drops the settlements key once the settlement is unsettled', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: occSymbol(UNDERLYING, 'C', 150),
      entryPrice: '3',
      entryQty: '5',
      filledAt: BEFORE_EXPIRY,
    });

    const result = await settleLeg(db, userId, legId, { outcome: 'worthless' });

    const settledDetail = await getPositionDetail(db, legId, userId);
    expect(settledDetail.settlements).toHaveLength(1);

    await unsettle(db, userId, legId, result.settlementId);

    const detail = await getPositionDetail(db, legId, userId);
    expect(detail.settlements).toBeUndefined();
  });
});

describe('getPositionDetail — a plain position has none of the three keys (design C2)', () => {
  it('carries no settlements, rollChain or entryGreeks key', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: occSymbol(UNDERLYING, 'C', 150),
      entryPrice: '3',
      entryQty: '5',
      filledAt: BEFORE_EXPIRY,
    });

    const detail = await getPositionDetail(db, legId, userId);

    expect(detail.settlements).toBeUndefined();
    expect(detail.rollChain).toBeUndefined();
    expect(detail.entryGreeks).toBeUndefined();
  });
});

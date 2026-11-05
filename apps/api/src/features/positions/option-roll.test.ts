/**
 * Rolls and the chain read (design C6; task 10 of option-lifecycle-events).
 * Black-box over `rollLeg`/`getRollChain` directly — the house style from
 * `option-settlement.test.ts`: seed via raw inserts and the existing `*Tx`
 * seams, drive the function under test, assert on committed state. No route
 * exists yet, so every call here is service-level.
 *
 * Contract block — one entry per success criterion this task covers.
 * Pre-condition → call through the seam → observable result → source of the
 * expected value.
 *
 * A. A basic roll writes the exit, creates and opens the new leg, and links
 *    both in one chain (AC 5.1)
 *   Pre: an open short leg, one entry fill, no fee given.
 *   Call: `rollLeg(db, userId, legId, { newSymbol, quantity, closePrice,
 *     openPrice, rolledAt }, { isAdmin: false })`.
 *   Result: the old leg gets an exit fill at `closePrice`/`rolledAt` and
 *     closes (fully rolled); the new leg opens at `rolledAt` with one entry
 *     fill at `openPrice`, same side as the old leg; the result's
 *     `fromPositionId`/`toPositionId`/`newSymbol` name the two legs and the
 *     new symbol.
 *   Source: design C6 post-conditions 3-5; requirements AC 5.1.
 *
 * B. A different underlying is a 400 with no write (AC 5.1)
 *   Pre: an open short leg.
 *   Call: `rollLeg` with `newSymbol` on a different underlying.
 *   Result: rejects `ValidationError`; the leg stays open with one fill; no
 *     new position exists for the account.
 *   Source: design C6 post-condition 2; requirements AC 5.1.
 *
 * C. The same contract is a 400 with no write (AC 5.1)
 *   Pre: an open short leg.
 *   Call: `rollLeg` with `newSymbol` equal to the leg's own symbol.
 *   Result: rejects `ValidationError`; no write.
 *   Source: design C6 post-condition 2 ("different contract"); AC 5.1.
 *
 * D. A quantity above open units is a 400 with no write (AC 5.1)
 *   Pre: an open short leg with one open unit.
 *   Call: `rollLeg` with `quantity: '2'`.
 *   Result: rejects `ValidationError`; no write.
 *   Source: design C6 post-condition 2; AC 5.1.
 *
 * E. A rolledAt outside openedAt..now is a 400 with no write (AC 5.1)
 *   Pre: an open short leg.
 *   Call: `rollLeg` with `rolledAt` before the leg's own `openedAt`.
 *   Result: rejects `ValidationError`; no write.
 *   Source: design C6 post-condition 2; AC 5.1.
 *
 * F. A short put rolled twice reads one chain, three legs in order, netCredit
 *    500 before fees (AC 5.3)
 *   Pre: a short put sold at 2.00, rolled at 1.00 for 2.50, then at 1.50 for
 *     3.00 — all quantity 1, no fees.
 *   Call: `getRollChain(db, legId)` on the first leg.
 *   Result: `legs` holds the three leg ids in roll order; `netCredit` is 500.
 *   Source: design C6 Chain read; requirements AC 5.3.
 *
 * G. Fees reduce the chain's net credit (AC 5.2)
 *   Pre: a short put sold at 2.00, rolled at 1.00/2.50 with closeFees 0.50
 *     and openFees 0.30.
 *   Call: `getRollChain(db, legId)`.
 *   Result: `netCredit` is 349.20 ((2.00-1.00+2.50)*100 - 0.80).
 *   Source: design C6 Chain read; requirements AC 5.2.
 *
 * H. A partial roll leaves the rest open; a later roll of that leg extends
 *    the same chain (AC 5.1, design "chain_id... extends its chain")
 *   Pre: a short leg with 2 open units, partially rolled for quantity 1.
 *   Call: `rollLeg` a first time for quantity 1, then a second time on the
 *     SAME original leg for its remaining 1 unit.
 *   Result: after the first roll the leg stays `open`; the second roll's
 *     result carries the same `chainId` as the first.
 *   Source: design C6 post-condition 5.
 *
 * I. A grouped leg's new leg joins the group (AC 5.4)
 *   Pre: a 2-leg group (distinct strikes, same underlying).
 *   Call: `rollLeg` on one grouped leg into a third, distinct contract.
 *   Result: the new leg's `groupId` equals the group's id.
 *   Source: design C6 post-condition 4; requirements AC 5.4.
 *
 * J. A roll past MAX_GROUP_LEGS is refused with no write (AC 5.4)
 *   Pre: a full 8-leg group (distinct strikes, same underlying).
 *   Call: `rollLeg` on one grouped leg into a 9th, distinct contract.
 *   Result: rejects `ValidationError`; the group still has 8 legs; no new
 *     position exists for the account.
 *   Source: design C6 post-condition 2 (group leg count); requirements AC 5.4;
 *     `packages/shared/src/lib/strategy.ts:5` (`MAX_GROUP_LEGS`).
 *
 * K. A roll failing validateLegSet is refused with no write (AC 5.4)
 *   Pre: a 2-leg group with distinct strikes on one underlying.
 *   Call: `rollLeg` on one grouped leg into `newSymbol` equal to the OTHER
 *     leg's current symbol (duplicate within the group).
 *   Result: rejects `ValidationError`; the rolled leg stays open; no new
 *     position exists for the account.
 *   Source: design C6 post-condition 2; `packages/shared/src/lib/
 *     strategy.ts:154-181` (`validateLegSet`); requirements AC 5.4.
 *
 * L. At the tier cap, a roll is a 403 TIER_LIMIT_POSITIONS before any write,
 *    and fires no hook (AC 5.5, NFR Reliability — refused roll fires no hook)
 *   Pre: a user already at the free plan's position cap, gating on; a fill
 *     hook registered to record the contexts it is called with.
 *   Call: `rollLeg`.
 *   Result: rejects with `statusCode: 403, code: 'TIER_LIMIT_POSITIONS'`; the
 *     account's position count is unchanged; the hook is never called.
 *   Source: design C6 post-condition 2 (`assertPositionCreateAllowed`);
 *     requirements AC 5.5; Error Handling #3; NFR Reliability.
 *
 * M. A rolled leg later assigned puts only its own premium in the stock
 *    basis, and the chain excludes its exit (AC 5.6, design D8)
 *   Pre: a short put rolled once (2.00 -> 1.00/2.50); the new leg then
 *     settled `assigned`.
 *   Call: `settleLeg(db, userId, newLegId, { outcome: 'assigned', ... })`,
 *     then `getRollChain(db, legId)`.
 *   Result: the opened stock position's entry fill price is strike - 2.50
 *     (the new leg's own premium only); the chain's `netCredit` is 350
 *     ((2.00-1.00+2.50)*100), excluding the settlement's premium-priced exit.
 *   Source: design C6 Chain read (D8); requirements AC 5.6.
 *
 * N. A registered fill hook posts the exit's delta (NFR Reliability)
 *   Pre: an open short leg; a fill hook registered to record contexts.
 *   Call: `rollLeg`.
 *   Result: the hook runs twice — first for the old leg's exit, with
 *     `occurredAt` equal to `rolledAt`.
 *   Source: requirements NFR Reliability; design C6 post-conditions 3-4
 *     (both call `addFillTx`, which runs `runFillHooks`).
 *
 * O. A throwing fill hook rolls back both legs and the link, and emits no
 *    event (NFR Reliability, AC 11.7)
 *   Pre: an open short leg; a fill hook registered to throw.
 *   Call: `rollLeg`.
 *   Result: rejects; the old leg stays open with its one original fill; no
 *     new position exists for the account; no `position_rolls` row names the
 *     old leg; `captureServerEvent` is never called.
 *   Source: requirements NFR Reliability; design Error Handling #4; AC 11.7.
 *
 * P. position_rolled carries enum properties only, after commit (AC 11.7)
 *   Pre: an open short leg.
 *   Call: `rollLeg`.
 *   Result: `captureServerEvent` is called exactly once with
 *     `'position_rolled'` and `distinctId: userId`; the committed
 *     `position_rolls` row is already queryable when the call happens (after
 *     commit); no property value equals the new symbol, the roll id, the
 *     chain id, or either position id (no identifiers or financial figures —
 *     enums only).
 *   Source: design C6 post-condition 6; requirements AC 11.7.
 *
 * Folded/out-of-scope criteria (recorded, not separately retested here):
 *   - L folds the NFR Reliability "a refused roll fires no hook" clause into
 *     the AC 5.5 tier-cap test — both share the same refusal, before any
 *     write, where the only fresh observable is the absent hook call.
 *   - The `_how-its-built.json` / eslint / check-types checklist items are
 *     implementer-side checks, not success criteria the prompt lists under
 *     "Success:" — not retested here.
 */
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { accounts, fills, positionRolls, positions, users } from '@/db/schema';
import { getTierLimits } from '@/features/billing/tier-limits.constants';
import { getRollChain } from '@/features/positions/option-roll.query';
import { rollLeg } from '@/features/positions/option-roll.service';
import { settleLeg } from '@/features/positions/option-settlement.service';
import { insertPositionGroup } from '@/features/positions/position-groups.query';
import { createPositionGroup } from '@/features/positions/position-groups.service';
import {
  addFillTx,
  createPositionTx,
  openPositionTx,
  registerFillHook,
  unregisterFillHook,
  type FillHookContext,
} from '@/features/positions/positions.service';
import { config } from '@/lib/config';
import { ValidationError } from '@/lib/errors';
import * as posthog from '@/lib/posthog';
import { withTransaction } from '@/lib/transaction';

const UNDERLYING = 'AAPL';
const GATE = { isAdmin: false };

const HOOK_NAMES = ['option-roll-spy', 'option-roll-throw', 'option-roll-cap-spy'];

afterEach(() => {
  for (const name of HOOK_NAMES) unregisterFillHook(name);
  vi.restoreAllMocks();
});

let counter = 0;
function uniqueEmail() {
  return `option-roll-${Date.now()}-${++counter}@example.com`;
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
    .values({ userId: user!.id, name: 'Roll Account', currency: 'USD' })
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

async function createGroupedLeg(params: {
  userId: string;
  accountId: string;
  groupId: string;
  symbol: string;
  entryPrice: string;
  entryQty: string;
  filledAt: string;
}) {
  return withTransaction(db, async (tx) => {
    const pos = await createPositionTx(
      tx,
      params.userId,
      {
        accountId: params.accountId,
        symbol: params.symbol,
        side: 'short',
        assetType: 'option',
      },
      params.groupId,
    );
    await addFillTx(tx, pos!.id, params.userId, {
      type: 'entry',
      price: params.entryPrice,
      quantity: params.entryQty,
      fees: '0',
      filledAt: params.filledAt,
    });
    await openPositionTx(tx, pos!.id, params.userId, params.filledAt);
    return pos!.id as string;
  });
}

async function getPositionRow(id: string) {
  const rows = await db.select().from(positions).where(eq(positions.id, id));
  return rows[0]!;
}

async function getFillsForLeg(legId: string) {
  return db.select().from(fills).where(eq(fills.positionId, legId));
}

async function countPositionsForAccount(accountId: string) {
  const rows = await db.select().from(positions).where(eq(positions.accountId, accountId));
  return rows.length;
}

const OPENED_AT = '2026-06-01T00:00:00.000Z';
const ROLLED_AT = '2026-06-10T00:00:00.000Z';

describe('rollLeg — a basic roll writes the exit, creates and opens the new leg, and links them (AC 5.1)', () => {
  it('exits the old leg at closePrice, opens the new leg at openPrice on the same side, and links both', async () => {
    const symbol1 = occSymbol(UNDERLYING, 'P', 150);
    const symbol2 = occSymbol(UNDERLYING, 'P', 145);
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: symbol1,
      entryPrice: '2.00',
      entryQty: '1',
      filledAt: OPENED_AT,
    });

    const result = await rollLeg(
      db,
      userId,
      legId,
      {
        newSymbol: symbol2,
        quantity: '1',
        closePrice: '1.00',
        openPrice: '2.50',
        rolledAt: ROLLED_AT,
      },
      GATE,
    );

    expect(result.fromPositionId).toBe(legId);
    expect(result.newSymbol).toBe(symbol2);

    const oldLegFills = await getFillsForLeg(legId);
    const exit = oldLegFills.find((f) => f.type === 'exit');
    expect(exit).toBeDefined();
    expect(Number(exit!.price)).toBe(1.0);
    expect(exit!.filledAt.getTime()).toBe(new Date(ROLLED_AT).getTime());

    const oldLeg = await getPositionRow(legId);
    expect(oldLeg.status).toBe('closed');

    const newLeg = await getPositionRow(result.toPositionId);
    expect(newLeg.symbol).toBe(symbol2);
    expect(newLeg.side).toBe('short');
    expect(newLeg.status).toBe('open');
    expect(newLeg.openedAt!.getTime()).toBe(new Date(ROLLED_AT).getTime());

    const newLegFills = await getFillsForLeg(result.toPositionId);
    const entry = newLegFills.find((f) => f.type === 'entry');
    expect(entry).toBeDefined();
    expect(Number(entry!.price)).toBe(2.5);

    const rollRows = await db
      .select()
      .from(positionRolls)
      .where(eq(positionRolls.fromPositionId, legId));
    expect(rollRows).toHaveLength(1);
    expect(rollRows[0]!.toPositionId).toBe(result.toPositionId);
    expect(rollRows[0]!.id).toBe(result.rollId);
    expect(rollRows[0]!.chainId).toBe(result.chainId);
  });
});

describe('rollLeg — a different underlying is a 400 with no write (AC 5.1)', () => {
  it('rejects ValidationError and writes nothing', async () => {
    const symbol1 = occSymbol(UNDERLYING, 'P', 150);
    const symbolOther = occSymbol('MSFT', 'P', 150);
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: symbol1,
      entryPrice: '2.00',
      entryQty: '1',
      filledAt: OPENED_AT,
    });

    const beforeCount = await countPositionsForAccount(accountId);

    await expect(
      rollLeg(
        db,
        userId,
        legId,
        {
          newSymbol: symbolOther,
          quantity: '1',
          closePrice: '1.00',
          openPrice: '2.50',
          rolledAt: ROLLED_AT,
        },
        GATE,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await countPositionsForAccount(accountId)).toBe(beforeCount);
    const leg = await getPositionRow(legId);
    expect(leg.status).toBe('open');
    expect(await getFillsForLeg(legId)).toHaveLength(1);
  });
});

describe('rollLeg — the same contract is a 400 with no write (AC 5.1)', () => {
  it('rejects ValidationError and writes nothing', async () => {
    const symbol1 = occSymbol(UNDERLYING, 'P', 150);
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: symbol1,
      entryPrice: '2.00',
      entryQty: '1',
      filledAt: OPENED_AT,
    });

    const beforeCount = await countPositionsForAccount(accountId);

    await expect(
      rollLeg(
        db,
        userId,
        legId,
        {
          newSymbol: symbol1,
          quantity: '1',
          closePrice: '1.00',
          openPrice: '2.50',
          rolledAt: ROLLED_AT,
        },
        GATE,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await countPositionsForAccount(accountId)).toBe(beforeCount);
    expect((await getPositionRow(legId)).status).toBe('open');
  });
});

describe('rollLeg — a quantity above open units is a 400 with no write (AC 5.1)', () => {
  it('rejects ValidationError and writes nothing', async () => {
    const symbol1 = occSymbol(UNDERLYING, 'P', 150);
    const symbol2 = occSymbol(UNDERLYING, 'P', 145);
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: symbol1,
      entryPrice: '2.00',
      entryQty: '1',
      filledAt: OPENED_AT,
    });

    const beforeCount = await countPositionsForAccount(accountId);

    await expect(
      rollLeg(
        db,
        userId,
        legId,
        {
          newSymbol: symbol2,
          quantity: '2',
          closePrice: '1.00',
          openPrice: '2.50',
          rolledAt: ROLLED_AT,
        },
        GATE,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await countPositionsForAccount(accountId)).toBe(beforeCount);
    expect((await getPositionRow(legId)).status).toBe('open');
    expect(await getFillsForLeg(legId)).toHaveLength(1);
  });
});

describe('rollLeg — a rolledAt outside openedAt..now is a 400 with no write (AC 5.1)', () => {
  it('rejects ValidationError and writes nothing', async () => {
    const symbol1 = occSymbol(UNDERLYING, 'P', 150);
    const symbol2 = occSymbol(UNDERLYING, 'P', 145);
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: symbol1,
      entryPrice: '2.00',
      entryQty: '1',
      filledAt: OPENED_AT,
    });

    const beforeCount = await countPositionsForAccount(accountId);
    const beforeOpenedAt = '2026-05-01T00:00:00.000Z';

    await expect(
      rollLeg(
        db,
        userId,
        legId,
        {
          newSymbol: symbol2,
          quantity: '1',
          closePrice: '1.00',
          openPrice: '2.50',
          rolledAt: beforeOpenedAt,
        },
        GATE,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await countPositionsForAccount(accountId)).toBe(beforeCount);
    expect((await getPositionRow(legId)).status).toBe('open');
    expect(await getFillsForLeg(legId)).toHaveLength(1);
  });
});

describe('getRollChain — a short put rolled twice reads one chain, netCredit 500 before fees (AC 5.3)', () => {
  it('reads three legs in roll order and a 500 net credit', async () => {
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

    const chain = await getRollChain(db, legId);

    expect(chain.legs.map((l: { positionId: string }) => l.positionId)).toEqual([
      legId,
      roll1.toPositionId,
      roll2.toPositionId,
    ]);
    expect(Number(chain.netCredit)).toBe(500);
  });
});

describe('getRollChain — fees reduce the chain net credit (AC 5.2)', () => {
  it('subtracts the close and open fees from the net credit', async () => {
    const symbol1 = occSymbol(UNDERLYING, 'P', 150);
    const symbol2 = occSymbol(UNDERLYING, 'P', 145);
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: symbol1,
      entryPrice: '2.00',
      entryQty: '1',
      filledAt: OPENED_AT,
    });

    await rollLeg(
      db,
      userId,
      legId,
      {
        newSymbol: symbol2,
        quantity: '1',
        closePrice: '1.00',
        openPrice: '2.50',
        closeFees: '0.50',
        openFees: '0.30',
        rolledAt: ROLLED_AT,
      },
      GATE,
    );

    const chain = await getRollChain(db, legId);
    expect(Number(chain.netCredit)).toBeCloseTo(349.2, 6);
  });
});

describe('rollLeg — a partial roll leaves the rest open; a later roll of that leg extends the same chain (AC 5.1)', () => {
  it('keeps the leg open after a partial roll, then reuses the chain id on a second roll of it', async () => {
    const symbol1 = occSymbol(UNDERLYING, 'P', 150);
    const symbol2 = occSymbol(UNDERLYING, 'P', 145);
    const symbol3 = occSymbol(UNDERLYING, 'P', 140);
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: symbol1,
      entryPrice: '2.00',
      entryQty: '2',
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

    expect((await getPositionRow(legId)).status).toBe('open');
    expect(await getFillsForLeg(legId)).toHaveLength(2);

    const roll2 = await rollLeg(
      db,
      userId,
      legId,
      {
        newSymbol: symbol3,
        quantity: '1',
        closePrice: '1.20',
        openPrice: '2.60',
        rolledAt: '2026-06-15T00:00:00.000Z',
      },
      GATE,
    );

    expect(roll2.chainId).toBe(roll1.chainId);
  });
});

describe("rollLeg — a grouped leg's new leg joins the group (AC 5.4)", () => {
  it("sets the new leg's groupId to the group's id", async () => {
    const { userId, accountId } = await seedUserAndAccount();
    const [group] = await withTransaction(db, (tx) =>
      insertPositionGroup(tx, { userId, labelOverride: null }),
    );

    const legAId = await createGroupedLeg({
      userId,
      accountId,
      groupId: group!.id,
      symbol: occSymbol(UNDERLYING, 'P', 150),
      entryPrice: '2.00',
      entryQty: '1',
      filledAt: OPENED_AT,
    });
    await createGroupedLeg({
      userId,
      accountId,
      groupId: group!.id,
      symbol: occSymbol(UNDERLYING, 'P', 140),
      entryPrice: '2.00',
      entryQty: '1',
      filledAt: OPENED_AT,
    });

    const result = await rollLeg(
      db,
      userId,
      legAId,
      {
        newSymbol: occSymbol(UNDERLYING, 'P', 145),
        quantity: '1',
        closePrice: '1.00',
        openPrice: '2.50',
        rolledAt: ROLLED_AT,
      },
      GATE,
    );

    const newLeg = await getPositionRow(result.toPositionId);
    expect(newLeg.groupId).toBe(group!.id);
  });
});

describe('rollLeg — a roll past MAX_GROUP_LEGS is refused with no write (AC 5.4)', () => {
  it('rejects ValidationError and leaves the group at 8 legs', async () => {
    const { userId, accountId } = await seedUserAndAccount();
    const legs = Array.from({ length: 8 }, (_, i) => ({
      symbol: occSymbol(UNDERLYING, 'P', 100 + i * 5),
      side: 'short' as const,
      assetType: 'option' as const,
      quantity: '1',
      price: '2.00',
      fees: '0',
    }));
    const entry = await createPositionGroup(
      db,
      userId,
      { accountId, filledAt: OPENED_AT, legs },
      GATE,
    );
    const legToRoll = entry.legs.find((l) => l.symbol === legs[0]!.symbol)!;

    const beforeCount = await countPositionsForAccount(accountId);

    await expect(
      rollLeg(
        db,
        userId,
        legToRoll.id,
        {
          newSymbol: occSymbol(UNDERLYING, 'P', 140),
          quantity: '1',
          closePrice: '1.00',
          openPrice: '2.50',
          rolledAt: ROLLED_AT,
        },
        GATE,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await countPositionsForAccount(accountId)).toBe(beforeCount);
  });
});

describe('rollLeg — a roll failing validateLegSet is refused with no write (AC 5.4)', () => {
  it('rejects ValidationError and writes nothing when the new symbol repeats the other leg', async () => {
    const { userId, accountId } = await seedUserAndAccount();
    const [group] = await withTransaction(db, (tx) =>
      insertPositionGroup(tx, { userId, labelOverride: null }),
    );
    const symbolA = occSymbol(UNDERLYING, 'P', 150);
    const symbolB = occSymbol(UNDERLYING, 'P', 140);

    const legAId = await createGroupedLeg({
      userId,
      accountId,
      groupId: group!.id,
      symbol: symbolA,
      entryPrice: '2.00',
      entryQty: '1',
      filledAt: OPENED_AT,
    });
    await createGroupedLeg({
      userId,
      accountId,
      groupId: group!.id,
      symbol: symbolB,
      entryPrice: '2.00',
      entryQty: '1',
      filledAt: OPENED_AT,
    });

    const beforeCount = await countPositionsForAccount(accountId);

    await expect(
      rollLeg(
        db,
        userId,
        legAId,
        {
          newSymbol: symbolB,
          quantity: '1',
          closePrice: '1.00',
          openPrice: '2.50',
          rolledAt: ROLLED_AT,
        },
        GATE,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await countPositionsForAccount(accountId)).toBe(beforeCount);
    expect((await getPositionRow(legAId)).status).toBe('open');
  });
});

describe('rollLeg — at the tier cap, a roll is 403 TIER_LIMIT_POSITIONS before any write, and fires no hook (AC 5.5, NFR Reliability)', () => {
  const prevGating = config.FEATURE_GATING;
  afterEach(() => {
    config.FEATURE_GATING = prevGating;
  });

  it('rejects AppError(403, TIER_LIMIT_POSITIONS), leaves the position count unchanged, and never calls the hook', async () => {
    const symbol1 = occSymbol(UNDERLYING, 'P', 150);
    const symbol2 = occSymbol(UNDERLYING, 'P', 145);
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: symbol1,
      entryPrice: '2.00',
      entryQty: '1',
      filledAt: OPENED_AT,
    });

    const cap = getTierLimits('free').positions!;
    const rows = Array.from({ length: cap - 1 }, (_, i) => ({
      userId,
      accountId,
      symbol: `SYM${i}`,
      side: 'long',
      assetType: 'stock',
      status: 'open',
    }));
    // eslint-disable-next-line no-restricted-syntax
    await db.insert(positions).values(rows);

    config.FEATURE_GATING = true;

    const seen: FillHookContext[] = [];
    registerFillHook('option-roll-cap-spy', async (_tx, ctx) => {
      seen.push(ctx);
    });

    const beforeCount = await countPositionsForAccount(accountId);

    await expect(
      rollLeg(
        db,
        userId,
        legId,
        {
          newSymbol: symbol2,
          quantity: '1',
          closePrice: '1.00',
          openPrice: '2.50',
          rolledAt: ROLLED_AT,
        },
        GATE,
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: 'TIER_LIMIT_POSITIONS' });

    expect(await countPositionsForAccount(accountId)).toBe(beforeCount);
    expect(seen).toHaveLength(0);
  });
});

describe('rollLeg + settleLeg — a rolled leg later assigned uses only its own premium; the chain excludes its exit (AC 5.6, design D8)', () => {
  it("opens the stock position at strike minus the new leg's own premium, and getRollChain excludes the settlement exit", async () => {
    const strike1 = 150;
    const strike2 = 145;
    const symbol1 = occSymbol(UNDERLYING, 'P', strike1);
    const symbol2 = occSymbol(UNDERLYING, 'P', strike2);
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: symbol1,
      entryPrice: '2.00',
      entryQty: '1',
      filledAt: OPENED_AT,
    });

    const roll = await rollLeg(
      db,
      userId,
      legId,
      {
        newSymbol: symbol2,
        quantity: '1',
        closePrice: '1.00',
        openPrice: '2.50',
        rolledAt: ROLLED_AT,
      },
      GATE,
    );

    const settlement = await settleLeg(db, userId, roll.toPositionId, {
      outcome: 'assigned',
      settledAt: '2026-06-15T00:00:00.000Z',
      quantity: '1',
    });

    const stockPositionId = settlement.openedPositionIds[0]!;
    const stockFills = await getFillsForLeg(stockPositionId);
    const stockEntry = stockFills.find((f) => f.type === 'entry');
    expect(stockEntry).toBeDefined();
    // strike2 - the new leg's own premium (2.50), NOT the chain's cumulative credit.
    expect(Number(stockEntry!.price)).toBe(strike2 - 2.5);

    const chain = await getRollChain(db, legId);
    expect(chain.legs).toHaveLength(2);
    // (2.00 - 1.00 + 2.50) * 100 = 350, excluding the settlement's
    // premium-priced exit on the new leg (design D8).
    expect(Number(chain.netCredit)).toBe(350);
  });
});

describe("rollLeg — a registered fill hook posts the exit's delta (NFR Reliability)", () => {
  it('runs the hook for the exit, with occurredAt at rolledAt', async () => {
    const symbol1 = occSymbol(UNDERLYING, 'P', 150);
    const symbol2 = occSymbol(UNDERLYING, 'P', 145);
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: symbol1,
      entryPrice: '2.00',
      entryQty: '1',
      filledAt: OPENED_AT,
    });

    const seen: FillHookContext[] = [];
    registerFillHook('option-roll-spy', async (_tx, ctx) => {
      seen.push(ctx);
    });

    const result = await rollLeg(
      db,
      userId,
      legId,
      {
        newSymbol: symbol2,
        quantity: '1',
        closePrice: '1.00',
        openPrice: '2.50',
        rolledAt: ROLLED_AT,
      },
      GATE,
    );

    expect(seen).toHaveLength(2);
    expect(seen[0]!.positionId).toBe(legId);
    expect(seen[0]!.occurredAt.getTime()).toBe(new Date(ROLLED_AT).getTime());
    expect(seen[1]!.positionId).toBe(result.toPositionId);
    expect(seen[1]!.occurredAt.getTime()).toBe(new Date(ROLLED_AT).getTime());
  });
});

describe('rollLeg — a throwing fill hook rolls back both legs and the link, and emits no event (NFR Reliability, AC 11.7)', () => {
  it('rejects, leaves the old leg untouched, writes no new leg or link, and never captures position_rolled', async () => {
    const symbol1 = occSymbol(UNDERLYING, 'P', 150);
    const symbol2 = occSymbol(UNDERLYING, 'P', 145);
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: symbol1,
      entryPrice: '2.00',
      entryQty: '1',
      filledAt: OPENED_AT,
    });

    const captureSpy = vi.spyOn(posthog, 'captureServerEvent').mockImplementation(() => {});
    registerFillHook('option-roll-throw', async () => {
      throw new Error('injected fill-hook failure');
    });

    const beforeCount = await countPositionsForAccount(accountId);

    await expect(
      rollLeg(
        db,
        userId,
        legId,
        {
          newSymbol: symbol2,
          quantity: '1',
          closePrice: '1.00',
          openPrice: '2.50',
          rolledAt: ROLLED_AT,
        },
        GATE,
      ),
    ).rejects.toThrow('injected fill-hook failure');

    expect(captureSpy).not.toHaveBeenCalled();
    const leg = await getPositionRow(legId);
    expect(leg.status).toBe('open');
    expect(await getFillsForLeg(legId)).toHaveLength(1);
    expect(await countPositionsForAccount(accountId)).toBe(beforeCount);

    const rollRows = await db
      .select()
      .from(positionRolls)
      .where(eq(positionRolls.fromPositionId, legId));
    expect(rollRows).toHaveLength(0);
  });
});

describe('rollLeg — position_rolled carries enum properties only, after commit (AC 11.7)', () => {
  it('fires once with distinctId: userId and no identifying or financial property value', async () => {
    const symbol1 = occSymbol(UNDERLYING, 'P', 150);
    const symbol2 = occSymbol(UNDERLYING, 'P', 145);
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: symbol1,
      entryPrice: '2.00',
      entryQty: '1',
      filledAt: OPENED_AT,
    });

    const captureSpy = vi.spyOn(posthog, 'captureServerEvent').mockImplementation(() => {});

    const result = await rollLeg(
      db,
      userId,
      legId,
      {
        newSymbol: symbol2,
        quantity: '1',
        closePrice: '1.00',
        openPrice: '2.50',
        rolledAt: ROLLED_AT,
      },
      GATE,
    );

    expect(captureSpy).toHaveBeenCalledTimes(1);
    const [eventName, payload] = captureSpy.mock.calls[0]!;
    expect(eventName).toBe('position_rolled');
    expect(payload.distinctId).toBe(userId);

    const forbiddenValues = [
      symbol2,
      result.rollId,
      result.chainId,
      result.fromPositionId,
      result.toPositionId,
    ];
    const propertyValues = Object.values(payload.properties ?? {});
    for (const forbidden of forbiddenValues) {
      expect(propertyValues).not.toContain(forbidden);
    }

    // After-commit: the link is already persisted and queryable when the
    // capture call happens.
    const rollRows = await db
      .select()
      .from(positionRolls)
      .where(
        and(
          eq(positionRolls.fromPositionId, legId),
          eq(positionRolls.toPositionId, result.toPositionId),
        ),
      );
    expect(rollRows).toHaveLength(1);
  });
});

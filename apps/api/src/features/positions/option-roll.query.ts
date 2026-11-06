import Decimal from 'decimal.js';
import { and, eq, inArray, or } from 'drizzle-orm';

import type { Database, Transaction } from '@/db';
import {
  fills,
  optionSettlementFills,
  optionSettlements,
  positionRolls,
  positions,
} from '@/db/schema';

// Writes and the chain read for option rolls (design C6). Split out of the
// service — the repo's thin-query-layer convention — and also the bridge
// task 12's detail read imports `getRollChain` through, so that read never
// cycles back into `option-roll.service.ts` (TD5).

export function insertPositionRoll(
  tx: Transaction,
  data: {
    userId: string;
    chainId: string;
    fromPositionId: string;
    toPositionId: string;
    exitFillId: string;
    entryFillId: string;
    rolledAt: Date;
  },
) {
  return tx.insert(positionRolls).values(data).returning();
}

/**
 * Any existing roll naming this leg, on either side — so a chained or
 * partially-rolled leg extends its chain rather than starting a new one
 * (design C6 post-condition 5). Null when the leg has never been part of a
 * roll.
 */
export async function findChainIdForLeg(
  db: Database | Transaction,
  legId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ chainId: positionRolls.chainId })
    .from(positionRolls)
    .where(or(eq(positionRolls.fromPositionId, legId), eq(positionRolls.toPositionId, legId)))
    .limit(1);
  return row?.chainId ?? null;
}

type RollRow = {
  id: string;
  rolledAt: Date;
  fromPositionId: string;
  toPositionId: string;
};

/** `rolled_at, id` edge order (design C6 Chain read). */
function orderRolls(rows: RollRow[]): RollRow[] {
  return [...rows].sort((a, b) => {
    const byRolledAt = a.rolledAt.getTime() - b.rolledAt.getTime();
    return byRolledAt !== 0 ? byRolledAt : a.id.localeCompare(b.id);
  });
}

/**
 * The chain read (design C6 Chain read). `positionId` may name any leg of
 * the chain — a leg that was never rolled reads as a one-leg chain of
 * itself. Legs come back in `rolled_at, id` edge order: the chain's first
 * from-leg, then each roll's to-leg in turn.
 *
 * `netCredit` sums every chain fill's side-signed premium, × 100, less fees:
 * for a short leg an entry is a credit and an exit a debit (symmetric, with
 * the signs flipped, for long — rolls preserve side, so one sign serves the
 * whole chain). It excludes the written exit of an assigned or exercised
 * settlement on a chain leg (design D8): that exit re-prices the stock the
 * settlement opened and moves no cash of its own, so counting it would double
 * that leg's premium against the stock basis Requirement 5.6 already carries
 * it into.
 */
export async function getRollChain(
  db: Database,
  positionId: string,
): Promise<{
  legs: Array<{ positionId: string; symbol: string; rolledAt: string }>;
  netCredit: string;
}> {
  const chainId = await findChainIdForLeg(db, positionId);

  // The edge that brought each leg into the chain: the leg before a roll
  // reads its own `rolledAt` as the edge that carried it out; the chain's
  // first from-leg has no incoming edge, so it reads its own open instead.
  let legIds: string[];
  const rolledAtByLegId = new Map<string, Date>();
  if (chainId === null) {
    legIds = [positionId];
  } else {
    const rollRows = await db
      .select()
      .from(positionRolls)
      .where(eq(positionRolls.chainId, chainId));
    const ordered = orderRolls(rollRows);
    legIds = [ordered[0]!.fromPositionId, ...ordered.map((r) => r.toPositionId)];
    for (const roll of ordered) rolledAtByLegId.set(roll.fromPositionId, roll.rolledAt);
  }

  const legRows = await db
    .select({
      id: positions.id,
      symbol: positions.symbol,
      side: positions.side,
      openedAt: positions.openedAt,
    })
    .from(positions)
    .where(inArray(positions.id, legIds));
  const legById = new Map(legRows.map((r) => [r.id, r]));
  const shortMultiplier = legRows[0]?.side === 'short' ? 1 : -1;

  // The settlement's own leg-exit fill, for an assigned or exercised
  // settlement on one of these legs (design D8). Joining `fills` and
  // comparing its `positionId` to the settlement's own `positionId` picks out
  // only that leg-exit fill, never a stock row the same settlement wrote.
  const exclusionRows = await db
    .select({ fillId: optionSettlementFills.fillId })
    .from(optionSettlements)
    .innerJoin(optionSettlementFills, eq(optionSettlementFills.settlementId, optionSettlements.id))
    .innerJoin(fills, eq(fills.id, optionSettlementFills.fillId))
    .where(
      and(
        inArray(optionSettlements.positionId, legIds),
        inArray(optionSettlements.outcome, ['assigned', 'exercised']),
        eq(optionSettlementFills.written, true),
        eq(fills.positionId, optionSettlements.positionId),
      ),
    );
  const excludedFillIds = new Set(
    exclusionRows.map((r) => r.fillId).filter((id): id is string => id !== null),
  );

  const legFills = await db.select().from(fills).where(inArray(fills.positionId, legIds));

  let netCredit = new Decimal(0);
  for (const fill of legFills) {
    if (excludedFillIds.has(fill.id)) continue;
    const premiumSign = (fill.type === 'entry' ? 1 : -1) * shortMultiplier;
    netCredit = netCredit
      .plus(new Decimal(fill.price).times(fill.quantity).times(100).times(premiumSign))
      .minus(fill.fees);
  }

  return {
    legs: legIds.map((id) => {
      const leg = legById.get(id);
      const rolledAt = rolledAtByLegId.get(id) ?? leg?.openedAt ?? null;
      return {
        positionId: id,
        symbol: leg?.symbol ?? '',
        rolledAt: rolledAt ? rolledAt.toISOString() : '',
      };
    }),
    netCredit: netCredit.toFixed(2),
  };
}

import { randomUUID } from 'node:crypto';

import Decimal from 'decimal.js';

import { encodeOccCompact, parseOccSymbol } from '@tradr/shared';
import { MAX_GROUP_LEGS, validateLegSet } from '@tradr/shared/lib/strategy';

import type { Database, Transaction } from '@/db';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { captureServerEvent } from '@/lib/posthog';
import { withTransaction } from '@/lib/transaction';

import { findChainIdForLeg, insertPositionRoll } from './option-roll.query';
import { lockGroupLegs, lockLegs } from './position-groups.query';
import { findPositionById, sumFillQuantityByType } from './positions.query';
import {
  addFillTx,
  assertPositionCreateAllowed,
  closeIfBalancedTx,
  createPositionTx,
  openPositionTx,
} from './positions.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawRow = Record<string, any>;

export interface RollLegInput {
  newSymbol: string;
  quantity: string;
  closePrice: string;
  openPrice: string;
  closeFees?: string;
  openFees?: string;
  rolledAt: string;
}

export interface RollResult {
  rollId: string;
  chainId: string;
  fromPositionId: string;
  toPositionId: string;
  newSymbol: string;
}

/**
 * Runs design C6's six post-conditions, in order, inside the caller's
 * transaction.
 */
async function rollLegTx(
  tx: Transaction,
  userId: string,
  legId: string,
  input: RollLegInput,
  gate: { isAdmin: boolean },
): Promise<RollResult> {
  // 1. Grouped leg: lock the whole group. Ungrouped: lock the one row, then
  // re-check group_id the way `removePosition` does — a concurrent group
  // join between this read and the lock is a conflict, not silently ignored.
  const preRows = await findPositionById(tx, legId, userId);
  if (preRows.length === 0) {
    throw new NotFoundError('Position', legId);
  }
  const groupId = preRows[0].groupId as string | null;

  let lockedRows: RawRow[];
  if (groupId) {
    lockedRows = await lockGroupLegs(tx, userId, groupId);
  } else {
    lockedRows = await lockLegs(tx, userId, [legId]);
    if (lockedRows[0]?.group_id) {
      throw new ConflictError('The group changed; try again.');
    }
  }
  const position = lockedRows.find((r) => r.id === legId);
  if (!position) {
    throw new NotFoundError('Position', legId);
  }

  // 2. Validate — every check below runs before any write. A closed leg has
  // no open units, so the quantity check below already refuses it; no
  // separate status check is needed (addFillTx's own guard covers a draft
  // leg the same way, before its own write).
  const parsedCurrent = parseOccSymbol(position.symbol as string);
  if (!parsedCurrent.ok) {
    throw new ValidationError('The leg is not a valid OCC contract');
  }
  const parsedNew = parseOccSymbol(input.newSymbol);
  if (!parsedNew.ok) {
    throw new ValidationError('newSymbol is not a valid OCC contract');
  }
  if (parsedNew.value.underlying !== parsedCurrent.value.underlying) {
    throw new ValidationError('A roll must stay on the same underlying');
  }
  const sameContract =
    parsedNew.value.type === parsedCurrent.value.type &&
    parsedNew.value.expiration === parsedCurrent.value.expiration &&
    parsedNew.value.strike === parsedCurrent.value.strike;
  if (sameContract) {
    throw new ValidationError('A roll must move to a different contract');
  }

  // Representability guard only (positions.symbol is varchar(20)): confirms
  // the contract CAN be compacted, without storing this value. The stored/
  // returned symbol stays `input.newSymbol` verbatim — matching
  // `editPosition`'s own precedent (`positions.service.ts:769`) of validating
  // a symbol via `parseOccSymbol` while storing exactly what was given, never
  // a re-derived string. `encodeOccCompact` re-minimises an already-compact
  // round-strike symbol (e.g. an 8-digit-strike "P00145000" down to "P145"),
  // so storing ITS value here would silently rewrite a symbol the caller
  // chose not to shorten.
  if (!encodeOccCompact(parsedNew.value).ok) {
    throw new ValidationError('newSymbol cannot be represented as a compact OCC symbol');
  }

  const [{ total: entryTotal }] = await sumFillQuantityByType(tx, legId, 'entry');
  const [{ total: exitTotal }] = await sumFillQuantityByType(tx, legId, 'exit');
  const openUnits = new Decimal(entryTotal).minus(exitTotal);
  if (new Decimal(input.quantity).gt(openUnits)) {
    throw new ValidationError("Roll quantity exceeds the leg's open units");
  }

  const rolledAt = new Date(input.rolledAt);
  const openedAt = position.opened_at ? new Date(position.opened_at as string) : null;
  if (openedAt && rolledAt.getTime() < openedAt.getTime()) {
    throw new ValidationError("rolledAt cannot precede the leg's own openedAt");
  }
  if (rolledAt.getTime() > Date.now()) {
    throw new ValidationError('rolledAt cannot be in the future');
  }

  await assertPositionCreateAllowed(tx, userId, position.account_id as string, 1, gate);

  if (groupId) {
    if (lockedRows.length + 1 > MAX_GROUP_LEGS) {
      throw new ValidationError(`A group may not exceed ${MAX_GROUP_LEGS} legs`);
    }
    const candidateLegs = [
      ...lockedRows.map((r) => ({
        symbol: r.symbol as string,
        assetType: r.asset_type as 'stock' | 'option',
      })),
      { symbol: input.newSymbol, assetType: 'option' as const },
    ];
    const fault = validateLegSet(candidateLegs);
    if (fault) {
      throw new ValidationError(fault.message, { legIndex: String(fault.index) });
    }
  }

  // 3. Exit the old leg, then close it if that balances it (a partial roll
  // leaves it open).
  const exitFill = await addFillTx(tx, legId, userId, {
    type: 'exit',
    price: input.closePrice,
    quantity: input.quantity,
    fees: input.closeFees ?? '0',
    filledAt: input.rolledAt,
  });
  await closeIfBalancedTx(tx, legId, userId, input.rolledAt, { fillJustWritten: true });

  // 4. Create the new leg in the same group (if any), with its entry fill,
  // opened at rolledAt.
  const newPosition = await createPositionTx(
    tx,
    userId,
    {
      accountId: position.account_id as string,
      symbol: input.newSymbol,
      side: position.side as string,
      assetType: 'option',
    },
    groupId ?? undefined,
  );
  const entryFill = await addFillTx(tx, newPosition!.id, userId, {
    type: 'entry',
    price: input.openPrice,
    quantity: input.quantity,
    fees: input.openFees ?? '0',
    filledAt: input.rolledAt,
  });
  await openPositionTx(tx, newPosition!.id, userId, input.rolledAt);

  // 5. Link both legs. The chain id comes from any row already naming the
  // rolled leg, so a chained or partially-rolled leg extends its chain.
  const chainId = (await findChainIdForLeg(tx, legId)) ?? randomUUID();
  const [roll] = await insertPositionRoll(tx, {
    userId,
    chainId,
    fromPositionId: legId,
    toPositionId: newPosition!.id,
    exitFillId: exitFill.id as string,
    entryFillId: entryFill.id as string,
    rolledAt,
  });

  return {
    rollId: roll!.id,
    chainId: roll!.chainId,
    fromPositionId: legId,
    toPositionId: newPosition!.id,
    newSymbol: input.newSymbol,
  };
}

/**
 * Owns the transaction and emits `position_rolled` after commit — enum
 * properties only (AC 11.7): no symbol, no roll/chain/position id.
 */
export async function rollLeg(
  db: Database,
  userId: string,
  legId: string,
  input: RollLegInput,
  gate: { isAdmin: boolean },
): Promise<RollResult> {
  const result = await withTransaction(db, (tx) => rollLegTx(tx, userId, legId, input, gate));

  try {
    captureServerEvent('position_rolled', {
      distinctId: userId,
      properties: { assetType: 'option' },
    });
  } catch {
    // ignore — capture is fire-and-forget
  }

  return result;
}

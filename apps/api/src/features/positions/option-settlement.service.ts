import Decimal from 'decimal.js';

import { expiryInstant, parseOccSymbol } from '@tradr/shared';

import type { Database, Transaction } from '@/db';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { captureServerEvent } from '@/lib/posthog';
import { withTransaction } from '@/lib/transaction';

import {
  insertOptionSettlement,
  insertOptionSettlementFills,
  insertOptionSettlementRows,
} from './option-settlement.query';
import { aggregateFills } from './pnl';
import { lockLegs } from './position-groups.query';
import { findFillsByPosition, sumFillQuantityByType } from './positions.query';
import { addFillTx, closeIfBalancedTx } from './positions.service';

export type SettlementOutcome = 'worthless' | 'assigned' | 'exercised';

export interface SettleLegInput {
  outcome: SettlementOutcome;
  settledAt?: string;
  quantity?: string;
  fees?: string;
  stockRowOrder?: string[];
}

export interface SettlementResult {
  settlementId: string;
  legId: string;
  outcome: SettlementOutcome;
  premium: string;
  quantity: string;
  settledAt: string;
  openedPositionIds: string[];
  exitedPositionIds: string[];
}

const LEGAL_OUTCOMES_BY_SIDE: Record<string, SettlementOutcome[]> = {
  short: ['worthless', 'assigned'],
  long: ['worthless', 'exercised'],
};

/**
 * Settlement core (design C3). Runs the 8 post-conditions in order inside the
 * caller's transaction. Only the `worthless` outcome is built out end to end
 * here — the stock-side table (post-condition 6) for `assigned`/`exercised`
 * is a bridge that throws until task 8 implements it, so every earlier and
 * later step already runs generically for all three outcomes.
 */
export async function settleLegTx(
  tx: Transaction,
  userId: string,
  legId: string,
  input: SettleLegInput,
  now: Date = new Date(),
): Promise<SettlementResult> {
  // 1. Lock the leg (the only row in the union for a non-stock outcome).
  const lockedRows = await lockLegs(tx, userId, [legId]);
  const position = lockedRows[0];
  if (!position) {
    throw new NotFoundError('Position', legId);
  }

  // 2. Validate under the lock.
  if (position.asset_type !== 'option') {
    throw new ValidationError('Settlement only applies to an option leg');
  }
  const legalOutcomes = LEGAL_OUTCOMES_BY_SIDE[position.side as string] ?? [];
  if (!legalOutcomes.includes(input.outcome)) {
    throw new ValidationError(`A ${position.side} leg does not accept outcome "${input.outcome}"`);
  }

  const parsed = parseOccSymbol(position.symbol);
  if (!parsed.ok) {
    throw new ConflictError(parsed.error.message);
  }

  const [{ total: entryTotal }] = await sumFillQuantityByType(tx, legId, 'entry');
  const [{ total: exitTotal }] = await sumFillQuantityByType(tx, legId, 'exit');
  const openUnits = new Decimal(entryTotal).minus(exitTotal);
  if (position.status !== 'open' || openUnits.lte(0)) {
    throw new ConflictError('This leg has no open units to settle');
  }

  const expiry = expiryInstant(parsed.value.expiration);

  if (input.outcome === 'worthless') {
    if (input.settledAt !== undefined) {
      throw new ValidationError('A worthless settlement does not take a settledAt');
    }
    if (input.quantity !== undefined) {
      throw new ValidationError('A worthless settlement does not take a quantity');
    }
    if (!(now.getTime() > expiry.getTime())) {
      throw new ValidationError('A leg can be settled worthless only after its expiry instant');
    }
  }

  // 3. Premium: entry cost over entry quantity.
  const legFills = await findFillsByPosition(tx, legId);
  const totals = aggregateFills(
    legFills.map((f) => ({ type: f.type, price: f.price, quantity: f.quantity, fees: f.fees })),
  );
  const premium = new Decimal(totals.entryCost).div(totals.entryQty).toFixed(8);

  // 4. Snapshot the latch pair and the pre-existing fill ids before any write.
  const priorLastFlatAt = position.last_flat_at ? new Date(position.last_flat_at) : null;
  const priorLastFlatNetPnl: string | null = position.last_flat_net_pnl ?? null;
  const baselineFillIds = legFills.map((f) => f.id);

  // 5. Leg exit: price 0 for worthless, otherwise the premium.
  const settledAtDate = input.outcome === 'worthless' ? expiry : now;
  const exitPrice = input.outcome === 'worthless' ? '0' : premium;
  const exitFill = await addFillTx(tx, legId, userId, {
    type: 'exit',
    price: exitPrice,
    quantity: openUnits.toString(),
    fees: input.fees ?? '0',
    filledAt: settledAtDate.toISOString(),
  });

  // 6. Stock side (design C3 table) — bridge: task 8 replaces this with the
  // real assigned/exercised stock effects.
  if (input.outcome !== 'worthless') {
    throw new ValidationError('Assigned/exercised settlement is not yet supported');
  }

  // 7. Close the leg if its exit now balances it.
  const closedLeg = await closeIfBalancedTx(tx, legId, userId, settledAtDate.toISOString(), {
    fillJustWritten: true,
  });

  // 8. Record the settlement.
  const quantityStr = openUnits.toFixed(8);
  const [settlement] = await insertOptionSettlement(tx, {
    userId,
    positionId: legId,
    outcome: input.outcome,
    quantity: quantityStr,
    premium,
    settledAt: settledAtDate,
  });

  await insertOptionSettlementRows(tx, [
    {
      settlementId: settlement!.id,
      positionId: legId,
      touch: 'leg',
      closedRow: closedLeg !== null,
      priorLastFlatAt,
      priorLastFlatNetPnl,
    },
  ]);

  await insertOptionSettlementFills(tx, [
    ...baselineFillIds.map((fillId) => ({
      settlementId: settlement!.id,
      fillId,
      written: false,
    })),
    { settlementId: settlement!.id, fillId: exitFill.id as string, written: true },
  ]);

  return {
    settlementId: settlement!.id,
    legId,
    outcome: input.outcome,
    premium,
    quantity: quantityStr,
    settledAt: settledAtDate.toISOString(),
    openedPositionIds: [],
    exitedPositionIds: [],
  };
}

/**
 * Owns the transaction and emits `position_settled` (outcome, source; enums
 * only) after commit — the same try/catch-wrapped, fire-and-forget pattern
 * `addFill`/`closePosition` use for their business events.
 */
export async function settleLeg(
  db: Database,
  userId: string,
  legId: string,
  input: SettleLegInput,
): Promise<SettlementResult> {
  const result = await withTransaction(db, (tx) => settleLegTx(tx, userId, legId, input));

  try {
    captureServerEvent('position_settled', {
      distinctId: userId,
      properties: { outcome: result.outcome, source: 'manual' },
    });
  } catch {
    // ignore — capture is fire-and-forget
  }

  return result;
}

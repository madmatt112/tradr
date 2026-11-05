import Decimal from 'decimal.js';

import { expiryInstant, parseOccSymbol } from '@tradr/shared';

import type { Database, Transaction } from '@/db';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { captureServerEvent } from '@/lib/posthog';
import { withTransaction } from '@/lib/transaction';

import {
  deleteOptionSettlement,
  findCandidateStockRows,
  findFillsByIds,
  findOptionSettlementByLeg,
  findOptionSettlementFills,
  findOptionSettlementRows,
  insertOptionSettlement,
  insertOptionSettlementFills,
  insertOptionSettlementRows,
} from './option-settlement.query';
import { aggregateFills } from './pnl';
import { lockLegs } from './position-groups.query';
import {
  deletePosition,
  findFillsByPosition,
  findPositionById,
  sumFillQuantityByType,
  updatePosition,
} from './positions.query';
import {
  addFillTx,
  closeIfBalancedTx,
  createPositionTx,
  openPositionTx,
  removeRecordedFillTx,
} from './positions.service';
import { findTransferLinkByFillId } from './transfer-links.query';

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

interface SettlementRowInsert {
  positionId: string;
  touch: 'stock_exit' | 'stock_opened';
  closedRow: boolean;
  priorLastFlatAt: Date | null;
  priorLastFlatNetPnl: string | null;
}

/**
 * Settlement core (design C3). Runs the 8 post-conditions in order inside the
 * caller's transaction, for all three outcomes.
 */
export async function settleLegTx(
  tx: Transaction,
  userId: string,
  legId: string,
  input: SettleLegInput,
  now: Date = new Date(),
): Promise<SettlementResult> {
  const isStockSideOutcome = input.outcome !== 'worthless';

  // 1a. Unlocked pre-read of the candidate stock rows for a stock-side
  // outcome (design C3 post-condition 1), before any lock. A leg that turns
  // out not to be an eligible option leaves this empty; the real refusal
  // comes from validation under the lock below.
  let preUnderlying: string | null = null;
  let candidateIdsBefore: string[] = [];
  if (isStockSideOutcome) {
    const preRows = await findPositionById(tx, legId, userId);
    const preLeg = preRows[0];
    if (preLeg && preLeg.assetType === 'option') {
      const preParsed = parseOccSymbol(preLeg.symbol);
      if (preParsed.ok) {
        preUnderlying = preParsed.value.underlying;
        const candidates = await findCandidateStockRows(
          tx,
          userId,
          preLeg.accountId,
          preUnderlying,
        );
        candidateIdsBefore = candidates.map((c) => c.id);
      }
    }
  }

  // 1b. Lock the union, ascending (lockLegs' own ordering keeps this safe
  // against a concurrent closeGroup, design D4).
  const lockedRows = await lockLegs(tx, userId, [legId, ...candidateIdsBefore]);
  const position = lockedRows.find((r) => r.id === legId);
  if (!position) {
    throw new NotFoundError('Position', legId);
  }
  const lockedCandidatesById = new Map(
    lockedRows.filter((r) => r.id !== legId).map((r) => [r.id as string, r]),
  );

  // 1c. Re-read the candidates under the lock; a changed set is a conflict.
  let candidatesAfterLock: Array<{ id: string; openedAt: Date; openUnits: string }> = [];
  if (candidateIdsBefore.length > 0 && preUnderlying) {
    candidatesAfterLock = await findCandidateStockRows(
      tx,
      userId,
      position.account_id as string,
      preUnderlying,
    );
    const afterIds = new Set(candidatesAfterLock.map((c) => c.id));
    const changed =
      afterIds.size !== candidateIdsBefore.length ||
      candidateIdsBefore.some((id) => !afterIds.has(id));
    if (changed) {
      throw new ConflictError('The holdings changed; try again');
    }
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

  let settledAtDate: Date;
  let settleQty: Decimal;
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
    settledAtDate = expiry;
    settleQty = openUnits;
  } else {
    settleQty = input.quantity !== undefined ? new Decimal(input.quantity) : openUnits;
    if (input.settledAt !== undefined) {
      const explicit = new Date(input.settledAt);
      const openedAt = position.opened_at ? new Date(position.opened_at) : null;
      if (openedAt && explicit.getTime() < openedAt.getTime()) {
        throw new ValidationError("settledAt cannot precede the leg's own openedAt");
      }
      if (explicit.getTime() > now.getTime()) {
        throw new ValidationError('settledAt cannot be in the future');
      }
      settledAtDate = explicit;
    } else if (expiry.getTime() > now.getTime()) {
      // Design D6: refuse only an explicit earlier date, so a defaulted
      // instant still ahead of now has no date to default to.
      throw new ValidationError('Provide a settledAt date to settle before expiry');
    } else {
      settledAtDate = expiry;
    }
  }

  // 3. Premium: entry cost over entry quantity.
  const legFills = await findFillsByPosition(tx, legId);
  const totals = aggregateFills(
    legFills.map((f) => ({ type: f.type, price: f.price, quantity: f.quantity, fees: f.fees })),
  );
  const premiumDecimal = new Decimal(totals.entryCost).div(totals.entryQty);
  const premium = premiumDecimal.toFixed(8);

  // Design C3 table: the adjusted price is the strike plus the premium for a
  // call (the holder pays strike, the premium already in pocket/paid offsets
  // it upward) and the strike minus the premium for a put (symmetric,
  // downward) — one formula for both the open-new-row and exit-held-row
  // cases, independent of side, since the leg's side only ever pairs with
  // one outcome (short->assigned, long->exercised) in `LEGAL_OUTCOMES_BY_SIDE`.
  let adjustedPrice: Decimal | null = null;
  if (input.outcome !== 'worthless') {
    const strike = new Decimal(parsed.value.strike);
    adjustedPrice =
      parsed.value.type === 'call' ? strike.plus(premiumDecimal) : strike.minus(premiumDecimal);
    if (adjustedPrice.lt(0)) {
      throw new ValidationError('The adjusted price cannot be negative');
    }
  }

  // 4. Snapshot the latch pair and the pre-existing fill ids before any write.
  const priorLastFlatAt = position.last_flat_at ? new Date(position.last_flat_at) : null;
  const priorLastFlatNetPnl: string | null = position.last_flat_net_pnl ?? null;
  const baselineFillIds = legFills.map((f) => f.id);

  // 5. Leg exit: price 0 for worthless, otherwise the premium. The fee lands
  // here only for worthless; otherwise it lands on the first stock-side fill.
  const exitPrice = input.outcome === 'worthless' ? '0' : premium;
  const legExitFees = input.outcome === 'worthless' ? (input.fees ?? '0') : '0';
  const exitFill = await addFillTx(tx, legId, userId, {
    type: 'exit',
    price: exitPrice,
    quantity: settleQty.toString(),
    fees: legExitFees,
    filledAt: settledAtDate.toISOString(),
  });

  // 6. Stock side, by design C3's table.
  const openedPositionIds: string[] = [];
  const exitedPositionIds: string[] = [];
  const extraSettlementRows: SettlementRowInsert[] = [];
  const extraWrittenFillIds: string[] = [];
  const extraBaselineFillIds: string[] = [];

  if (adjustedPrice) {
    const priceStr = adjustedPrice.toFixed(8);
    const shares = settleQty.times(100);
    const stockFeeInput = input.fees ?? '0';
    let feeUsed = false;
    const nextFee = () => {
      if (feeUsed) return '0';
      feeUsed = true;
      return stockFeeInput;
    };

    // short put/long call: the holder ends up long stock, a brand-new,
    // ungrouped row. short call/long put: existing long stock exits instead.
    const opensNewRow =
      (parsed.value.type === 'put' && position.side === 'short') ||
      (parsed.value.type === 'call' && position.side === 'long');

    if (opensNewRow) {
      const newRow = await createPositionTx(tx, userId, {
        accountId: position.account_id as string,
        symbol: parsed.value.underlying,
        side: 'long',
        assetType: 'stock',
      });
      const newFill = await addFillTx(tx, newRow!.id, userId, {
        type: 'entry',
        price: priceStr,
        quantity: shares.toString(),
        fees: nextFee(),
        filledAt: settledAtDate.toISOString(),
      });
      await openPositionTx(tx, newRow!.id, userId, settledAtDate.toISOString());
      openedPositionIds.push(newRow!.id);
      extraSettlementRows.push({
        positionId: newRow!.id,
        touch: 'stock_opened',
        closedRow: false,
        priorLastFlatAt: null,
        priorLastFlatNetPnl: null,
      });
      extraWrittenFillIds.push(newFill.id as string);
    } else {
      // Row order: stockRowOrder ids first, then the remaining candidates
      // oldest openedAt first (design "Row order"; Req 3.4, 3.5).
      let ordered: Array<{ id: string; openedAt: Date; openUnits: string }>;
      if (input.stockRowOrder) {
        const byId = new Map(candidatesAfterLock.map((c) => [c.id, c]));
        const named: Array<{ id: string; openedAt: Date; openUnits: string }> = [];
        for (const id of input.stockRowOrder) {
          const row = byId.get(id);
          if (!row) {
            throw new ValidationError(`stockRowOrder names an ineligible row: ${id}`);
          }
          named.push(row);
          byId.delete(id);
        }
        const remainingCandidates = [...byId.values()].sort(
          (a, b) => a.openedAt.getTime() - b.openedAt.getTime(),
        );
        ordered = [...named, ...remainingCandidates];
      } else {
        ordered = [...candidatesAfterLock].sort(
          (a, b) => a.openedAt.getTime() - b.openedAt.getTime(),
        );
      }

      let remainingShares = shares;
      for (const row of ordered) {
        if (remainingShares.lte(0)) break;
        const rowOpenUnits = new Decimal(row.openUnits);
        const exitQty = Decimal.min(rowOpenUnits, remainingShares);

        const rowBaselineFillIds = (await findFillsByPosition(tx, row.id)).map(
          (f) => f.id as string,
        );

        const stockExitFill = await addFillTx(tx, row.id, userId, {
          type: 'exit',
          price: priceStr,
          quantity: exitQty.toString(),
          fees: nextFee(),
          filledAt: settledAtDate.toISOString(),
        });

        const closedStockRow = await closeIfBalancedTx(
          tx,
          row.id,
          userId,
          settledAtDate.toISOString(),
          { fillJustWritten: true },
        );

        const lockedRow = lockedCandidatesById.get(row.id);
        extraSettlementRows.push({
          positionId: row.id,
          touch: 'stock_exit',
          closedRow: closedStockRow !== null,
          priorLastFlatAt: lockedRow?.last_flat_at
            ? new Date(lockedRow.last_flat_at as string)
            : null,
          priorLastFlatNetPnl: (lockedRow?.last_flat_net_pnl as string | null) ?? null,
        });
        extraWrittenFillIds.push(stockExitFill.id as string);
        extraBaselineFillIds.push(...rowBaselineFillIds);
        if (closedStockRow !== null) {
          exitedPositionIds.push(row.id);
        }

        remainingShares = remainingShares.minus(exitQty);
      }

      if (remainingShares.gt(0)) {
        const newRow = await createPositionTx(tx, userId, {
          accountId: position.account_id as string,
          symbol: parsed.value.underlying,
          side: 'short',
          assetType: 'stock',
        });
        const newFill = await addFillTx(tx, newRow!.id, userId, {
          type: 'entry',
          price: priceStr,
          quantity: remainingShares.toString(),
          fees: nextFee(),
          filledAt: settledAtDate.toISOString(),
        });
        await openPositionTx(tx, newRow!.id, userId, settledAtDate.toISOString());
        openedPositionIds.push(newRow!.id);
        extraSettlementRows.push({
          positionId: newRow!.id,
          touch: 'stock_opened',
          closedRow: false,
          priorLastFlatAt: null,
          priorLastFlatNetPnl: null,
        });
        extraWrittenFillIds.push(newFill.id as string);
      }
    }
  }

  // 7. Close the leg if its exit now balances it.
  const closedLeg = await closeIfBalancedTx(tx, legId, userId, settledAtDate.toISOString(), {
    fillJustWritten: true,
  });
  if (closedLeg !== null) {
    exitedPositionIds.push(legId);
  }

  // 8. Record the settlement.
  const quantityStr = settleQty.toString();
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
    ...extraSettlementRows.map((r) => ({ settlementId: settlement!.id, ...r })),
  ]);

  await insertOptionSettlementFills(tx, [
    ...baselineFillIds.map((fillId) => ({
      settlementId: settlement!.id,
      fillId,
      written: false,
    })),
    ...extraBaselineFillIds.map((fillId) => ({
      settlementId: settlement!.id,
      fillId,
      written: false,
    })),
    { settlementId: settlement!.id, fillId: exitFill.id as string, written: true },
    ...extraWrittenFillIds.map((fillId) => ({
      settlementId: settlement!.id,
      fillId,
      written: true,
    })),
  ]);

  return {
    settlementId: settlement!.id,
    legId,
    outcome: input.outcome,
    premium,
    quantity: quantityStr,
    settledAt: settledAtDate.toISOString(),
    openedPositionIds,
    exitedPositionIds,
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

/**
 * The exact undo (design C5 Unsettle). Every refusal is judged from the
 * settlement record alone (design C5 post-condition 3, Req 4.7) — never from
 * guessing at what "should" still be true.
 */
async function unsettleTx(
  tx: Transaction,
  userId: string,
  legId: string,
  settlementId: string,
): Promise<SettlementOutcome> {
  // 1. Load the settlement scoped by user and leg; a miss is 404.
  const [settlement] = await findOptionSettlementByLeg(tx, settlementId, legId, userId);
  if (!settlement) {
    throw new NotFoundError('Settlement', settlementId);
  }

  // 2. Lock the touched rows, then re-read the settlement — a double submit
  // (or a race) that deleted it between the two reads is also a 404.
  const rows = await findOptionSettlementRows(tx, settlementId);
  const rowPositionIds = [
    ...new Set(rows.map((r) => r.positionId).filter((id): id is string => id !== null)),
  ];
  const lockedRows = await lockLegs(tx, userId, rowPositionIds);
  const lockedById = new Map(lockedRows.map((r) => [r.id as string, r]));

  const [recheck] = await findOptionSettlementByLeg(tx, settlementId, legId, userId);
  if (!recheck) {
    throw new NotFoundError('Settlement', settlementId);
  }

  // 3. Refuse with the reason and no write, judged from the record alone.
  for (const row of rows) {
    if (row.positionId === null || !lockedById.has(row.positionId)) {
      throw new ConflictError('A touched position no longer exists; unsettle refused');
    }
  }

  const fillRows = await findOptionSettlementFills(tx, settlementId);
  const writtenFills = fillRows.filter((f) => f.written);
  if (writtenFills.some((f) => f.fillId === null)) {
    throw new ConflictError('A recorded fill no longer exists; unsettle refused');
  }

  const recordedFillIds = new Set(
    fillRows.map((f) => f.fillId).filter((id): id is string => id !== null),
  );
  for (const row of rows) {
    const currentFills = await findFillsByPosition(tx, row.positionId as string);
    if (currentFills.some((f) => !recordedFillIds.has(f.id as string))) {
      throw new ConflictError(
        'A touched position gained a fill since settlement; unsettle refused',
      );
    }
  }

  const writtenFillIds = writtenFills.map((f) => f.fillId as string);
  for (const fillId of writtenFillIds) {
    const links = await findTransferLinkByFillId(tx, fillId);
    if (links.length > 0) {
      throw new ConflictError('A recorded fill is linked to a transfer; unsettle refused');
    }
  }

  for (const row of rows) {
    if (row.touch === 'stock_opened') {
      const lockedRow = lockedById.get(row.positionId as string);
      if (lockedRow?.group_id) {
        throw new ConflictError('The opened position has joined a group; unsettle refused');
      }
    }
  }

  // 4. Flip rows the settlement closed back open, with no reverse hook.
  for (const row of rows) {
    if (row.closedRow) {
      await updatePosition(tx, row.positionId as string, userId, {
        status: 'open',
        closedAt: null,
      });
    }
  }

  // 5. Remove each written fill; the fill hook posts the correcting delta at
  // that fill's own filledAt — the settlement date.
  const writtenFillRecords = await findFillsByIds(tx, writtenFillIds);
  for (const fillRecord of writtenFillRecords) {
    await removeRecordedFillTx(tx, fillRecord.positionId, fillRecord, userId);
  }

  // 6. Delete every stock position the settlement opened — never
  // `removePosition`, whose reverse-hook loop would re-reverse a prior
  // partial exit's P&L (Req 4.3).
  for (const row of rows) {
    if (row.touch === 'stock_opened') {
      await deletePosition(tx, row.positionId as string, userId);
    }
  }

  // 7. Restore each surviving row's latch pair, then delete the settlement;
  // its rows and fills cascade with it.
  for (const row of rows) {
    if (row.touch === 'stock_opened') continue;
    await updatePosition(tx, row.positionId as string, userId, {
      lastFlatAt: row.priorLastFlatAt,
      lastFlatNetPnl: row.priorLastFlatNetPnl,
    });
  }
  await deleteOptionSettlement(tx, settlementId);

  return settlement.outcome as SettlementOutcome;
}

/**
 * Owns the transaction and emits `position_unsettled` (outcome; enum only)
 * after commit, the same fire-and-forget pattern as `settleLeg`.
 */
export async function unsettle(
  db: Database,
  userId: string,
  legId: string,
  settlementId: string,
): Promise<void> {
  const outcome = await withTransaction(db, (tx) => unsettleTx(tx, userId, legId, settlementId));

  try {
    captureServerEvent('position_unsettled', {
      distinctId: userId,
      properties: { outcome },
    });
  } catch {
    // ignore — capture is fire-and-forget
  }
}

import Decimal from 'decimal.js';

import { aggregateFills, computePnlFromTotals } from './pnl';

export interface LotFill {
  id: string;
  type: 'entry' | 'exit';
  price: string;
  quantity: string;
  fees: string;
  filledAt: Date;
  createdAt: Date;
}

export interface StoredSelection {
  exitFillId: string;
  entryFillId: string;
  quantity: string;
}

export interface LotSlice {
  exitFillId: string;
  entryFillId: string;
  quantity: Decimal;
}

export type LotConflict =
  | { kind: 'not_an_entry'; entryFillId: string }
  | { kind: 'over_claimed'; entryFillId: string; claimingExitFillIds: string[] }
  | { kind: 'sum_mismatch'; exitFillId: string }
  | { kind: 'unmatched'; exitFillId: string };

export type MatchResult = { ok: true; slices: LotSlice[] } | { ok: false; conflict: LotConflict };

export interface LotAvailability {
  entryFillId: string;
  available: Decimal;
}

export interface LotEndDate {
  entryFillId: string;
  endedAt: Date | null;
}

export interface LotRealisation {
  exitFillId: string;
  entryFillId: string;
  lotOpenedAt: Date;
  realisedAt: Date;
  quantity: Decimal;
  proceeds: Decimal;
  basis: Decimal;
  fees: Decimal;
  net: Decimal;
}

/**
 * Canonical fill order for lot matching: `filledAt`, then `createdAt`, then
 * `id` (design C4 / requirements AC 1.2, AC 3.1). Both entries (FIFO lot
 * order) and exits (match processing order) use this same ordering.
 */
export function orderFills<T extends { id: string; filledAt: Date; createdAt: Date }>(
  fills: readonly T[],
): T[] {
  return [...fills].sort((a, b) => {
    const byFilledAt = a.filledAt.getTime() - b.filledAt.getTime();
    if (byFilledAt !== 0) return byFilledAt;
    const byCreatedAt = a.createdAt.getTime() - b.createdAt.getTime();
    if (byCreatedAt !== 0) return byCreatedAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Matches each exit fill to one or more lots (one lot per entry fill, AC
 * 1.1). A selected exit takes exactly the quantities named in its stored
 * selection (AC 3.3); an unselected exit takes its quantity from the oldest
 * lots still available, splitting across lots as needed (AC 3.2), and never
 * dips into quantity reserved by ANY selection, regardless of match order
 * (AC 3.4) — reservations are computed up front, independent of processing
 * order.
 */
export function matchExitsToLots(fills: LotFill[], selections: StoredSelection[]): MatchResult {
  const ordered = orderFills(fills);
  const entries = ordered.filter((f) => f.type === 'entry');
  const exits = ordered.filter((f) => f.type === 'exit');
  const entryIds = new Set(entries.map((e) => e.id));
  const exitById = new Map(exits.map((e) => [e.id, e]));

  for (const selection of selections) {
    if (!entryIds.has(selection.entryFillId)) {
      return { ok: false, conflict: { kind: 'not_an_entry', entryFillId: selection.entryFillId } };
    }
  }

  // Reserved quantity per lot, and the exits that claim it — a selection is
  // a reservation regardless of whether its exit is processed before or
  // after an unselected one.
  const reservedByLot = new Map<string, Decimal>();
  const claimingExitsByLot = new Map<string, Set<string>>();
  for (const selection of selections) {
    const reserved = reservedByLot.get(selection.entryFillId) ?? new Decimal(0);
    reservedByLot.set(selection.entryFillId, reserved.plus(selection.quantity));
    const claimers = claimingExitsByLot.get(selection.entryFillId) ?? new Set<string>();
    claimers.add(selection.exitFillId);
    claimingExitsByLot.set(selection.entryFillId, claimers);
  }

  for (const entry of entries) {
    const reserved = reservedByLot.get(entry.id);
    if (reserved && reserved.greaterThan(entry.quantity)) {
      return {
        ok: false,
        conflict: {
          kind: 'over_claimed',
          entryFillId: entry.id,
          claimingExitFillIds: [...(claimingExitsByLot.get(entry.id) ?? [])],
        },
      };
    }
  }

  const selectionsByExit = new Map<string, StoredSelection[]>();
  for (const selection of selections) {
    const items = selectionsByExit.get(selection.exitFillId) ?? [];
    items.push(selection);
    selectionsByExit.set(selection.exitFillId, items);
  }
  for (const [exitFillId, items] of selectionsByExit) {
    const exit = exitById.get(exitFillId);
    if (!exit) continue;
    const sum = items.reduce((acc, item) => acc.plus(item.quantity), new Decimal(0));
    if (!sum.equals(exit.quantity)) {
      return { ok: false, conflict: { kind: 'sum_mismatch', exitFillId } };
    }
  }

  // Quantity each lot can still give a FIFO (unselected) exit: its own
  // quantity less everything reserved by stored selections.
  const availableForFifo = new Map<string, Decimal>(
    entries.map((entry) => [
      entry.id,
      new Decimal(entry.quantity).minus(reservedByLot.get(entry.id) ?? new Decimal(0)),
    ]),
  );

  const slices: LotSlice[] = [];

  for (const exit of exits) {
    const items = selectionsByExit.get(exit.id);
    if (items && items.length > 0) {
      for (const item of items) {
        slices.push({
          exitFillId: exit.id,
          entryFillId: item.entryFillId,
          quantity: new Decimal(item.quantity),
        });
      }
      continue;
    }

    let remaining = new Decimal(exit.quantity);
    for (const entry of entries) {
      if (remaining.isZero()) break;
      const available = availableForFifo.get(entry.id)!;
      if (available.lessThanOrEqualTo(0)) continue;
      const take = Decimal.min(available, remaining);
      slices.push({ exitFillId: exit.id, entryFillId: entry.id, quantity: take });
      availableForFifo.set(entry.id, available.minus(take));
      remaining = remaining.minus(take);
    }

    if (!remaining.isZero()) {
      return { ok: false, conflict: { kind: 'unmatched', exitFillId: exit.id } };
    }
  }

  return { ok: true, slices };
}

/**
 * Per-lot availability (design C7/D11): a lot's quantity less every slice of
 * every exit, except `excludeExitFillId`'s own slices — so an exit being
 * edited sees its own current reservation as available again.
 */
export function availableByLot(
  fills: LotFill[],
  slices: LotSlice[],
  excludeExitFillId?: string,
): LotAvailability[] {
  const entries = fills.filter((f) => f.type === 'entry');
  return entries.map((entry) => {
    const consumed = slices
      .filter((slice) => slice.entryFillId === entry.id && slice.exitFillId !== excludeExitFillId)
      .reduce((acc, slice) => acc.plus(slice.quantity), new Decimal(0));
    return { entryFillId: entry.id, available: new Decimal(entry.quantity).minus(consumed) };
  });
}

/**
 * Lot end date (design D9): under FIFO a lot ends at the latest `filledAt`
 * of the exits that consumed it, once their slices sum to its quantity,
 * else null (still open). Under average cost, lots are fungible until the
 * whole position goes flat, so every lot shares the position's last exit
 * date once total exit quantity equals total entry quantity, else null.
 */
export function lotEndDates(
  fills: LotFill[],
  slices: LotSlice[],
  method: 'fifo' | 'average',
): LotEndDate[] {
  const entries = fills.filter((f) => f.type === 'entry');

  if (method === 'average') {
    const totals = aggregateFills(fills);
    const flat =
      new Decimal(totals.entryQty).equals(totals.exitQty) && !new Decimal(totals.entryQty).isZero();
    const latestExitAt = flat ? latestFilledAt(fills.filter((f) => f.type === 'exit')) : null;
    return entries.map((entry) => ({ entryFillId: entry.id, endedAt: latestExitAt }));
  }

  const exitById = new Map(fills.filter((f) => f.type === 'exit').map((f) => [f.id, f]));
  return entries.map((entry) => {
    const consumingSlices = slices.filter((slice) => slice.entryFillId === entry.id);
    const consumedTotal = consumingSlices.reduce(
      (acc, slice) => acc.plus(slice.quantity),
      new Decimal(0),
    );
    if (!consumedTotal.equals(entry.quantity)) {
      return { entryFillId: entry.id, endedAt: null };
    }
    const consumingExits = consumingSlices.map((slice) => exitById.get(slice.exitFillId)!);
    return { entryFillId: entry.id, endedAt: latestFilledAt(consumingExits) };
  });
}

function latestFilledAt(fills: readonly { filledAt: Date }[]): Date | null {
  return fills.reduce<Date | null>(
    (latest, f) => (!latest || f.filledAt > latest ? f.filledAt : latest),
    null,
  );
}

/**
 * Per-slice realisation (design C4, requirements AC 5.2/5.3): for a slice of
 * quantity `q` against its lot,
 *   gross    = (exitPrice − lotPrice) × q × sideSign × contractMultiplier
 *   fees     = lotFees × q / lotQty + exitFees × q / exitQty    (pro-rated)
 *   proceeds = (long ? exitPrice : lotPrice) × q × contractMultiplier
 * Each is rounded once, `ROUND_HALF_UP`, to the currency's minor units (same
 * convention as `pnl.ts:119-121`); `net = gross − fees` and
 * `basis = proceeds − gross` are then exact at minor units (AC 5.3).
 *
 * When the position is fully flat (total exit quantity equals total entry
 * quantity), the sum of independently-rounded slices can miss
 * `computePnlFromTotals`'s pooled figure by a minor unit. The residue
 * (`computePnlFromTotals`'s gross/fees minus the slices' sums) is added to
 * the latest slice — exit order, then lot order — whose `net` and `basis`
 * are then re-derived, so the position total matches exactly (AC 5.4, same
 * convention as `pnl.ts:146-150`).
 */
export function computeLotRealisations(
  fills: LotFill[],
  slices: LotSlice[],
  side: 'long' | 'short',
  assetType: 'stock' | 'option',
  currencyMinorUnits: number,
): LotRealisation[] {
  const byId = new Map(fills.map((f) => [f.id, f]));
  const ordered = orderFills(fills);
  const exitOrder = new Map(ordered.filter((f) => f.type === 'exit').map((f, i) => [f.id, i]));
  const entryOrder = new Map(ordered.filter((f) => f.type === 'entry').map((f, i) => [f.id, i]));

  const sideSign = side === 'long' ? 1 : -1;
  const contractMultiplier = assetType === 'option' ? 100 : 1;

  const rows = slices.map((slice) => {
    const lot = byId.get(slice.entryFillId)!;
    const exit = byId.get(slice.exitFillId)!;
    const q = slice.quantity;
    const lotPrice = new Decimal(lot.price);
    const exitPrice = new Decimal(exit.price);

    const grossRaw = exitPrice.minus(lotPrice).times(q).times(sideSign).times(contractMultiplier);
    const feesRaw = new Decimal(lot.fees)
      .times(q)
      .div(lot.quantity)
      .plus(new Decimal(exit.fees).times(q).div(exit.quantity));
    const proceedsRaw = (side === 'long' ? exitPrice : lotPrice).times(q).times(contractMultiplier);

    const gross = grossRaw.toDecimalPlaces(currencyMinorUnits, Decimal.ROUND_HALF_UP);
    const fees = feesRaw.toDecimalPlaces(currencyMinorUnits, Decimal.ROUND_HALF_UP);
    const proceeds = proceedsRaw.toDecimalPlaces(currencyMinorUnits, Decimal.ROUND_HALF_UP);

    return {
      exitFillId: exit.id,
      entryFillId: lot.id,
      lotOpenedAt: lot.filledAt,
      realisedAt: exit.filledAt,
      quantity: q,
      gross,
      fees,
      proceeds,
    };
  });

  const totals = aggregateFills(fills);
  const fullyFlat =
    rows.length > 0 &&
    new Decimal(totals.entryQty).equals(totals.exitQty) &&
    !new Decimal(totals.entryQty).isZero();

  if (fullyFlat) {
    const pooled = computePnlFromTotals(totals, side, assetType, currencyMinorUnits);
    const sumGross = rows.reduce((acc, row) => acc.plus(row.gross), new Decimal(0));
    const sumFees = rows.reduce((acc, row) => acc.plus(row.fees), new Decimal(0));
    const residueGross = new Decimal(pooled.grossPnl ?? 0).minus(sumGross);
    const residueFees = new Decimal(pooled.fees ?? 0).minus(sumFees);

    let latestIndex = 0;
    for (let i = 1; i < rows.length; i++) {
      if (isLaterSlice(rows[i]!, rows[latestIndex]!, exitOrder, entryOrder)) {
        latestIndex = i;
      }
    }
    const latest = rows[latestIndex]!;
    latest.gross = latest.gross.plus(residueGross);
    latest.fees = latest.fees.plus(residueFees);
  }

  return rows.map((row) => ({
    exitFillId: row.exitFillId,
    entryFillId: row.entryFillId,
    lotOpenedAt: row.lotOpenedAt,
    realisedAt: row.realisedAt,
    quantity: row.quantity,
    proceeds: row.proceeds,
    basis: row.proceeds.minus(row.gross),
    fees: row.fees,
    net: row.gross.minus(row.fees),
  }));
}

function isLaterSlice(
  a: { exitFillId: string; entryFillId: string },
  b: { exitFillId: string; entryFillId: string },
  exitOrder: Map<string, number>,
  entryOrder: Map<string, number>,
): boolean {
  const exitDelta = exitOrder.get(a.exitFillId)! - exitOrder.get(b.exitFillId)!;
  if (exitDelta !== 0) return exitDelta > 0;
  return entryOrder.get(a.entryFillId)! - entryOrder.get(b.entryFillId)! > 0;
}

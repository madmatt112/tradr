import type Decimal from 'decimal.js';

import { getCurrencyMinorUnits } from '@tradr/shared/constants/currencies';

import type { Database, Transaction } from '@/db';
import { computeLotRealisations, lotEndDates, matchExitsToLots } from '@/features/positions/lots';
import type { LotFill, LotSlice, StoredSelection } from '@/features/positions/lots';
import { logger } from '@/lib/logger';

import {
  listCandidateLotPositions,
  listFillsForPositions,
  listLotSelectionsForPositions,
  listPositionsWithExitInYear,
} from './expenses.query';
import type { LotYearSelectionRow } from './expenses.query';
import type { CandidateLot } from './expenses.tax';

export type LotRealisationForYear = {
  exitFillId: string;
  entryFillId: string;
  positionId: string;
  accountId: string;
  symbol: string;
  currency: string;
  lotOpenedAt: Date;
  realisedAt: Date;
  quantity: Decimal;
  proceeds: Decimal;
  basis: Decimal;
  fees: Decimal;
  net: Decimal;
  /** Position-level fields the wash-sale `LossUnit` shape still carries
   * alongside the lot-level `entryFillId`/`lotOpenedAt` (design C9). Not part
   * of the `lotRealisations` wire response. */
  assetType: 'stock' | 'option';
  side: 'long' | 'short';
  positionOpenedAt: Date;
  positionClosedAt: Date | null;
};

/**
 * FIFO lot realisations for a tax year (design C8). Batches one fills query
 * and one selections query for every position with an exit in the year (NFR
 * Performance) rather than one per position. Per position: match its lots;
 * on a conflict, log `tax_lot_selection_invalid` and match again with no
 * selections (design D8, NFR Reliability — a read must not fail). Slices are
 * derived over the position's whole life, then only those whose exit lands
 * in the UTC calendar year are kept (AC 5.5) — a position can have exits in
 * other years too.
 */
export async function getLotRealisationsForYear(
  db: Database | Transaction,
  userId: string,
  year: number,
): Promise<LotRealisationForYear[]> {
  const positionRows = await listPositionsWithExitInYear(db, userId, year);
  if (positionRows.length === 0) return [];

  const positionIds = positionRows.map((p) => p.positionId);
  const [fillRows, selectionRows] = await Promise.all([
    listFillsForPositions(db, userId, positionIds),
    listLotSelectionsForPositions(db, userId, positionIds),
  ]);

  const fillsByPosition = new Map<string, LotFill[]>();
  for (const row of fillRows) {
    const list = fillsByPosition.get(row.positionId) ?? [];
    list.push({
      id: row.id,
      type: row.type,
      price: row.price,
      quantity: row.quantity,
      fees: row.fees,
      filledAt: row.filledAt,
      createdAt: row.createdAt,
    });
    fillsByPosition.set(row.positionId, list);
  }

  const selectionsByPosition = new Map<string, StoredSelection[]>();
  for (const row of selectionRows) {
    const list = selectionsByPosition.get(row.positionId) ?? [];
    list.push({
      exitFillId: row.exitFillId,
      entryFillId: row.entryFillId,
      quantity: row.quantity,
    });
    selectionsByPosition.set(row.positionId, list);
  }

  const windowStart = new Date(`${year}-01-01T00:00:00Z`).getTime();
  const windowEnd = new Date(`${year + 1}-01-01T00:00:00Z`).getTime();

  const rows: LotRealisationForYear[] = [];

  for (const position of positionRows) {
    const fills = fillsByPosition.get(position.positionId) ?? [];
    const selections = selectionsByPosition.get(position.positionId) ?? [];

    let slices: LotSlice[];
    const matched = matchExitsToLots(fills, selections);
    if (matched.ok) {
      slices = matched.slices;
    } else {
      logger.warn('tax_lot_selection_invalid', {
        event: 'tax_lot_selection_invalid',
        positionId: position.positionId,
        conflict: matched.conflict,
      });
      const fallback = matchExitsToLots(fills, []);
      slices = fallback.ok ? fallback.slices : [];
    }

    const currencyMinorUnits = getCurrencyMinorUnits(position.currency);
    const realisations = computeLotRealisations(
      fills,
      slices,
      position.side,
      position.assetType,
      currencyMinorUnits,
    );

    for (const r of realisations) {
      const realisedAtMs = r.realisedAt.getTime();
      if (realisedAtMs < windowStart || realisedAtMs >= windowEnd) continue;
      rows.push({
        exitFillId: r.exitFillId,
        entryFillId: r.entryFillId,
        positionId: position.positionId,
        accountId: position.accountId,
        symbol: position.symbol,
        currency: position.currency,
        lotOpenedAt: r.lotOpenedAt,
        realisedAt: r.realisedAt,
        quantity: r.quantity,
        proceeds: r.proceeds,
        basis: r.basis,
        fees: r.fees,
        net: r.net,
        assetType: position.assetType,
        side: position.side,
        positionOpenedAt: position.openedAt,
        positionClosedAt: position.closedAt,
      });
    }
  }

  return rows;
}

/**
 * Candidate lots for the wash-sale / superficial-loss window (design C8,
 * C9). One `CandidateLot` per entry fill, each entry fill a lot — the same
 * fills (+ selections, under `fifo`) fetch pattern as
 * `getLotRealisationsForYear`, but emitting `lotEndDates` per lot rather than
 * a realisation. Under `average` cost `lotEndDates` ignores `slices`
 * entirely (D9), so selections are not fetched.
 */
export async function getCandidateLots(
  db: Database | Transaction,
  userId: string,
  window: { start: Date; end: Date },
  method: 'fifo' | 'average',
): Promise<CandidateLot[]> {
  const positionRows = await listCandidateLotPositions(db, userId, window);
  if (positionRows.length === 0) return [];

  const positionIds = positionRows.map((p) => p.positionId);
  const [fillRows, selectionRows] = await Promise.all([
    listFillsForPositions(db, userId, positionIds),
    method === 'fifo'
      ? listLotSelectionsForPositions(db, userId, positionIds)
      : Promise.resolve<LotYearSelectionRow[]>([]),
  ]);

  const fillsByPosition = new Map<string, LotFill[]>();
  for (const row of fillRows) {
    const list = fillsByPosition.get(row.positionId) ?? [];
    list.push({
      id: row.id,
      type: row.type,
      price: row.price,
      quantity: row.quantity,
      fees: row.fees,
      filledAt: row.filledAt,
      createdAt: row.createdAt,
    });
    fillsByPosition.set(row.positionId, list);
  }

  const selectionsByPosition = new Map<string, StoredSelection[]>();
  for (const row of selectionRows) {
    const list = selectionsByPosition.get(row.positionId) ?? [];
    list.push({
      exitFillId: row.exitFillId,
      entryFillId: row.entryFillId,
      quantity: row.quantity,
    });
    selectionsByPosition.set(row.positionId, list);
  }

  const candidates: CandidateLot[] = [];

  for (const position of positionRows) {
    const fills = fillsByPosition.get(position.positionId) ?? [];

    let slices: LotSlice[] = [];
    if (method === 'fifo') {
      const selections = selectionsByPosition.get(position.positionId) ?? [];
      const matched = matchExitsToLots(fills, selections);
      if (matched.ok) {
        slices = matched.slices;
      } else {
        logger.warn('tax_lot_selection_invalid', {
          event: 'tax_lot_selection_invalid',
          positionId: position.positionId,
          conflict: matched.conflict,
        });
        const fallback = matchExitsToLots(fills, []);
        slices = fallback.ok ? fallback.slices : [];
      }
    }

    const endedAtByEntry = new Map(
      lotEndDates(fills, slices, method).map((e) => [e.entryFillId, e.endedAt]),
    );

    for (const entry of fills.filter((f) => f.type === 'entry')) {
      candidates.push({
        entryFillId: entry.id,
        positionId: position.positionId,
        symbol: position.symbol,
        assetType: position.assetType,
        side: position.side,
        accountId: position.accountId,
        openedAt: entry.filledAt,
        endedAt: endedAtByEntry.get(entry.id) ?? null,
      });
    }
  }

  return candidates;
}

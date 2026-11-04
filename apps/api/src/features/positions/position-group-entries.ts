import Decimal from 'decimal.js';

import { getCurrencyMinorUnits, type Tag } from '@tradr/shared';
import { classifyPosition } from '@tradr/shared/lib/performance';
import {
  computeMaxLoss,
  computeNetEntry,
  detectStrategyLabel,
  legUnderlying,
  type StrategyLeg,
} from '@tradr/shared/lib/strategy';

import { computeOpenCostBasis, computePnlFromTotals } from './pnl';
import type { FillTotals } from './pnl';
import { computeRiskReward } from './risk-reward';

// A raw row is whatever `findPositionListByUser`'s SQL (or a hand-built test
// fixture shaped like it) hands over — untyped at the boundary, same as
// `positions.service.ts`'s own `RawRow`. `tags` is deliberately left out of
// the intersection (rather than typed `Tag[] | null`, as the service's
// version does) so a looser test-fixture tag shape still satisfies it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawRow = Record<string, any>;

export interface ListFilters {
  status?: string;
  accountId?: string;
  tag?: string[];
  classification?: string;
}

/**
 * Maps one raw `findPositionListByUser` row to a `PositionListItem` (moved
 * unchanged from `listPositions`, design C6). Also the per-leg mapping a
 * group's `legs` array uses, so an ungrouped item and a group's leg are built
 * by the exact same function.
 */
export function mapListRow(row: RawRow) {
  const totals: FillTotals = {
    entryQty: String(row.entry_qty),
    exitQty: String(row.exit_qty),
    entryCost: String(row.entry_cost),
    exitCost: String(row.exit_cost),
    entryFees: String(row.entry_fees),
    exitFees: String(row.exit_fees),
  };

  const currencyMinorUnits = getCurrencyMinorUnits(row.account_currency);
  const pnl = computePnlFromTotals(
    totals,
    row.side as 'long' | 'short',
    row.asset_type as 'stock' | 'option',
    currencyMinorUnits,
  );

  const brokerageName: string | null = row.brokerage_name ?? null;

  // Net realized P&L is `computePnlFromTotals`, full stop — see the comment at
  // the original call site (positions.service.ts) for why the brokerage fee
  // schedule is never re-applied here.
  const netPnl = pnl.realizedPnl;
  const grossPnl = pnl.grossPnl;
  const brokerageFees = pnl.fees ?? 0;

  // Winning/losing/breakeven from the SAME formula the performance endpoint
  // uses (classifyPosition rounds to currency minor units, then compares to
  // zero — R9/R10). Only a closed row with a computed net P&L carries one.
  const classification =
    row.status === 'closed' && netPnl !== null
      ? classifyPosition(new Decimal(netPnl), row.account_currency)
      : null;

  const targetPriceRaw: string | null = row.target_price ?? null;
  const stopLossRaw: string | null = row.stop_loss ?? null;
  const { targetRR, actualRR } = computeRiskReward({
    avgEntryPrice: pnl.avgEntryPrice,
    avgExitPrice: pnl.avgExitPrice,
    side: row.side as 'long' | 'short',
    targetPrice: targetPriceRaw,
    stopLoss: stopLossRaw,
  });

  return {
    id: row.id,
    userId: row.user_id,
    accountId: row.account_id,
    symbol: row.symbol,
    side: row.side,
    assetType: row.asset_type,
    status: row.status,
    notes: row.notes,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accountName: row.account_name,
    accountCurrency: row.account_currency,
    accountTimezone: row.account_timezone,
    // Tags ordered category-then-name by the LATERAL's `array_position`; `[]`
    // when the position carries none (design decision 7: tags never touch
    // `updated_at`, so they ride the read paths only).
    tags: row.tags ?? [],
    classification,
    ...pnl,
    brokerageName,
    grossPnl,
    brokerageFees,
    netPnl,
    targetPrice: targetPriceRaw === null ? null : new Decimal(targetPriceRaw).toNumber(),
    stopLoss: stopLossRaw === null ? null : new Decimal(stopLossRaw).toNumber(),
    targetRR,
    actualRR,
    openUnits: pnl.totalEntryQuantity - pnl.totalExitQuantity,
    closedUnits: pnl.totalExitQuantity,
    openCostBasis: computeOpenCostBasis(
      totals,
      row.side as 'long' | 'short',
      row.asset_type as 'stock' | 'option',
      currencyMinorUnits,
    ),
  };
}

export type PositionListItemRow = ReturnType<typeof mapListRow>;

export interface PositionGroupEntryRow {
  kind: 'group';
  id: string;
  userId: string;
  accountId: string;
  accountName: string;
  accountCurrency: string;
  accountTimezone: string;
  underlying: string;
  label: string;
  detectedLabel: string;
  labelOverride: string | null;
  status: 'open' | 'closed';
  openedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  tags: Tag[];
  classification: string | null;
  netEntry: number;
  grossPnl: number | null;
  netPnl: number | null;
  brokerageFees: number;
  openCostBasis: number;
  maxLoss: number | null;
  maxLossReason: string | null;
  legs: (PositionListItemRow & { groupId: string })[];
}

function toStrategyLeg(row: RawRow): StrategyLeg {
  return {
    symbol: row.symbol,
    side: row.side as 'long' | 'short',
    assetType: row.asset_type as 'stock' | 'option',
    entryQty: String(row.entry_qty),
    exitQty: String(row.exit_qty),
    entryCost: String(row.entry_cost),
    entryFees: String(row.entry_fees),
  };
}

function earliest(dates: (Date | null | undefined)[]): Date | null {
  let min: Date | null = null;
  for (const d of dates) {
    if (d && (min === null || d < min)) min = d;
  }
  return min;
}

function latest(dates: (Date | null | undefined)[]): Date | null {
  let max: Date | null = null;
  for (const d of dates) {
    if (d && (max === null || d > max)) max = d;
  }
  return max;
}

function dedupeTags(legRows: RawRow[]): Tag[] {
  const byId = new Map<string, Tag>();
  for (const leg of legRows) {
    for (const tag of leg.tags ?? []) {
      byId.set(tag.id, tag);
    }
  }
  return [...byId.values()];
}

/**
 * Assembles one group's legs into a `PositionGroupEntry` (design C6, Data
 * Models): status, timestamps, label and figures are all derived from the
 * legs — the group itself stores only the link and an optional label
 * override. Exported (not just used by `assembleListEntries`) so a single-
 * group read can reuse it without duplicating the derivation.
 */
export function buildGroupEntry(groupId: string, legRows: RawRow[]): PositionGroupEntryRow {
  const first = legRows[0] as RawRow;
  const currencyMinorUnits = getCurrencyMinorUnits(first.account_currency);

  const status: 'open' | 'closed' = legRows.every((l) => l.status === 'closed') ? 'closed' : 'open';

  const openedAt = earliest(legRows.map((l) => l.opened_at));
  const createdAt = earliest(legRows.map((l) => l.created_at)) as Date;
  const updatedAt = latest(legRows.map((l) => l.updated_at)) as Date;
  const closedAt = status === 'closed' ? latest(legRows.map((l) => l.closed_at)) : null;

  const strategyLegs = legRows.map(toStrategyLeg);
  const detectedLabel = detectStrategyLabel(strategyLegs);
  const labelOverride: string | null = first.label_override ?? null;
  const label = labelOverride ?? detectedLabel;

  const underlying = legUnderlying(strategyLegs[0]!) ?? strategyLegs[0]!.symbol;

  const netEntry = computeNetEntry(strategyLegs, currencyMinorUnits);
  const { maxLoss, maxLossReason } = computeMaxLoss(strategyLegs, currencyMinorUnits);

  // Gross/net P&L, fees and open cost basis are each leg's own
  // `computePnlFromTotals`/`computeOpenCostBasis` figure (task 2 functions),
  // summed over the group — AC 3.1, 3.3. A leg with no exit contributes 0 to
  // the sum, EXCEPT gross/net P&L stay null while no leg in the group has one
  // (AC 3.1's "null while no leg has an exit").
  let anyExit = false;
  let grossTotal = new Decimal(0);
  let netTotal = new Decimal(0);
  let feesTotal = new Decimal(0);
  let openCostTotal = new Decimal(0);

  for (const leg of legRows) {
    const totals: FillTotals = {
      entryQty: String(leg.entry_qty),
      exitQty: String(leg.exit_qty),
      entryCost: String(leg.entry_cost),
      exitCost: String(leg.exit_cost),
      entryFees: String(leg.entry_fees),
      exitFees: String(leg.exit_fees),
    };
    const legSide = leg.side as 'long' | 'short';
    const legAssetType = leg.asset_type as 'stock' | 'option';
    const legPnl = computePnlFromTotals(totals, legSide, legAssetType, currencyMinorUnits);

    if (legPnl.realizedPnl !== null) {
      anyExit = true;
      grossTotal = grossTotal.plus(legPnl.grossPnl ?? 0);
      netTotal = netTotal.plus(legPnl.realizedPnl);
    }
    feesTotal = feesTotal.plus(legPnl.fees ?? 0);
    openCostTotal = openCostTotal.plus(
      computeOpenCostBasis(totals, legSide, legAssetType, currencyMinorUnits),
    );
  }

  const round = (value: Decimal) =>
    value.toDecimalPlaces(currencyMinorUnits, Decimal.ROUND_HALF_UP).toNumber();

  const grossPnl = anyExit ? round(grossTotal) : null;
  const netPnl = anyExit ? round(netTotal) : null;
  const brokerageFees = round(feesTotal);
  const openCostBasis = round(openCostTotal);

  // Same classification formula as a position (classifyPosition, R9/R10);
  // closed groups only (AC 6.2) — null otherwise.
  const classification =
    status === 'closed' && netPnl !== null
      ? classifyPosition(new Decimal(netPnl), first.account_currency)
      : null;

  const legs = legRows.map((row) => ({ ...mapListRow(row), groupId }));

  return {
    kind: 'group',
    id: groupId,
    userId: first.user_id,
    accountId: first.account_id,
    accountName: first.account_name,
    accountCurrency: first.account_currency,
    accountTimezone: first.account_timezone,
    underlying,
    label,
    detectedLabel,
    labelOverride,
    status,
    openedAt,
    closedAt,
    createdAt,
    updatedAt,
    tags: dedupeTags(legRows),
    classification,
    netEntry,
    grossPnl,
    netPnl,
    brokerageFees,
    openCostBasis,
    maxLoss,
    maxLossReason,
    legs,
  };
}

function matchesFilters(
  entry: PositionListItemRow | PositionGroupEntryRow,
  filters: ListFilters,
): boolean {
  if (filters.status && entry.status !== filters.status) return false;
  if (filters.classification && entry.classification !== filters.classification) return false;
  if (filters.tag?.length) {
    const tagIds = new Set((entry.tags ?? []).map((t: { id: string }) => t.id));
    if (!filters.tag.every((id) => tagIds.has(id))) return false;
  }
  return true;
}

/**
 * Collapses `findPositionListByUser`'s rows into one entry per group (design
 * C6, NFR Performance — no per-group query). An ungrouped row keeps
 * `PositionListItem`'s shape unchanged (AC 6.1); a group's legs collapse into
 * one `PositionGroupEntry`, placed at the index of the first row (by the
 * query's `updated_at DESC` order) carrying that `group_id` — its
 * latest-updated leg.
 *
 * `findPositionListByUser`'s own `status`/`classification`/`tag` predicates
 * only narrow ungrouped rows, so every leg of a matching group always
 * arrives here regardless of filter — the filters are re-applied below
 * against each entry's OWN derived fields (AC 6.2), uniformly for both an
 * ungrouped item and a group.
 */
export function assembleListEntries(
  rows: RawRow[],
  filters: ListFilters,
): (PositionListItemRow | PositionGroupEntryRow)[] {
  const legsByGroup = new Map<string, RawRow[]>();
  for (const row of rows) {
    if (row.group_id) {
      const legs = legsByGroup.get(row.group_id) ?? [];
      legs.push(row);
      legsByGroup.set(row.group_id, legs);
    }
  }

  const emitted = new Set<string>();
  const entries: (PositionListItemRow | PositionGroupEntryRow)[] = [];

  for (const row of rows) {
    if (row.group_id) {
      if (emitted.has(row.group_id)) continue;
      emitted.add(row.group_id);
      entries.push(buildGroupEntry(row.group_id, legsByGroup.get(row.group_id)!));
    } else {
      entries.push(mapListRow(row));
    }
  }

  return entries.filter((entry) => matchesFilters(entry, filters));
}

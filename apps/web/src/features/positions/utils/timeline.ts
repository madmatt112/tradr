import type { EntryGreeksDetail, Fill, PositionSettlementDetail, RollChain } from '@tradr/shared';

// One date-ordered history (design C10, D17): a pure merge of a position's
// fills, settlements, roll chain and entry-Greeks capture. `PositionTimeline`
// renders what this returns; nothing here fetches.

export interface TimelineSource {
  fills: Fill[];
  settlements?: PositionSettlementDetail[];
  rollChain?: RollChain;
  entryGreeks?: EntryGreeksDetail;
}

export type TimelineEntry =
  | { kind: 'fill'; date: string; fill: Fill }
  | { kind: 'settlement'; date: string; settlement: PositionSettlementDetail }
  | { kind: 'roll'; date: string; rollChain: RollChain }
  | { kind: 'greeks'; date: string; entryGreeks: EntryGreeksDetail };

/**
 * Dated entries ascending. `Array.prototype.sort` is stable (ES2019+), so two
 * entries sharing one exact date keep the order they were given in.
 */
export function buildTimeline(position: TimelineSource): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const fill of position.fills) {
    entries.push({ kind: 'fill', date: fill.filledAt, fill });
  }

  for (const settlement of position.settlements ?? []) {
    entries.push({ kind: 'settlement', date: settlement.settledAt, settlement });
  }

  if (position.rollChain) {
    const legs = position.rollChain.legs;
    entries.push({
      kind: 'roll',
      date: legs[legs.length - 1]?.rolledAt ?? '',
      rollChain: position.rollChain,
    });
  }

  if (position.entryGreeks) {
    entries.push({
      kind: 'greeks',
      date: position.entryGreeks.capturedAt,
      entryGreeks: position.entryGreeks,
    });
  }

  return entries.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

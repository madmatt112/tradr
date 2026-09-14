import { toZonedTime } from 'date-fns-tz';

import type { BreakdownDimension } from '../schemas/performance';
import type { Tag } from '../schemas/tag';

import { parseOccUnderlying } from './occ';
import { type ClassifiedPosition, decimalSum } from './performance';

// A `ClassifiedPosition` (the population + net P&L latch `computePositionSetStatistics`
// consumes) carrying the three fields the dimension rules need. A subtype, so every
// existing `ClassifiedPosition` literal keeps compiling and the statistics function
// accepts either.
export interface BreakdownPosition extends ClassifiedPosition {
  symbol: string;
  assetType: 'stock' | 'option';
  tags: Tag[];
}

// D3: an option keys on its parsed underlying (falling back to the stored symbol
// when the compact string does not parse); a stock keys on the stored symbol.
export function symbolKey(p: Pick<BreakdownPosition, 'symbol' | 'assetType'>): string {
  if (p.assetType === 'option') return parseOccUnderlying(p.symbol) ?? p.symbol;
  return p.symbol;
}

// DD1: `weekday` and `hour` both key on the flat instant expressed in the reporting
// zone, read from the local fields of `toZonedTime` — the mechanism
// `generateBucketSeries` relies on (`performance.ts:39-43`, `:79`).
export function attributionParts(flatAt: Date, tz: string): { weekday: number; hour: number } {
  const z = toZonedTime(flatAt, tz);
  return { weekday: z.getDay(), hour: z.getHours() };
}

// DD12: the weekday name in the app's single locale, indexed by `getDay()` (0 = Sunday).
export const WEEKDAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

// The zero-padded 24-hour start label for an hour row (`9` -> `'09:00'`).
export function hourLabel(hour: number): string {
  return `${hour < 10 ? `0${hour}` : String(hour)}:00`;
}

export const UNTAGGED_KEY = 'untagged';

export interface BreakdownGroup {
  key: string;
  label: string;
  tag: Tag | null;
  positions: ClassifiedPosition[];
}

// Group a currency's flat-in-window population by one dimension. The single-valued
// dimensions partition the population; `tag` is multi-valued (a position with N tags
// joins N groups) with an always-present `untagged` group. Row order is not decided
// here — `orderGroups` applies R3.7.
export function groupPositions(
  by: BreakdownDimension,
  positions: readonly BreakdownPosition[],
  tz: string,
  weekStartDay: 0 | 1,
): BreakdownGroup[] {
  if (by === 'symbol') {
    const groups = new Map<string, BreakdownGroup>();
    for (const p of positions) {
      const key = symbolKey(p);
      let group = groups.get(key);
      if (!group) {
        group = { key, label: key, tag: null, positions: [] };
        groups.set(key, group);
      }
      group.positions.push(p);
    }
    return Array.from(groups.values());
  }

  if (by === 'weekday') {
    // Exactly seven groups, pre-created in `weekStartDay` order (R3.7), keyed by the
    // weekday number so the client keys on `key` and may relabel.
    const groups: BreakdownGroup[] = [];
    const byWeekday = new Map<number, BreakdownGroup>();
    for (let i = 0; i < 7; i++) {
      const weekday = (weekStartDay + i) % 7;
      const group: BreakdownGroup = {
        key: String(weekday),
        label: WEEKDAY_LABELS[weekday],
        tag: null,
        positions: [],
      };
      groups.push(group);
      byWeekday.set(weekday, group);
    }
    for (const p of positions) {
      const { weekday } = attributionParts(p.closedAt, tz);
      byWeekday.get(weekday)!.positions.push(p);
    }
    return groups;
  }

  if (by === 'hour') {
    // Exactly twenty-four groups `'0'`…`'23'` in order.
    const groups: BreakdownGroup[] = [];
    for (let hour = 0; hour < 24; hour++) {
      groups.push({ key: String(hour), label: hourLabel(hour), tag: null, positions: [] });
    }
    for (const p of positions) {
      const { hour } = attributionParts(p.closedAt, tz);
      groups[hour]!.positions.push(p);
    }
    return groups;
  }

  // `tag`: one group per distinct tag id carried by at least one position, plus an
  // always-present `untagged` group holding every position with no tag (R5.1–R5.3).
  const tagGroups = new Map<string, BreakdownGroup>();
  const untagged: BreakdownGroup = {
    key: UNTAGGED_KEY,
    label: 'Untagged',
    tag: null,
    positions: [],
  };
  for (const p of positions) {
    if (p.tags.length === 0) {
      untagged.positions.push(p);
      continue;
    }
    for (const tag of p.tags) {
      let group = tagGroups.get(tag.id);
      if (!group) {
        group = { key: tag.id, label: tag.name, tag, positions: [] };
        tagGroups.set(tag.id, group);
      }
      group.positions.push(p);
    }
  }
  return [...tagGroups.values(), untagged];
}

// R3.7: `symbol` and `tag` rows by summed net P&L descending, ties by `key` ascending
// in code-unit order, the `untagged` group last; `weekday` and `hour` keep the
// generated order.
export function orderGroups(by: BreakdownDimension, groups: BreakdownGroup[]): BreakdownGroup[] {
  if (by === 'weekday' || by === 'hour') return groups;

  const sums = new Map<BreakdownGroup, ReturnType<typeof decimalSum>>();
  for (const g of groups) sums.set(g, decimalSum(g.positions.map((p) => p.netPnl)));

  return [...groups].sort((a, b) => {
    const aUntagged = a.key === UNTAGGED_KEY;
    const bUntagged = b.key === UNTAGGED_KEY;
    if (aUntagged !== bUntagged) return aUntagged ? 1 : -1;
    const cmp = sums.get(b)!.comparedTo(sums.get(a)!); // net P&L descending
    if (cmp !== 0) return cmp;
    if (a.key < b.key) return -1; // code-unit order
    if (a.key > b.key) return 1;
    return 0;
  });
}

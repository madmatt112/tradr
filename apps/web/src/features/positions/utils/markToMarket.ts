import type { PositionGroupEntry, PositionListEntry, PositionListItem } from '@tradr/shared';

import { isGroupEntry } from '@/features/positions/utils/listEntries';

export interface MarkToMarketInput {
  isGroup: boolean;
  groupId: string | null;
  assetType: string;
  accountCurrency: string;
}

type MarkableListItem = PositionListItem & { groupId?: string | null };
type MarkableEntry = MarkableListItem | PositionGroupEntry;

/**
 * Design C8/D11: the first matching reason wins, in order group, option,
 * currency. Null means the row is eligible to be marked to market.
 */
export function markReason(input: MarkToMarketInput): string | null {
  if (input.isGroup || input.groupId !== null) {
    return 'Multi-leg groups are not marked to market.';
  }
  if (input.assetType === 'option') {
    return 'Delayed quotes cover stocks, not option contracts.';
  }
  if (input.accountCurrency !== 'USD') {
    return `Quotes are in USD; this account is in ${input.accountCurrency}`;
  }
  return null;
}

/** The symbols of the rows eligible to be marked to market (design C8). */
export function quoteSymbolsFor(entries: MarkableEntry[]): string[] {
  const symbols: string[] = [];
  for (const entry of entries) {
    if (isGroupEntry(entry as PositionListEntry)) continue;
    const row = entry as MarkableListItem;
    const reason = markReason({
      isGroup: false,
      groupId: row.groupId ?? null,
      assetType: row.assetType,
      accountCurrency: row.accountCurrency,
    });
    if (reason === null) symbols.push(row.symbol);
  }
  return symbols;
}

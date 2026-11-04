import type {
  MaxLossReason,
  PositionGroupEntry,
  PositionListEntry,
  PositionListItem,
} from '@tradr/shared';

/** Design C12: a group entry is marked `kind: 'group'`; a plain item is not. */
export function isGroupEntry(entry: PositionListEntry): entry is PositionGroupEntry {
  return 'kind' in entry && entry.kind === 'group';
}

/**
 * Expands each group entry into its legs, in entry order; a plain item
 * passes through unchanged (design C12).
 */
export function flattenEntries(entries: PositionListEntry[]): PositionListItem[] {
  return entries.flatMap((entry) => (isGroupEntry(entry) ? entry.legs : entry));
}

/** The id of the group's first open leg, or its first leg when none are open. */
export function firstOpenLegId(group: PositionGroupEntry): string {
  return group.legs.find((leg) => leg.status === 'open')?.id ?? group.legs[0].id;
}

// Error Handling #7: the three strings shown when a group's max loss is
// unavailable.
const MAX_LOSS_REASON_TEXT: Record<MaxLossReason, string> = {
  multiple_expiries: 'Spans expiries',
  unbounded: 'Unbounded',
  nothing_open: 'Nothing open',
};

export function maxLossReasonText(reason: MaxLossReason | null): string | null {
  return reason ? MAX_LOSS_REASON_TEXT[reason] : null;
}

export const EVENT_NAMES = ['positions:cache-invalidate', 'accounts:cache-invalidate'] as const;
export type EventName = (typeof EVENT_NAMES)[number];
export type PositionChangeReason =
  | 'created'
  | 'updated'
  | 'opened'
  | 'closed'
  | 'reopened'
  | 'fill-added'
  | 'fill-updated'
  | 'fill-deleted'
  | 'deleted';
// Only 'created' is published today, and the union says so rather than listing
// reasons nothing emits. Account updates and deletes invalidate their own
// queries in `useAccounts` and no other feature needs to hear about them; the
// walkthrough does need to hear about a creation, because that is the real event
// its "Create the account" step advances on (user-onboarding R5.5).
export type AccountChangeReason = 'created';
export interface EventPayloads {
  'positions:cache-invalidate': { reason: PositionChangeReason; positionId?: string };
  'accounts:cache-invalidate': { reason: AccountChangeReason };
}

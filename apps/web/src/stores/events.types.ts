export const EVENT_NAMES = [
  'positions:cache-invalidate',
  'accounts:cache-invalidate',
  'auth:logout',
] as const;
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
// Ordinary account updates and deletes are absent on purpose: they invalidate
// their own queries in `useAccounts` and no other feature needs to hear about
// them. These three do. The walkthrough advances its "Create the account" step
// on 'created', because a step that asks the user to do something has to advance
// on the action completing, not on a "Next" click. The two demo reasons add or
// remove a whole account's worth of positions, fills and ledger rows in one
// call, so every derived surface in the app is stale at once — and the seeding
// hook deliberately knows none of their query keys. Cross-feature invalidation
// goes through this bus precisely so no feature has to import another's keys.
export type AccountChangeReason = 'created' | 'demo-seeded' | 'demo-removed';
export interface EventPayloads {
  'positions:cache-invalidate': { reason: PositionChangeReason; positionId?: string };
  'accounts:cache-invalidate': { reason: AccountChangeReason };
  // Published by `useAuth` as the session ends, so module-scoped state that
  // belongs to the departing user can be dropped without `useAuth` importing
  // the features that own it. No payload: "the session is over" is the whole
  // message.
  'auth:logout': Record<string, never>;
}

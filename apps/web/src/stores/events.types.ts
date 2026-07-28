export const EVENT_NAMES = ['positions:cache-invalidate'] as const;
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
export interface EventPayloads {
  'positions:cache-invalidate': { reason: PositionChangeReason; positionId?: string };
}

import { useMutation, useQueryClient } from '@tanstack/react-query';

import type {
  AddGroupLegInput,
  CloseGroupInput,
  CreatePositionGroupInput,
  LinkPositionsInput,
  PositionGroupEntry,
  SetGroupLabelInput,
} from '@tradr/shared';

import { billingKeys } from '@/features/billing/useWalletBalance';
import { api, isUnauthorized } from '@/lib/api';
import { eventBus } from '@/stores/event-bus.store';
import type { PositionChangeReason } from '@/stores/events.types';

type QueryClientLike = {
  invalidateQueries: (filters: { queryKey: readonly unknown[] }) => unknown;
};

/**
 * Shared error handler for group mutations (mirrors `handlePositionMutationError`,
 * `apps/web/src/features/positions/hooks/usePosition.ts:36-46`): 401
 * short-circuits before any invalidation — `api` has already navigated to
 * /login — and everything else invalidates `['positions']` and
 * `['performance']` so cross-feature views stay consistent.
 */
function handleGroupMutationError(err: unknown, queryClient: QueryClientLike): void {
  if (isUnauthorized(err)) return;
  queryClient.invalidateQueries({ queryKey: ['positions'] });
  queryClient.invalidateQueries({ queryKey: ['performance'] });
}

/**
 * Publishes one `positions:cache-invalidate` event per leg of a group
 * response, so every leg-scoped listener (the event bus bridge, the
 * walkthrough) hears the change exactly as it would for a single-position
 * mutation (design C13).
 */
function publishPerLeg(group: PositionGroupEntry, reason: PositionChangeReason): void {
  for (const leg of group.legs) {
    eventBus.publish('positions:cache-invalidate', { reason, positionId: leg.id });
  }
}

/** Creates a 2-to-8-leg strategy group in one write (design C3/C4/C13). */
export function useCreatePositionGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreatePositionGroupInput) =>
      api.post<PositionGroupEntry>('/position-groups', data),
    onSuccess: (group) => {
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      queryClient.invalidateQueries({ queryKey: ['performance'] });
      // Display hygiene (plan-tiers Component 12), same as `useCreatePosition`:
      // usage.positions.used lives on the tier key.
      queryClient.invalidateQueries({ queryKey: billingKeys.tier() });
      publishPerLeg(group, 'created');
    },
    onError: (err: unknown) => handleGroupMutationError(err, queryClient),
  });
}

/** Links 2 to 8 existing ungrouped positions into a new group (design C3/C4). */
export function useLinkPositions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: LinkPositionsInput) =>
      api.post<PositionGroupEntry>('/position-groups/link', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      queryClient.invalidateQueries({ queryKey: ['performance'] });
    },
    onError: (err: unknown) => handleGroupMutationError(err, queryClient),
  });
}

/** Adds one more leg to an existing group (design C3/C4). */
export function useAddGroupLeg(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: AddGroupLegInput) =>
      api.post<PositionGroupEntry>(`/position-groups/${groupId}/legs`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      queryClient.invalidateQueries({ queryKey: ['performance'] });
    },
    onError: (err: unknown) => handleGroupMutationError(err, queryClient),
  });
}

/** Unlinks one leg from a group; the group dissolves once one leg remains. */
export function useUnlinkGroupLeg(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (positionId: string) =>
      api.delete(`/position-groups/${groupId}/legs/${positionId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      queryClient.invalidateQueries({ queryKey: ['performance'] });
    },
    onError: (err: unknown) => handleGroupMutationError(err, queryClient),
  });
}

/** Sets or clears a group's label override (design C3/C4, Requirement 3.4). */
export function useSetGroupLabel(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: SetGroupLabelInput) =>
      api.patch<PositionGroupEntry>(`/position-groups/${groupId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      queryClient.invalidateQueries({ queryKey: ['performance'] });
    },
    onError: (err: unknown) => handleGroupMutationError(err, queryClient),
  });
}

/**
 * Closes every open leg of a group in one transaction (design C3/C4/C13,
 * Requirement 4). Exported so `CloseGroupDialog` can surface the server's
 * per-leg error message on rejection (Error Handling #5) — the mutation
 * itself never shows a toast, as that dialog stays open on failure instead.
 */
export function useCloseGroup(groupId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CloseGroupInput) =>
      api.post<PositionGroupEntry>(`/position-groups/${groupId}/close`, data),
    onSuccess: (group) => {
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      queryClient.invalidateQueries({ queryKey: ['performance'] });
      publishPerLeg(group, 'closed');
    },
    onError: (err: unknown) => handleGroupMutationError(err, queryClient),
  });
}

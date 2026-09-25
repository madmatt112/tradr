// Account-deletion client hooks (design §C11, Req 8.3).
//
// The status query, the delete mutation and the cancel mutation. The delete
// mutation carries the teardown: a `deleted` outcome ends the session exactly as
// logout does, a `scheduled` one leaves the session standing and refreshes the
// surfaces the schedule changed.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';

import type { AccountDeletionResult, AccountDeletionStatus } from '@tradr/shared';

import { billingKeys } from '@/features/billing/useWalletBalance';
import { api, markSessionEnded, setIsLoggingOut } from '@/lib/api';
import { clearClientSessionState } from '@/lib/sessionTeardown';

export const deletionKeys = {
  status: () => ['account-deletion', 'status'] as const,
};

/** Whether a deletion is scheduled for the current user, and its state. */
export function useDeletionStatus() {
  return useQuery<AccountDeletionStatus>({
    queryKey: deletionKeys.status(),
    queryFn: () => api.get<AccountDeletionStatus>('/users/me/deletion'),
  });
}

/**
 * Delete the current user's own account.
 *
 * The `mutationFn` sets `isLoggingOut` BEFORE the POST, as logout does
 * (`useAuth`'s logout mutation): on a `deleted` outcome the teardown below
 * empties the cache while the authenticated surfaces are still mounted, so every
 * one of them refetches and 401s — and the flag keeps those 401s from routing to
 * `/login?expired=true` and mislabelling a deletion as an expiry.
 *
 * On `deleted`: end the session and navigate to `/login` with the deleted
 * notice. On `scheduled` or ANY error: the session lives on, so clear the flag
 * and refresh the deletion status and the billing tier (a schedule pins the tier
 * to the paid period's end).
 */
export function useDeleteAccount() {
  const queryClient = useQueryClient();
  const router = useRouter();

  const settleSignedIn = () => {
    setIsLoggingOut(false);
    void queryClient.invalidateQueries({ queryKey: deletionKeys.status() });
    void queryClient.invalidateQueries({ queryKey: billingKeys.tier() });
  };

  return useMutation<AccountDeletionResult, unknown, { password: string }>({
    mutationFn: ({ password }) => {
      setIsLoggingOut(true);
      return api.post<AccountDeletionResult>('/users/me/deletion', { password });
    },
    onSuccess: (result) => {
      if (result.outcome === 'deleted') {
        markSessionEnded();
        clearClientSessionState(queryClient);
        router.navigate({ to: '/login', search: { deleted: true } });
        return;
      }
      settleSignedIn();
    },
    onError: () => {
      settleSignedIn();
    },
  });
}

/**
 * Cancel a scheduled deletion (Req 8.4). The server answers the cleared status;
 * the status query is invalidated so the settings section drops back to the
 * delete-account control.
 */
export function useCancelDeletion() {
  const queryClient = useQueryClient();

  return useMutation<AccountDeletionStatus, unknown, void>({
    mutationFn: () => api.delete<AccountDeletionStatus>('/users/me/deletion'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: deletionKeys.status() });
    },
  });
}

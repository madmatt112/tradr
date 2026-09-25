import { useMutation, useQueryClient } from '@tanstack/react-query';

import type {
  AdminDeleteUserRequest,
  AdminDeleteUserResult,
} from '@tradr/shared/schemas/account-deletion';

import { api } from '@/lib/api';

/**
 * Delete a user and all their data (admin only) — POSTs the task 12 route.
 *
 * Mirrors useFactoryReset: EVERY ADMIN QUERY IS INVALIDATED, not just the user
 * list, because a delete changes the platform stats card and the target's detail
 * row, and an operator who has just destroyed an account should not be shown a
 * cached copy of it. The blunt prefix invalidation is right here — this runs at
 * most once per deliberate, confirmed action.
 */
export function useAdminDeleteUser() {
  const queryClient = useQueryClient();
  return useMutation<AdminDeleteUserResult, unknown, { userId: string } & AdminDeleteUserRequest>({
    mutationFn: ({ userId, confirmEmail }) =>
      api.post<AdminDeleteUserResult>(`/admin/users/${userId}/delete`, { confirmEmail }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
}

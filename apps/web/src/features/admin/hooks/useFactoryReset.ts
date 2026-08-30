import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  type AdminResetPreview,
  AdminResetPreviewSchema,
  type AdminResetRequest,
  type AdminResetResult,
} from '@tradr/shared/schemas/admin';

import { api } from '@/lib/api';

/**
 * What a factory reset would delete, for the confirmation dialog.
 *
 * `enabled` on an id rather than fetched with the row: the preview is only worth
 * a request once someone has opened the dialog, and the counts are the one part
 * of that dialog that must be fresh. `staleTime: 0` (the app default) means
 * re-opening it re-reads rather than showing what the account looked like the
 * last time the operator considered this.
 */
export function useResetPreview(userId: string | undefined) {
  return useQuery<AdminResetPreview>({
    queryKey: ['admin', 'users', 'reset-preview', userId],
    queryFn: async () => {
      const raw = await api.get<unknown>(`/admin/users/${userId}/reset-preview`);
      return AdminResetPreviewSchema.parse(raw);
    },
    enabled: !!userId,
  });
}

/**
 * Perform the reset.
 *
 * EVERY ADMIN QUERY IS INVALIDATED, not just the user list: a reset changes the
 * platform position counts on the stats card and the target's detail row, and an
 * operator who has just destroyed data should not be shown a cached copy of it.
 * The blunt prefix invalidation is right here — this runs at most once per
 * deliberate, confirmed action, so there is nothing to optimise.
 */
export function useFactoryReset() {
  const queryClient = useQueryClient();
  return useMutation<AdminResetResult, unknown, { userId: string } & AdminResetRequest>({
    mutationFn: ({ userId, confirmEmail, removeSettings }) =>
      api.post<AdminResetResult>(`/admin/users/${userId}/reset`, { confirmEmail, removeSettings }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
}

import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { AdminUserListItem, ToggleAdminRequest } from '@tradr/shared/schemas/admin';

import { api } from '@/lib/api';

// PATCH /admin/users/:id/admin returns the post-toggle target —
// { id, email, isAdmin, createdAt } (no lastActiveAt).
type ToggleAdminResponse = Pick<AdminUserListItem, 'id' | 'email' | 'isAdmin' | 'createdAt'>;

export function useToggleAdmin() {
  const queryClient = useQueryClient();
  return useMutation<ToggleAdminResponse, unknown, { userId: string } & ToggleAdminRequest>({
    mutationFn: ({ userId, isAdmin }) =>
      api.patch<ToggleAdminResponse>(`/admin/users/${userId}/admin`, { isAdmin }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'stats'] });
    },
  });
}

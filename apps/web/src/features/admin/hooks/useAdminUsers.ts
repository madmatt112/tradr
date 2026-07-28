import { useQuery } from '@tanstack/react-query';

import {
  type AdminUserListResponse,
  AdminUserListResponseSchema,
} from '@tradr/shared/schemas/admin';

import { api } from '@/lib/api';

export function useAdminUsers(cursor?: string) {
  return useQuery<AdminUserListResponse>({
    queryKey: ['admin', 'users', 'list', { cursor }],
    queryFn: async () => {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const raw = await api.get<unknown>(`/admin/users${query}`);
      return AdminUserListResponseSchema.parse(raw);
    },
  });
}

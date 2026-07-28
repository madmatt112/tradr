import { useQuery } from '@tanstack/react-query';

import { type AdminUserDetail, AdminUserDetailSchema } from '@tradr/shared/schemas/admin';

import { api } from '@/lib/api';

export function useAdminUser(id: string | undefined) {
  return useQuery<AdminUserDetail>({
    queryKey: ['admin', 'users', 'detail', id],
    queryFn: async () => {
      const raw = await api.get<unknown>(`/admin/users/${id}`);
      return AdminUserDetailSchema.parse(raw);
    },
    enabled: !!id,
  });
}

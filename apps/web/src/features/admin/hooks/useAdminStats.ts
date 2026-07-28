import { useQuery } from '@tanstack/react-query';

import { type AdminStats, AdminStatsSchema } from '@tradr/shared/schemas/admin';

import { api } from '@/lib/api';

export function useAdminStats() {
  return useQuery<AdminStats>({
    queryKey: ['admin', 'stats'],
    queryFn: async () => {
      const raw = await api.get<unknown>('/admin/stats');
      return AdminStatsSchema.parse(raw);
    },
  });
}

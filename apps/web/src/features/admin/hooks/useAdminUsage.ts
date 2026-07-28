import { useQuery } from '@tanstack/react-query';

import { type AdminUsage, AdminUsageSchema } from '@tradr/shared/schemas/admin';

import { api } from '@/lib/api';

export interface AdminUsagePeriod {
  from?: string;
  to?: string;
}

export function useAdminUsage(period?: AdminUsagePeriod) {
  const from = period?.from;
  const to = period?.to;

  return useQuery<AdminUsage>({
    queryKey: ['admin', 'usage', { from, to }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const query = params.toString();
      const raw = await api.get<unknown>(`/admin/usage${query ? `?${query}` : ''}`);
      return AdminUsageSchema.parse(raw);
    },
  });
}

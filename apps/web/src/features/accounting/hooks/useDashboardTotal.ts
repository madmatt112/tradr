import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';

export interface DashboardTotalResponse {
  displayCurrency: string | null;
  total: string | null;
  missingPairs?: Array<{ baseCurrency: string; quoteCurrency: string }>;
}

export function useDashboardTotalQuery() {
  return useQuery<DashboardTotalResponse>({
    queryKey: ['dashboard', 'totals'],
    queryFn: () => api.get<DashboardTotalResponse>('/dashboard/totals'),
  });
}

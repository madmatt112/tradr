import { useQuery } from '@tanstack/react-query';

import { type TaxSummaryResponse, TaxSummaryResponseSchema } from '@tradr/shared/schemas/expense';

import { api } from '@/lib/api';

// Per Task 22 (v3-6): NO `jurisdiction` query parameter — the server reads
// jurisdiction from the DB. The cache key carries only `year`. A
// `useTaxJurisdiction` PATCH triggers prefix invalidation of
// `['expenses', 'tax-summary']`, forcing a refetch under the year-only key.
export function useTaxSummary(year: number) {
  return useQuery<TaxSummaryResponse>({
    queryKey: ['expenses', 'tax-summary', { year }],
    queryFn: async () => {
      const raw = await api.get<unknown>(`/expenses/tax-summary?year=${year}`);
      return TaxSummaryResponseSchema.parse(raw);
    },
  });
}

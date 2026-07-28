import { useQuery } from '@tanstack/react-query';

import { type FeeRollupResponse, FeeRollupResponseSchema } from '@tradr/shared/schemas/expense';

import { api } from '@/lib/api';

export function useFeeRollup(year: number) {
  return useQuery<FeeRollupResponse>({
    queryKey: ['expenses', 'fee-rollup', year],
    queryFn: async () => {
      const raw = await api.get<unknown>(`/expenses/fee-rollup?year=${year}`);
      return FeeRollupResponseSchema.parse(raw);
    },
  });
}

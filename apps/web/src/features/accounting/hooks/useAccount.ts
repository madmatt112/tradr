import { useQuery } from '@tanstack/react-query';

import type { Account } from '@tradr/shared';

import { api } from '@/lib/api';

export function useAccount(accountId: string | undefined) {
  return useQuery<Account>({
    queryKey: ['accounts', 'detail', accountId],
    queryFn: () => api.get<Account>(`/accounts/${accountId}`),
    enabled: !!accountId,
  });
}

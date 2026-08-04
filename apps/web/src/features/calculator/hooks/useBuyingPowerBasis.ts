import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import type { BuyingPowerBasis } from '@tradr/shared';

import { api } from '@/lib/api';

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'error' in err) {
    const e = err as { error?: { message?: string } };
    if (e.error?.message) return e.error.message;
  }
  return fallback;
}

interface BuyingPowerBasisResponse {
  basis: BuyingPowerBasis;
}

export function useBuyingPowerBasisQuery() {
  return useQuery<BuyingPowerBasisResponse>({
    queryKey: ['users', 'me', 'buying-power-basis'],
    queryFn: () => api.get<BuyingPowerBasisResponse>('/users/me/buying-power-basis'),
  });
}

export function useBuyingPowerBasisMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (basis: BuyingPowerBasis) =>
      api.put<BuyingPowerBasisResponse>('/users/me/buying-power-basis', { basis }),
    onSuccess: () => {
      // Only the preference itself. Nothing else is cached off it: the
      // calculator reads the basis at account-select time and recomputes
      // locally, and no server-side figure depends on it.
      queryClient.invalidateQueries({ queryKey: ['users', 'me', 'buying-power-basis'] });
      toast.success('Buying power basis updated');
    },
    onError: (err: unknown) => {
      toast.error(getErrorMessage(err, 'Failed to update buying power basis'));
    },
  });
}

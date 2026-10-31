import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';

import { api } from '@/lib/api';

const TaxLotMethodResponseSchema = z
  .object({
    taxLotMethod: z.enum(['fifo', 'average']).nullable(),
    effectiveMethod: z.enum(['fifo', 'average', 'acb']),
    isDefault: z.boolean(),
  })
  .strict();

type TaxLotMethodResponse = z.infer<typeof TaxLotMethodResponseSchema>;
type TaxLotMethodValue = TaxLotMethodResponse['taxLotMethod'];

const QUERY_KEY = ['users', 'me', 'tax-lot-method'] as const;

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'error' in err) {
    const e = err as { error?: { message?: string } };
    if (e.error?.message) return e.error.message;
  }
  return fallback;
}

export function useTaxLotMethodQuery() {
  return useQuery<TaxLotMethodResponse>({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const raw = await api.get<unknown>('/users/me/tax-lot-method');
      return TaxLotMethodResponseSchema.parse(raw);
    },
  });
}

// Non-optimistic, mirroring useTaxJurisdiction.ts:41-59 — awaits the server,
// then invalidates its own key, the tax-summary prefix and the lot-picker
// prefix (the method changes which lots the picker shows). The controlled
// Select reverts via this query's cache on a failed PATCH.
export function useTaxLotMethodMutation() {
  const queryClient = useQueryClient();
  return useMutation<TaxLotMethodResponse, unknown, TaxLotMethodValue>({
    mutationFn: async (taxLotMethod) => {
      const raw = await api.patch<unknown>('/users/me/tax-lot-method', {
        taxLotMethod,
      });
      return TaxLotMethodResponseSchema.parse(raw);
    },
    onSuccess: async () => {
      await queryClient.cancelQueries({ queryKey: ['expenses', 'tax-summary'] });
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: ['expenses', 'tax-summary'] });
      await queryClient.invalidateQueries({ queryKey: ['positions', 'lots'] });
    },
    onError: (err: unknown) => {
      toast.error(getErrorMessage(err, 'Failed to update tax lot method'));
    },
  });
}

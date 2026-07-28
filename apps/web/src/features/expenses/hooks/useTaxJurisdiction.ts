import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';

import { api } from '@/lib/api';

const TaxJurisdictionResponseSchema = z
  .object({
    taxJurisdiction: z.enum(['US', 'CA', 'other']).nullable(),
  })
  .strict();

type TaxJurisdictionResponse = z.infer<typeof TaxJurisdictionResponseSchema>;
type TaxJurisdictionValue = TaxJurisdictionResponse['taxJurisdiction'];

const QUERY_KEY = ['users', 'me', 'tax-jurisdiction'] as const;

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'error' in err) {
    const e = err as { error?: { message?: string } };
    if (e.error?.message) return e.error.message;
  }
  return fallback;
}

export function useTaxJurisdictionQuery() {
  return useQuery<TaxJurisdictionResponse>({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const raw = await api.get<unknown>('/users/me/tax-jurisdiction');
      return TaxJurisdictionResponseSchema.parse(raw);
    },
  });
}

// PATCH mutation is NOT optimistic (post-review fix #10): awaits the server,
// then cancels in-flight tax-summary fetches (v2-10) BEFORE invalidating
// both the jurisdiction key and the `['expenses', 'tax-summary']` prefix.
// On failure, surfaces a toast; the controlled dropdown reverts via
// `useTaxJurisdictionQuery().data` (no local optimistic state).
export function useTaxJurisdictionMutation() {
  const queryClient = useQueryClient();
  return useMutation<TaxJurisdictionResponse, unknown, TaxJurisdictionValue>({
    mutationFn: async (taxJurisdiction) => {
      const raw = await api.patch<unknown>('/users/me/tax-jurisdiction', {
        taxJurisdiction,
      });
      return TaxJurisdictionResponseSchema.parse(raw);
    },
    onSuccess: async () => {
      await queryClient.cancelQueries({ queryKey: ['expenses', 'tax-summary'] });
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: ['expenses', 'tax-summary'] });
    },
    onError: (err: unknown) => {
      toast.error(getErrorMessage(err, 'Failed to update tax jurisdiction'));
    },
  });
}

export function useTaxJurisdiction() {
  const query = useTaxJurisdictionQuery();
  const mutation = useTaxJurisdictionMutation();
  return { query, mutation };
}

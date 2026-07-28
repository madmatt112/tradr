import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import type {
  CreateExchangeRateInput,
  ExchangeRate,
  PreviewRateChangeInput,
  PreviewRateChangeResponse,
} from '@tradr/shared/schemas/accounting';

import { api } from '@/lib/api';

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'error' in err) {
    const e = err as { error?: { message?: string } };
    if (e.error?.message) return e.error.message;
  }
  return fallback;
}

export function useExchangeRates() {
  return useQuery<ExchangeRate[]>({
    queryKey: ['exchange-rates', 'list'],
    queryFn: () => api.get<ExchangeRate[]>('/exchange-rates'),
  });
}

export function useCreateExchangeRate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateExchangeRateInput) => api.post<ExchangeRate>('/exchange-rates', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['exchange-rates'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard', 'totals'] });
      toast.success('Exchange rate saved');
    },
    onError: (err: unknown) => {
      toast.error(getErrorMessage(err, 'Failed to save exchange rate'));
    },
  });
}

export function useDeleteExchangeRate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/exchange-rates/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['exchange-rates'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard', 'totals'] });
      toast.success('Exchange rate deleted');
    },
    onError: (err: unknown) => {
      toast.error(getErrorMessage(err, 'Failed to delete exchange rate'));
    },
  });
}

export function usePreviewRateChange() {
  return useMutation({
    mutationFn: (input: PreviewRateChangeInput) =>
      api.post<PreviewRateChangeResponse>('/exchange-rates/preview', input),
  });
}

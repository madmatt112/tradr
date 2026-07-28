import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import type { Brokerage, CreateBrokerageInput, UpdateBrokerageInput } from '@tradr/shared';

import { api } from '@/lib/api';

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'error' in err) {
    const e = err as { error?: { message?: string } };
    if (e.error?.message) return e.error.message;
  }
  return fallback;
}

export function useBrokerages() {
  return useQuery<Brokerage[]>({
    queryKey: ['brokerages', 'list'],
    queryFn: () => api.get<Brokerage[]>('/brokerages'),
  });
}

export function useBrokerage(id: string | undefined) {
  return useQuery<Brokerage>({
    queryKey: ['brokerages', id],
    queryFn: () => api.get<Brokerage>(`/brokerages/${id}`),
    enabled: !!id,
  });
}

export function useCreateBrokerage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateBrokerageInput) => api.post<Brokerage>('/brokerages', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brokerages', 'list'] });
      toast.success('Brokerage created');
    },
    onError: (err: unknown) => {
      toast.error(getErrorMessage(err, 'Failed to create brokerage'));
    },
  });
}

export function useUpdateBrokerage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateBrokerageInput }) =>
      api.put<Brokerage>(`/brokerages/${id}`, data),
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['brokerages', 'list'] });
      queryClient.invalidateQueries({ queryKey: ['brokerages', id] });
      toast.success('Brokerage updated');
    },
    onError: (err: unknown) => {
      toast.error(getErrorMessage(err, 'Failed to update brokerage'));
    },
  });
}

export function useDeleteBrokerage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/brokerages/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brokerages', 'list'] });
      toast.success('Brokerage deleted');
    },
    onError: (err: unknown) => {
      toast.error(getErrorMessage(err, 'Failed to delete brokerage'));
    },
  });
}

export function useDuplicateBrokerage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<Brokerage>(`/brokerages/${id}/duplicate`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brokerages', 'list'] });
      toast.success('Brokerage duplicated');
    },
    onError: (err: unknown) => {
      toast.error(getErrorMessage(err, 'Failed to duplicate brokerage'));
    },
  });
}

export function useBrokeragePositionCount(id: string | undefined) {
  return useQuery<{ count: number }>({
    queryKey: ['brokerages', id, 'position-count'],
    queryFn: () => api.get<{ count: number }>(`/brokerages/${id}/position-count`),
    enabled: !!id,
  });
}

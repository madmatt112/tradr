import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import type {
  Account,
  CreateAccountInput,
  SetWritableAccountInput,
  UpdateAccountInput,
} from '@tradr/shared';

import { billingKeys } from '@/features/billing/useWalletBalance';
import { api } from '@/lib/api';
import { eventBus } from '@/stores/event-bus.store';

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'error' in err) {
    const e = err as { error?: { message?: string } };
    if (e.error?.message) return e.error.message;
  }
  return fallback;
}

// House envelope: the api client throws the parsed JSON body — the
// machine-readable code lives at err.error?.code (never message text).
export function getAccountErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  return (err as { error?: { code?: string } }).error?.code;
}

/**
 * `options.enabled` lets a caller that may not need the list at all skip the
 * request entirely; omitted, it fetches as before. A disabled query reports
 * `data: undefined`, `isLoading: false` and `isError: false`.
 */
export function useAccounts(options?: { enabled?: boolean }) {
  return useQuery<Account[]>({
    queryKey: ['accounts', 'list'],
    queryFn: () => api.get<Account[]>('/accounts'),
    enabled: options?.enabled,
  });
}

export function useCreateAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateAccountInput) => api.post<Account>('/accounts', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard', 'totals'] });
      // Display hygiene (plan-tiers Component 12): usage.accounts.{used,
      // writableAccountId} live on the tier key; server enforcement is always
      // fresh via the lazy resolver.
      queryClient.invalidateQueries({ queryKey: billingKeys.tier() });
      // Cross-feature announcement, not a cache concern: the invalidations above
      // already cover this feature's own reads. The onboarding walkthrough's
      // "Create the account" step advances on the account actually existing
      // rather than on a "Next" click (user-onboarding R5.5), and this is that
      // event.
      eventBus.publish('accounts:cache-invalidate', { reason: 'created' });
      toast.success('Account created');
    },
    onError: (err: unknown) => {
      // TIER_LIMIT_ACCOUNTS renders inline in the create dialog (mapped on the
      // CODE only) — no duplicate toast.
      if (getAccountErrorCode(err) === 'TIER_LIMIT_ACCOUNTS') return;
      toast.error(getErrorMessage(err, 'Failed to create account'));
    },
  });
}

export function useUpdateAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateAccountInput }) =>
      api.put<Account>(`/accounts/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard', 'totals'] });
      toast.success('Account updated');
    },
    onError: (err: unknown) => {
      toast.error(getErrorMessage(err, 'Failed to update account'));
    },
  });
}

export function useDeleteAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/accounts/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard', 'totals'] });
      // Deleting can change used count AND the effective designation (D18).
      queryClient.invalidateQueries({ queryKey: billingKeys.tier() });
      toast.success('Account deleted');
    },
    onError: (err: unknown) => {
      toast.error(getErrorMessage(err, 'Failed to delete account'));
    },
  });
}

/**
 * PUT /api/accounts/writable — set the writable-account designation (plan-tiers
 * D18, REQ-6.6). Always-on stored preference; the tier key invalidation keeps
 * `usage.accounts.writableAccountId` (badges/pickers) fresh in the cache.
 */
export function useSetWritableAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) => {
      const body: SetWritableAccountInput = { accountId };
      return api.put<{ writableAccountId: string }>('/accounts/writable', body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: billingKeys.tier() });
      toast.success('Writable account updated');
    },
    onError: (err: unknown) => {
      toast.error(getErrorMessage(err, 'Failed to update the writable account'));
    },
  });
}

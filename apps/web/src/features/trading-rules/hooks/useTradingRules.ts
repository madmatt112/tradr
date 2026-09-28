import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import type { TradingRule, TradingRuleInput } from '@tradr/shared';

import { api, isUnauthorized } from '@/lib/api';

/** House envelope: the machine-readable code lives at err.error?.code. The twin
 * of `getTagErrorCode` — kept here so this feature does not reach into the tags
 * hook. */
export function getTradingRuleErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  return (err as { error?: { code?: string } }).error?.code;
}

// The two rule 409 codes the calling surface renders inline (branch on the CODE
// only, never message text) — the generic toast would double-surface them.
const INLINE_CODES = new Set(['TRADING_RULE_LIMIT_REACHED', 'TRADING_RULE_DUPLICATE']);

/**
 * Mutation error handler for the rule mutations. 401 short-circuits BEFORE any
 * toast — the `api` module already navigated to /login. The inline codes render
 * in place (the dialog's limit/duplicate slot), so they get no toast; every
 * other error toasts the envelope message. Exported for tests and the dialog.
 */
export function handleTradingRuleMutationError(
  err: unknown,
  showToast: (msg: string) => void,
  fallback: string,
): void {
  if (isUnauthorized(err)) return;
  if (INLINE_CODES.has(getTradingRuleErrorCode(err) ?? '')) return;
  const msg =
    typeof err === 'object' && err !== null && 'error' in err
      ? (err as { error?: { message?: string } }).error?.message
      : undefined;
  showToast(msg || fallback);
}

/**
 * The rules list as a query DEFINITION. `useTradingRules` wraps it; a caller
 * that needs the list once (the compliance panel's no-rules check) reads the
 * same cache entry through the same fetcher.
 */
export function tradingRulesListQuery() {
  return queryOptions({
    queryKey: ['trading-rules', 'list'],
    queryFn: () => api.get<TradingRule[]>('/trading-rules'),
  });
}

export function useTradingRules() {
  return useQuery(tradingRulesListQuery());
}

// A rule create, edit, enable, disable, weight change or delete changes what
// every read surface scores: the rule list, the per-position compliance on the
// positions detail, and the compliance breakdown on the performance page.
function invalidateScoredSurfaces(queryClient: ReturnType<typeof useQueryClient>): void {
  queryClient.invalidateQueries({ queryKey: ['trading-rules'] });
  queryClient.invalidateQueries({ queryKey: ['positions'] });
  queryClient.invalidateQueries({ queryKey: ['performance'] });
}

export function useCreateTradingRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TradingRuleInput) => api.post<TradingRule>('/trading-rules', input),
    onSuccess: () => {
      invalidateScoredSurfaces(queryClient);
      toast.success('Rule created');
    },
    onError: (err: unknown) => {
      handleTradingRuleMutationError(err, toast.error, 'Failed to create rule');
    },
  });
}

export function useUpdateTradingRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: TradingRuleInput }) =>
      api.put<TradingRule>(`/trading-rules/${id}`, data),
    onSuccess: () => {
      invalidateScoredSurfaces(queryClient);
      toast.success('Rule updated');
    },
    onError: (err: unknown) => {
      handleTradingRuleMutationError(err, toast.error, 'Failed to update rule');
    },
  });
}

export function useDeleteTradingRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/trading-rules/${id}`),
    onSuccess: () => {
      invalidateScoredSurfaces(queryClient);
      toast.success('Rule deleted');
    },
    onError: (err: unknown) => {
      handleTradingRuleMutationError(err, toast.error, 'Failed to delete rule');
    },
  });
}

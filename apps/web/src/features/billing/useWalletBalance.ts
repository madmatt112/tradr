// useWalletBalance / useBillingConfig — TanStack Query hooks for the billing tab
// (design §Component 8; REQ-7).
//
// GET /api/billing/balance → { balance, available } (credit-unit strings).
// GET /api/billing/config  → { enabled, packs, models } (drives graceful absence).

import { useQuery } from '@tanstack/react-query';

import type { BillingConfig, WalletBalance } from '@tradr/shared';

import { api } from '@/lib/api';

export const billingKeys = {
  balance: () => ['billing', 'balance'] as const,
  config: () => ['billing', 'config'] as const,
  history: () => ['billing', 'history'] as const,
  tier: () => ['billing', 'tier'] as const,
};

/** REQ-7.3 — the user's wallet balance (credit count, not currency). */
export function useWalletBalance() {
  return useQuery<WalletBalance>({
    queryKey: billingKeys.balance(),
    queryFn: () => api.get<WalletBalance>('/billing/balance'),
  });
}

/** REQ-7.4 — billing availability + packs/models; drives whether the tab shows
 * the purchase UI or the "not enabled on this instance" state. */
export function useBillingConfig() {
  return useQuery<BillingConfig>({
    queryKey: billingKeys.config(),
    queryFn: () => api.get<BillingConfig>('/billing/config'),
  });
}

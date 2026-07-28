// useTierState — TanStack Query hook over GET /api/billing/tier (design
// §Component 11, D16; REQ-11.4).
//
// Deliberately NO `enabled` guard: one cheap authed read per mount is accepted
// — the endpoint is unthrottled by design (Component 6; it must survive the
// confirming poll), and a self-host instance just gets the minimal gating-off
// shape back.

import { useQuery } from '@tanstack/react-query';

import type { TierState } from '@tradr/shared';

import { api } from '@/lib/api';

import { billingKeys } from './useWalletBalance';

export interface UseTierStateOptions {
  /** Forwarded to useQuery — PlanCard's confirming poll sets this (REQ-2.6). */
  refetchInterval?: number | false;
}

export function useTierState(options: UseTierStateOptions = {}) {
  return useQuery<TierState>({
    queryKey: billingKeys.tier(),
    queryFn: () => api.get<TierState>('/billing/tier'),
    refetchInterval: options.refetchInterval ?? false,
  });
}

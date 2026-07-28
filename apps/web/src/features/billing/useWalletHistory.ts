// useWalletHistory — paginated wallet/usage history (design §Component 8; REQ-7.3).
//
// GET /api/billing/usage?cursor= → { items, nextCursor }. Uses useInfiniteQuery so
// the UsageHistory list can append pages with a "Load more" affordance.

import { useInfiniteQuery } from '@tanstack/react-query';

import type { WalletHistoryItem } from '@tradr/shared';

import { api } from '@/lib/api';

import { billingKeys } from './useWalletBalance';

export interface WalletHistoryPage {
  items: WalletHistoryItem[];
  nextCursor: string | null;
}

/** REQ-7.3 — cursor-paginated credit/debit/reversal + per-turn usage history. */
export function useWalletHistory() {
  return useInfiniteQuery<WalletHistoryPage>({
    queryKey: billingKeys.history(),
    queryFn: ({ pageParam }) => {
      const cursor = pageParam as string | null;
      const path = cursor
        ? `/billing/usage?cursor=${encodeURIComponent(cursor)}`
        : '/billing/usage';
      return api.get<WalletHistoryPage>(path);
    },
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

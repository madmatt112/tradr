import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { eventBus } from './event-bus.store';

export function EventBusBridge(): null {
  const queryClient = useQueryClient();
  useEffect(() => {
    // INVARIANT: ledger_entries is written only by closePosition's registered close hook
    // (apps/api/src/features/accounting/ledger-hook.ts). Drafts/opens cannot have ledger
    // entries. Deleting a CLOSED position posts a reversing ledger row that nets its
    // realized P&L back out, so it moves the derived account balance and must invalidate
    // the balance-derived queries; fill mutations on closed positions are API-rejected
    // with ConflictError. Future ledger-write paths MUST update this branching in lockstep.
    return eventBus.subscribe('positions:cache-invalidate', ({ reason }) => {
      switch (reason) {
        case 'closed':
        case 'reopened':
        case 'deleted':
          // Closing posts realized P&L to the ledger; reopening (R13) and deleting a
          // closed position each post a reversing ledger row that nets it back out. All
          // three move the derived account balance, so invalidate the same balance-derived
          // queries. (Deleting a draft/open moves no balance, but over-invalidating there
          // is cheap and keeps this correct without threading position status through.)
          queryClient.invalidateQueries({ queryKey: ['accounts'] });
          queryClient.invalidateQueries({ queryKey: ['dashboard', 'totals'] });
          queryClient.invalidateQueries({ queryKey: ['performance'] });
          return;
        case 'opened':
        case 'fill-added':
        case 'fill-updated':
        case 'fill-deleted':
        case 'updated':
          queryClient.invalidateQueries({ queryKey: ['performance'] });
          return;
        case 'created':
          // §E: a newly created draft contributes nothing to performance, accounts, or
          // dashboard totals. No invalidation.
          return;
      }
    });
  }, [queryClient]);
  return null;
}

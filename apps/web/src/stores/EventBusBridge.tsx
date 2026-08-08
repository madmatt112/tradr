import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { eventBus } from './event-bus.store';

export function EventBusBridge(): null {
  const queryClient = useQueryClient();

  // Sample data (user-onboarding R9). Seeding and teardown each add or remove a
  // whole account's worth of positions, fills and ledger rows in a single call,
  // so every derived surface is stale at once and the user must not have to
  // reload to see it. The seeding hook publishes and knows none of these keys;
  // this is the one place that maps the announcement onto them.
  //
  // 'created' is NOT handled here. `useCreateAccount` invalidates its own
  // queries, and the event exists for the walkthrough's advance-on-action step
  // (R5.5), not for cache work — invalidating again here would double every
  // account create for no gain.
  useEffect(() => {
    return eventBus.subscribe('accounts:cache-invalidate', ({ reason }) => {
      if (reason === 'created') return;
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['positions'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard', 'totals'] });
      queryClient.invalidateQueries({ queryKey: ['performance'] });
    });
  }, [queryClient]);

  useEffect(() => {
    // INVARIANT: the ledger has exactly two writers, and only one of them is a position
    // event. (1) closePosition's registered close/reverse hooks
    // (apps/api/src/features/accounting/ledger-hook.ts) — the branching below. Drafts/opens
    // cannot have ledger entries. Deleting a CLOSED position posts a reversing ledger row
    // that nets its realized P&L back out, so it moves the derived account balance and must
    // invalidate the balance-derived queries; fill mutations on closed positions are
    // API-rejected with ConflictError. (2) cash balance reconciliation (ledger-balances
    // Req 8) — NOT a position event, so it does not reach this bridge at all; it invalidates
    // the same balance-derived queries directly from `useReconcileBalance`. Any FURTHER
    // ledger-write path must either extend this branching (if it is a position event) or
    // invalidate ['accounts'] + ['dashboard','totals'] + ['ledger', accountId] itself.
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

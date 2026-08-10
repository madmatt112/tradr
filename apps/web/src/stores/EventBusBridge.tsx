import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { eventBus } from './event-bus.store';

export function EventBusBridge(): null {
  const queryClient = useQueryClient();

  // Sample data. Seeding and teardown each add or remove a whole account's
  // worth of positions, fills and ledger rows in a single call, so every derived
  // surface is stale at once and the user must not have to reload to see it. The
  // seeding hook publishes and knows none of these keys; this is the one place
  // that maps the announcement onto them.
  //
  // 'created' is NOT handled here. `useCreateAccount` invalidates its own
  // queries, and the event exists for the walkthrough's advance-on-action step,
  // not for cache work — invalidating again here would double every account
  // create for no gain.
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
    // INVARIANT: the ledger has exactly two writers. (1) the registered close/reverse AND
    // fill hooks (apps/api/src/features/accounting/ledger-hook.ts) — every position event
    // below that can move money. Both hooks post the same delta (cumulative realized P&L
    // minus what is already posted), so a fill realizes P&L the moment it is recorded, not
    // only when the position goes flat: a PARTIAL exit moves the derived account balance
    // with no close event to hang the refresh off. Drafts cannot have ledger entries.
    // (2) cash balance reconciliation (ledger-balances Req 8) — NOT a position event, so it
    // does not reach this bridge at all; it invalidates the same balance-derived queries
    // directly from `useReconcileBalance`. Any FURTHER ledger-write path must either extend
    // this branching (if it is a position event) or invalidate ['accounts'] +
    // ['dashboard','totals'] + ['ledger', accountId] itself.
    return eventBus.subscribe('positions:cache-invalidate', ({ reason }) => {
      switch (reason) {
        case 'closed':
        case 'reopened':
        case 'deleted':
        case 'fill-added':
        case 'fill-updated':
        case 'fill-deleted':
          // Every one of these moves the derived account balance, so all six invalidate the
          // same balance-derived queries. Closing posts realized P&L to the ledger;
          // reopening (R13) and deleting a closed position each post a reversing row that
          // nets it back out; and each fill mutation posts its own realized-P&L delta via
          // the fill hook — an edit or a delete reprices the whole position, so the delta
          // can go either way. A full exit and a partial exit have to refresh alike.
          // (An entry-only fill or a deleted draft moves no balance, but over-invalidating
          // there is cheap and keeps this correct without threading position status
          // through.)
          queryClient.invalidateQueries({ queryKey: ['accounts'] });
          queryClient.invalidateQueries({ queryKey: ['dashboard', 'totals'] });
          queryClient.invalidateQueries({ queryKey: ['performance'] });
          return;
        case 'opened':
        case 'updated':
          // Neither posts a ledger row: opening a draft realizes nothing, and 'updated' is
          // position metadata. Performance alone.
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

// useDemoAccount — the client half of the disposable sample account.
//
// WHICH ACCOUNT IS THE SAMPLE ONE IS READ, NEVER INFERRED. The account reads
// carry `isDemo`, and this hook keys off that flag alone. Sample and real data
// are mutually exclusive, so today the sample account is also the user's ONLY
// account — but that invariant is enforced on the server, in a different file,
// for a different reason, and a banner that quietly depended on it would start
// naming the wrong account the moment it moved. "Is there an account flagged as
// sample data" is the question being asked, so it is the question this asks.
//
// THE TWO WRITES ANNOUNCE, THEY DO NOT REACH. Seeding and teardown each add or
// remove a whole account's worth of positions, fills and ledger entries in one
// call, so the dashboard, the accounts list, the positions list and performance
// are all stale at once. This hook names none of their query keys: it publishes
// on the event bus and `EventBusBridge` maps that announcement onto them, which
// is how cross-feature invalidation works everywhere in this codebase. One
// publish, and a surface added later subscribes rather than waiting for this
// file to hear about it.

import { useMutation } from '@tanstack/react-query';
import { useCallback } from 'react';
import { toast } from 'sonner';

import type { Account } from '@tradr/shared';

import { useAccounts } from '@/features/accounts/hooks/useAccounts';
import { api } from '@/lib/api';
import { eventBus } from '@/stores/event-bus.store';

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'error' in err) {
    const e = err as { error?: { message?: string } };
    if (e.error?.message) return e.error.message;
  }
  return fallback;
}

export interface UseDemoAccountResult {
  /** Whether an account flagged as sample data exists. `false` until the read lands. */
  isDemoPresent: boolean;
  /** The sample account itself, or `undefined` — the id teardown needs. */
  demoAccount: Account | undefined;
  /** Seed the sample account. Refused server-side if the user already has one. */
  seed: () => void;
  /**
   * Remove the sample account and everything booked against it.
   *
   * `onSuccess` is how the create flow continues after the teardown it asked
   * for. With no sample data present there is nothing to remove and the
   * callback fires straight away — the caller's next step does not become
   * conditional on which state the user was in.
   *
   * `onError` is its mirror, for a caller holding UI open across the request:
   * the hook's own toast says what went wrong, but a caller that blocked
   * re-entry until the teardown settled needs to know that it just did.
   */
  teardown: (options?: { onSuccess?: () => void; onError?: () => void }) => void;
  /** A seed or a teardown is in flight. */
  isPending: boolean;
}

export function useDemoAccount(): UseDemoAccountResult {
  const accountsQuery = useAccounts();
  const demoAccount = accountsQuery.data?.find((account) => account.isDemo);

  const seedMutation = useMutation({
    // No body at all: which user, and what the fixture contains, are both the
    // server's to decide.
    mutationFn: () => api.post<Account>('/accounts/demo'),
    onSuccess: () => {
      eventBus.publish('accounts:cache-invalidate', { reason: 'demo-seeded' });
      toast.success('Sample data added');
    },
    onError: (err: unknown) => {
      toast.error(getErrorMessage(err, 'Failed to add sample data'));
    },
  });

  const teardownMutation = useMutation({
    // `cascade=demo` asks for the teardown; the server decides whether it is
    // allowed from the account's own stored flag, so this is a request and
    // never an authorisation. Repeating it is a silent success.
    mutationFn: (accountId: string) => api.delete(`/accounts/${accountId}?cascade=demo`),
    onSuccess: () => {
      eventBus.publish('accounts:cache-invalidate', { reason: 'demo-removed' });
      toast.success('Sample data removed');
    },
    onError: (err: unknown) => {
      toast.error(getErrorMessage(err, 'Failed to remove sample data'));
    },
  });

  const { mutate: seedMutate } = seedMutation;
  const seed = useCallback(() => {
    seedMutate();
  }, [seedMutate]);

  const demoAccountId = demoAccount?.id;
  const { mutate: teardownMutate } = teardownMutation;
  const teardown = useCallback(
    (options?: { onSuccess?: () => void; onError?: () => void }) => {
      if (!demoAccountId) {
        options?.onSuccess?.();
        return;
      }
      teardownMutate(demoAccountId, {
        onSuccess: () => options?.onSuccess?.(),
        onError: () => options?.onError?.(),
      });
    },
    [demoAccountId, teardownMutate],
  );

  return {
    isDemoPresent: demoAccount !== undefined,
    demoAccount,
    seed,
    teardown,
    isPending: seedMutation.isPending || teardownMutation.isPending,
  };
}

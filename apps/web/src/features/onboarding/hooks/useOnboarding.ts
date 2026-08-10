// useOnboarding — the one access point for onboarding state.
//
// It composes THREE reads: the accounts list, the positions list, and the
// stored onboarding preference. Per-item checklist completion is DERIVED from
// the first two and is never stored anywhere, which is exactly what makes the
// checklist resume across sessions and devices with no extra state. Nothing in
// this file — or downstream of it — may write progress to localStorage, Zustand
// or any other client store: the counts are the same counts on every device, so
// a cached copy could only ever disagree with them. Server data lives in
// TanStack Query and nowhere else — that is the rule across this codebase.
//
// THE PREFERENCE READ IS SPLIT OUT as `useOnboardingQuery()` deliberately. A
// consumer that needs only the status or the coach-mark seen set (the coach
// marks, mounted on ordinary working surfaces) should use that directly rather
// than this hook, which pulls the whole positions list down to count it.
//
// NOTHING IS REPORTED UNTIL ALL ENABLED READS HAVE LANDED. `checklist` is
// `undefined` while any of them is in flight, rather than a checklist derived
// from whichever counts have arrived so far. A partially-loaded derivation is
// not a slightly-early answer, it is a WRONG one: every count starts absent, so
// a fully set-up user would see four unticked boxes on every load and a
// checklist that has already retired would flash back into existence before
// vanishing again. `undefined` says "not known yet", which is the truth, and
// lets the consumer render a skeleton or nothing at all. The same gate covers
// terminal failure: on error the checklist stays `undefined` and `isError` is
// set, because an unticked box we cannot substantiate is worse than no box.
//
// THE TWO EXPENSIVE READS ARE GATED ON THE STORED STATUS. `GET /positions` has
// no LIMIT and returns every enriched row; running it on every dashboard mount
// for a user who will never see a checklist again is a cost with no possible
// payoff, and it grows with the account. So accounts and positions only fetch
// while the status is `pending` or `active` — the two states in which a
// checklist can still be shown. `done` is retirement, which by definition never
// reappears. `skipped` is a dismissal, which IS recoverable, and gating on it
// costs nothing precisely BECAUSE completion is derived and never stored:
// `setStatus('active')` seeds the new status into the cache, `checklistNeeded`
// flips on the same render, both reads fire, and the checklist comes back with
// real counts. There is no client-side progress that going quiet could have
// lost.
//
// The test is an ALLOWLIST, not `!== 'done' && !== 'skipped'`. The status is
// `undefined` until the preference read lands, and a denylist would read as
// "needed" during that window — firing both expensive reads on every mount for
// exactly the users this gate exists to spare. Waiting one round trip is the
// price, and it is why the preference read is the cheap one.
//
// FOR A GATED-OFF USER `checklist` IS `null`, NOT `undefined`. The two are
// different answers and a consumer must be able to tell them apart: `undefined`
// means "not known yet, ask again", `null` means "there is no checklist for
// this user". Collapsing both to `undefined` would leave a `done` user's
// consumer sitting on a skeleton forever, waiting for reads that are never
// going to happen.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { toast } from 'sonner';

import type { OnboardingPatch, OnboardingState, OnboardingStatus } from '@tradr/shared';

import { useAccounts } from '@/features/accounts/hooks/useAccounts';
import { usePositions } from '@/features/positions/hooks/usePositions';
import { api } from '@/lib/api';

import {
  armChecklistCompletion,
  reportChecklistCompletions,
  type ChecklistObservation,
} from '../lib/analytics';
import { deriveChecklist, type Checklist } from '../lib/derive-checklist';

/** [feature, scope, id] — the same shape as the other /users/me/* preferences. */
export const ONBOARDING_QUERY_KEY = ['users', 'me', 'onboarding'] as const;

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'error' in err) {
    const e = err as { error?: { message?: string } };
    if (e.error?.message) return e.error.message;
  }
  return fallback;
}

/**
 * The stored onboarding PREFERENCE — status, the coach marks already seen, and
 * the first-calculator-use timestamp. Never checklist progress.
 *
 * Always resolves: a row that predates the column stores `{}` and the server
 * parses it to `{ status: 'pending', coachMarksSeen: [] }`, with
 * `calculatorFirstUsedAt` ABSENT rather than null. Test it with `undefined`, not
 * `!== null`.
 */
export function useOnboardingQuery() {
  return useQuery<OnboardingState>({
    queryKey: ONBOARDING_QUERY_KEY,
    queryFn: () => api.get<OnboardingState>('/users/me/onboarding'),
  });
}

/**
 * The single write path: PATCH /api/users/me/onboarding with a PARTIAL body.
 *
 * The merge happens server-side in SQL, so a body naming only `status` does not
 * clear the coach marks and a key written by a newer deployment is not
 * destroyed. Never send the whole state object back — that is the shape that
 * loses data. `coachMarkSeen` is singular and names the operation (append one,
 * idempotently); the plural array is a 400.
 *
 * The 200 body is the merged state in the GET's shape, so it seeds the cache
 * directly — the UI settles without a round trip. The invalidate that follows
 * is not redundant: the response is only a snapshot of this request, and a
 * concurrent write from another tab can land immediately after it.
 *
 * `silent` suppresses the error toast, for the ONE write the user did not ask
 * for: the calculator recording `calculatorFirstUsedAt` behind a calculation
 * the user came for. Every other write is a direct response to a click, so its
 * failure is worth a toast; that one is fire-and-forget, and a toast on a
 * request the user never initiated is noise about a checklist tick. It cannot
 * be passed per-call — TanStack runs the mutation-level `onError` regardless of
 * what `mutate` is handed — so it belongs here.
 */
export function useOnboardingPatch(options?: { silent?: boolean }) {
  const silent = options?.silent ?? false;
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: OnboardingPatch) =>
      api.patch<OnboardingState>('/users/me/onboarding', patch),
    onSuccess: (state, sent) => {
      // Checklist item 2 is the one with no `cache-invalidate` behind it (the
      // calculator is stateless), so this write is the only signal that it was
      // just completed. Without it, a user who sizes a trade on /calculator
      // before ever opening the dashboard has that completion baselined away.
      // Sent exactly once, when the stored timestamp is absent.
      if (sent.calculatorFirstUsedAt !== undefined) armChecklistCompletion('calculator');
      queryClient.setQueryData(ONBOARDING_QUERY_KEY, state);
      queryClient.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY });
    },
    onError: (err: unknown) => {
      if (silent) return;
      // No success toast: the visible change — the checklist closing, the coach
      // mark going away — is the confirmation. A failure has no such tell.
      toast.error(getErrorMessage(err, 'Failed to save your onboarding preference'));
    },
  });
}

/**
 * The user's OWN rows: the sample account, and everything booked against it,
 * removed.
 *
 * NOTHING THE SEEDER WROTE COMPLETES ANYTHING, and this pair of filters is the
 * whole of that rule. Asking to see the product populated is not creating an
 * account, and it is not logging or closing a trade either: the fixture seeds
 * ten CLOSED positions, so counting them would tick "Log a position" and "Close
 * it and see the stats" the instant the user clicked "Add sample data" — telling
 * them they had recorded trades they never made, striking the two items through,
 * and taking away the guided-step buttons that would have taught them how.
 * Completion is grounded in the USER's actual data, and "any route to an item"
 * means routes the user takes, not a server-side fixture.
 *
 * Which rows are the demo's is READ FROM THE FLAG, never inferred from "there is
 * exactly one account" — the same rule `useDemoAccount` follows. Mutual
 * exclusion between sample and real data is enforced on the server, in another
 * file, for another reason, and a count that quietly leaned on it would start
 * believing the wrong thing the moment it moved. Positions carry `accountId`, so
 * the join is the flag on the account they are booked against and needs no extra
 * read.
 *
 * EXPORTED BECAUSE A SECOND CALLER ASKS THE SAME QUESTION. `useWalkthrough`
 * decides which per-item walkthrough buttons the checklist may offer, and a set
 * whose tour would run over sample rows completes nothing here — so it has to
 * mean by "the user's data" exactly what this means, from the same code rather
 * than from a second filter written the same way today. `deriveChecklist`
 * deliberately never learns that sample data exists, so this is where the rule
 * lives for everyone.
 *
 * Structurally typed on the two fields it reads, so a caller holding a narrower
 * row than `Account`/`Position` needs no cast.
 */
export function selectOwnRows<
  A extends { id: string; isDemo?: boolean },
  P extends { accountId: string },
>(accounts: A[], positions: P[]): { ownAccounts: A[]; ownPositions: P[] } {
  const demoAccountIds = new Set(
    accounts.filter((account) => account.isDemo).map((account) => account.id),
  );
  return {
    ownAccounts: accounts.filter((account) => !account.isDemo),
    ownPositions: positions.filter((position) => !demoAccountIds.has(position.accountId)),
  };
}

export interface UseOnboardingResult {
  /**
   * The derived checklist. Three distinct values, and a consumer must branch on
   * all three: a `Checklist` is the answer; `undefined` is "not known yet"
   * (a read is in flight, or one failed terminally — pair it with `isError`);
   * `null` is "this user has no checklist", because onboarding is `done` or
   * `skipped` and the reads it would need were never issued. Only `undefined`
   * ever resolves into a checklist on its own — treating `null` as a loading
   * state is a skeleton that never goes away.
   */
  checklist: Checklist | null | undefined;
  /** The stored preference, or `undefined` until its read lands. */
  preference: OnboardingState | undefined;
  /** A read the checklist still needs is in flight. Never true once `checklist` is `null`. */
  isLoading: boolean;
  /** One of the enabled reads failed terminally. */
  isError: boolean;
  /** A preference write is in flight. */
  isSaving: boolean;
  setStatus: (status: OnboardingStatus) => void;
  /**
   * Dismiss the checklist. Dismissal is only a status, which is what makes it
   * recoverable without support: `setStatus('active')` reopens it.
   */
  dismiss: () => void;
  /** Append one coach-mark key. Idempotent server-side, so callers need no membership check. */
  markCoachMarkSeen: (key: string) => void;
}

export function useOnboarding(): UseOnboardingResult {
  const preferenceQuery = useOnboardingQuery();
  const preferenceStatus = preferenceQuery.data?.status;
  // The allowlist described at the top of the file: only these two statuses can
  // still put a checklist on screen, so only they are worth paying for. Stays
  // false while the preference read is in flight, which is what keeps a `done`
  // user from issuing the reads speculatively on every single mount.
  const checklistNeeded = preferenceStatus === 'pending' || preferenceStatus === 'active';

  const accountsQuery = useAccounts({ enabled: checklistNeeded });
  // NO STATUS FILTER, AND THIS IS THE POINT. `positionsEverCreatedCount` means
  // every position the user has ever created, whatever state it is in now —
  // item 3 asks whether they have ever logged one, and that cannot become
  // untrue later. An open-only list would un-tick item 3 the moment the user
  // closed their last position, and a user who had closed everything could
  // never reach `allComplete`, so the checklist would never retire.
  // The closed count below is filtered from this same unfiltered list rather
  // than fetched as a second, status-filtered query: one request, and no second
  // count sitting around that could be passed to the wrong field. The gate on
  // the second argument decides WHETHER this request goes out, never WHAT it
  // asks for — the filters stay `undefined`.
  const positionsQuery = usePositions(undefined, { enabled: checklistNeeded });
  const patch = useOnboardingPatch();

  const accounts = accountsQuery.data;
  const positions = positionsQuery.data;
  const preference = preferenceQuery.data;

  // The checklist AND the counts it was derived from, in one pass. The
  // first-observation rule behind the completion events needs both, and needs
  // them to be of the same moment — see `ChecklistObservation`. Everything
  // below reads `checklist` off it.
  const observation = useMemo<ChecklistObservation | null | undefined>(() => {
    // Order matters. "Not known yet" has to be answered before "not needed":
    // until the preference lands we cannot tell a fresh user from a retired
    // one, and returning `null` there would claim the user has no checklist on
    // every first render.
    if (!preference) return undefined;
    if (!checklistNeeded) return null;
    if (!accounts || !positions) return undefined;
    // NOTHING THE SEEDER WROTE COMPLETES ANYTHING — `selectOwnRows` above is the
    // whole of that rule, and the reasoning for it lives there. With item 1
    // already excluded, `allComplete` cannot become true on seeded data alone,
    // so the checklist cannot retire itself over trades the user never made.
    const { ownAccounts, ownPositions } = selectOwnRows(accounts, positions);
    const counts = {
      account: ownAccounts.length,
      position: ownPositions.length,
      close: ownPositions.filter((p) => p.status === 'closed').length,
    };
    return {
      checklist: deriveChecklist({
        accountCount: counts.account,
        positionsEverCreatedCount: counts.position,
        closedPositionCount: counts.close,
        // Absent until the calculator is first used; the single named exception
        // to "completion is derived", because the calculator writes nothing else.
        calculatorFirstUsedAt: preference.calculatorFirstUsedAt,
      }),
      counts,
    };
  }, [accounts, positions, preference, checklistNeeded]);

  // `null` and `undefined` pass straight through: they are the two non-answers
  // the consumer has to be able to tell apart, and neither has counts.
  const checklist: Checklist | null | undefined = observation ? observation.checklist : observation;

  // One event per item as it BECOMES complete. The transition is worked out in
  // `lib/analytics.ts` against a module-scoped baseline rather than here,
  // because completion is derived from counts on every render and this hook is
  // mounted several times over on the same screen; a ref in this file
  // would report each completion once per mounted copy. An effect rather than a
  // render-time call, and idempotent either way — a second run over the same
  // checklist finds the baseline already moved and emits nothing.
  useEffect(() => {
    reportChecklistCompletions(observation);
  }, [observation]);

  const { mutate } = patch;
  const setStatus = useCallback(
    (status: OnboardingStatus) => {
      mutate({ status });
    },
    [mutate],
  );
  const dismiss = useCallback(() => {
    setStatus('skipped');
  }, [setStatus]);
  const markCoachMarkSeen = useCallback(
    (key: string) => {
      mutate({ coachMarkSeen: key });
    },
    [mutate],
  );

  // A disabled query is neither loading nor failed, so the gated-off reads drop
  // out of both of these on their own.
  const isError = accountsQuery.isError || positionsQuery.isError || preferenceQuery.isError;

  return {
    checklist,
    preference,
    // Stated against the ANSWER rather than by OR-ing the three queries, so the
    // pair is always coherent: `checklist === undefined` with `isError` false
    // means loading, full stop. OR-ing would report a false gap on the render
    // where the gate opens — the two reads are enabled but their fetches have
    // not been kicked off yet, so every `isLoading` is momentarily false while
    // the checklist is still `undefined`.
    isLoading:
      preferenceQuery.isLoading || (checklistNeeded && !isError && checklist === undefined),
    isError,
    isSaving: patch.isPending,
    setStatus,
    dismiss,
    markCoachMarkSeen,
  };
}

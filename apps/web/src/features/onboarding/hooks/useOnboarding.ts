// useOnboarding — the one access point for onboarding state (R4).
//
// It composes THREE reads: the accounts list, the positions list, and the
// stored onboarding preference. Per-item checklist completion is DERIVED from
// the first two (R4.2) and is never stored anywhere, which is exactly what
// makes the checklist resume across sessions and devices with no extra state
// (R4.4). Nothing in this file — or downstream of it — may write progress to
// localStorage, Zustand or any other client store: the counts are the same
// counts on every device, so a cached copy could only ever disagree with them.
// Server data lives in TanStack Query and nowhere else (structure.md, State
// Management Rules).
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
// checklist that has already retired (R4.7) would flash back into existence
// before vanishing again. `undefined` says "not known yet", which is the truth,
// and lets the consumer render a skeleton or nothing at all. The same gate
// covers terminal failure: on error the checklist stays `undefined` and
// `isError` is set, because an unticked box we cannot substantiate is worse
// than no box.
//
// THE TWO EXPENSIVE READS ARE GATED ON THE STORED STATUS. `GET /positions` has
// no LIMIT and returns every enriched row; running it on every dashboard mount
// for a user who will never see a checklist again is a cost with no possible
// payoff, and it grows with the account. So accounts and positions only fetch
// while the status is `pending` or `active` — the two states in which a
// checklist can still be shown. `done` is R4.7's retirement, which by
// definition never reappears. `skipped` is an R4.5 dismissal, which IS
// recoverable, and gating on it costs nothing precisely BECAUSE completion is
// derived and never stored (R4.2/R4.4): `setStatus('active')` seeds the new
// status into the cache, `checklistNeeded` flips on the same render, both reads
// fire, and the checklist comes back with real counts. There is no client-side
// progress that going quiet could have lost.
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
import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';

import type { OnboardingPatch, OnboardingState, OnboardingStatus } from '@tradr/shared';

import { useAccounts } from '@/features/accounts/hooks/useAccounts';
import { usePositions } from '@/features/positions/hooks/usePositions';
import { api } from '@/lib/api';

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
    onSuccess: (state) => {
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
   * Dismiss the checklist (R4.5). Dismissal is only a status, which is what
   * makes it recoverable without support: `setStatus('active')` reopens it.
   */
  dismiss: () => void;
  /** Append one coach-mark key (R7.2). Idempotent server-side, so callers need no membership check. */
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
  // never reach `allComplete`, so the checklist would never retire (R4.7).
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

  const checklist = useMemo(() => {
    // Order matters. "Not known yet" has to be answered before "not needed":
    // until the preference lands we cannot tell a fresh user from a retired
    // one, and returning `null` there would claim the user has no checklist on
    // every first render.
    if (!preference) return undefined;
    if (!checklistNeeded) return null;
    if (!accounts || !positions) return undefined;
    return deriveChecklist({
      // SAMPLE ACCOUNTS DO NOT COUNT, and the filter is the whole of R4.8.
      // Asking to see the product populated is not creating an account, so item
      // 1 stays incomplete while sample data is present — otherwise a user who
      // clicked "add sample data" would watch "Create a brokerage account" tick
      // itself for something they never did, and the checklist that is supposed
      // to survive the demo (R4.8) could retire while they still have no
      // account of their own. `deriveChecklist` deliberately never learns that
      // sample data exists, so this caller is the only place that can get it
      // right.
      accountCount: accounts.filter((account) => !account.isDemo).length,
      positionsEverCreatedCount: positions.length,
      closedPositionCount: positions.filter((p) => p.status === 'closed').length,
      // Absent until the calculator is first used; the single named exception
      // to "completion is derived", because the calculator writes nothing else.
      calculatorFirstUsedAt: preference.calculatorFirstUsedAt,
    });
  }, [accounts, positions, preference, checklistNeeded]);

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

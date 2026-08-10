// useUserTimezone — the one read of the user's STORED reporting timezone: the
// zone P&L is bucketed into by day, week and month. It is not a display format
// — nothing renders a timestamp in it. Every surface that buckets by day reads
// from here. Nothing outside `lib/browserTimezone.ts` may call
// Intl.DateTimeFormat().resolvedOptions().timeZone — a per-device guess is
// exactly what moves a trade between calendar days when the user opens Tradr
// from another machine.
//
// This is NOT the account trading-day timezone (accounts.timezone, default
// America/New_York because that is where the US venues run). The two have
// different defaults for different reasons and neither is derived from the
// other.
//
// NO CLIENT-SIDE DEFAULT ON THE SUCCESS PATH. GET /api/users/me/timezone always
// answers with a resolved zone — a NULL column (a row predating the migration)
// comes back as the server's DEFAULT_REPORTING_TIMEZONE, flagged `stored:
// false` — so a `?? 'UTC'` here would be a second source of truth that silently
// disagrees with the server the day that default changes. Until the query
// settles the value is `undefined`; consumers gate on it (`enabled:
// !!timezone`) rather than bucketing a figure by a zone the user never chose.
// The one exception is the ANNOUNCED degraded value below, which only applies
// once the read has failed outright and the user has been told.
//
// Shape mirrors useBuyingPowerBasisQuery (features/calculator/hooks): the same
// /api/users/me/<preference> endpoint convention, the same
// ['users', 'me', <preference>] query key.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

import { DEFAULT_REPORTING_TIMEZONE } from '@tradr/shared';

import { api } from '@/lib/api';
import { detectBrowserTimezone } from '@/lib/browserTimezone';

export interface UserTimezoneResponse {
  timezone: string;
  // False when the column is unset (a row predating the preference) and the
  // server substituted its default; true when the zone is the user's own. The
  // resolved zone alone cannot tell "never set" from "deliberately UTC", and
  // the backfill below turns on exactly that distinction.
  stored: boolean;
}

// One id, so the six consumers of useUserTimezone() that are mounted at once
// raise ONE notice between them rather than six stacked copies.
const FAILURE_TOAST_ID = 'reporting-timezone-unavailable';

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'error' in err) {
    const e = err as { error?: { message?: string } };
    if (e.error?.message) return e.error.message;
  }
  return fallback;
}

export function useUserTimezoneQuery() {
  return useQuery<UserTimezoneResponse>({
    queryKey: ['users', 'me', 'timezone'],
    queryFn: () => api.get<UserTimezoneResponse>('/users/me/timezone'),
    // Bounded, so a blip still self-heals but a real outage REACHES a terminal
    // state instead of retrying forever. The default policy would leave
    // `isError` false indefinitely, and every consumer below gates on the zone
    // — the whole app would sit on skeletons with nothing said to anyone.
    retry: 2,
  });
}

/**
 * The stored zone; `undefined` while the query is in flight.
 *
 * On TERMINAL failure it degrades to a browser-detected zone (the server
 * default only if even that is unavailable) and says so, with a retry. The
 * alternative — staying `undefined` — leaves all five bucketing surfaces on
 * permanent skeletons and the sidebar's Performance item permanently inert,
 * which is a worse outcome than figures cut in a zone the user can see named
 * and correct. This is not the client-side default the header rules out: it
 * never applies while the server is answering, it is announced rather than
 * silent, and its last resort is the SAME shared constant the server defaults
 * to, so there is still only one default in the system.
 */
export function useUserTimezone(): string | undefined {
  const { data, isError, refetch } = useUserTimezoneQuery();

  useEffect(() => {
    // The happy path must not touch the toaster at all.
    if (!isError) return;

    toast.error(
      `Couldn't load your reporting timezone. Figures are bucketed in ${degradedTimezone()} until it loads.`,
      {
        id: FAILURE_TOAST_ID,
        duration: Infinity,
        // Per-toast, NOT on the shared Toaster: this is the only notice in the
        // app that never expires, so it is the only one that needs a manual
        // way out. Turning `closeButton` on globally would put an X on every
        // transient success toast in the app to fix one permanent error one.
        closeButton: true,
        action: { label: 'Retry', onClick: () => void refetch() },
      },
    );

    // A `duration: Infinity` toast that nothing tears down outlives the tree
    // that raised it — after logout it sits on the login screen telling a
    // signed-out visitor about their bucketing. The cleanup covers BOTH exits:
    // recovery (`isError` goes false) and unmount (logout, or navigating away
    // from the surface). Dismissing is idempotent and the id is shared, so the
    // other consumers unmounting alongside this one cost nothing; a consumer
    // that outlives this one re-raises the notice the next time any consumer
    // mounts against the still-errored query.
    return () => {
      toast.dismiss(FAILURE_TOAST_ID);
    };
  }, [isError, refetch]);

  if (data) return data.timezone;
  return isError ? degradedTimezone() : undefined;
}

// The zone the user was already being bucketed by before this preference
// existed. Only ever reached with the preference read in a terminal error
// state, and only after the notice above has named it.
function degradedTimezone(): string {
  return detectBrowserTimezone() ?? DEFAULT_REPORTING_TIMEZONE;
}

/**
 * The ONE-TIME backfill of a pre-migration row. Mounted once, in the
 * authenticated layout.
 *
 * Every row that predates the column reads as the server default, `UTC` — but
 * before this preference existed those users were bucketed by their BROWSER
 * zone, so leaving them on UTC would silently move a New York trader's days by
 * four or five hours and shift trades across day boundaries. Resolving an unset
 * row must not change a user's historical bucketing by MORE than the per-device
 * behaviour already did, and that would. So the first authenticated load stores
 * the zone they were already using.
 *
 *   - At most once per user: `stored: false` is the trigger, and a successful
 *     write makes it true forever. The ref additionally holds it to one attempt
 *     per mount, so React's double-invoked effects cannot double-write.
 *   - Never overwrites a chosen zone: `stored: true` — including a deliberate
 *     `UTC` — returns immediately. This is the whole reason the flag exists.
 *   - Never blocks rendering: it is an effect that returns nothing and gates
 *     nothing; the layout paints whether or not it has run.
 *   - Harmless when it fails: the rejection is swallowed, the user is not
 *     told about a write they did not ask for, and the row simply stays unset
 *     for another attempt on a later load.
 *   - Sends nothing when detection yields nothing: the field is OMITTED (the
 *     write is skipped entirely) rather than sent as null, exactly as
 *     registration does — the server default already covers that case.
 */
export function useReportingTimezoneBackfill(): void {
  const { data } = useUserTimezoneQuery();
  const queryClient = useQueryClient();
  const attempted = useRef(false);

  useEffect(() => {
    if (!data || data.stored || attempted.current) return;

    const detected = detectBrowserTimezone();
    if (!detected) return;

    // Set BEFORE the await, or React's double-invoked effects race two writes.
    attempted.current = true;

    void api
      .put<UserTimezoneResponse>('/users/me/timezone', { timezone: detected })
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ['users', 'me', 'timezone'] });
        // Same reason as the mutation below: the bucketed figures carry the
        // zone inside their key, so the entries cut in the substituted default
        // have to go.
        queryClient.invalidateQueries({ queryKey: ['performance'] });
      })
      .catch(() => {
        // Deliberately silent. Nothing the user did failed, and the row is
        // still readable — it just keeps resolving to the default.
      });
  }, [data, queryClient]);
}

// Write the reporting timezone. Mirrors useBuyingPowerBasisMutation's shape —
// same PUT /api/users/me/<preference> convention, same toast handling.
//
// TWO invalidations, and the second one is not redundant. The preference key
// re-reads the stored zone, which is what every consumer of useUserTimezone()
// renders from. `['performance']` is invalidated because the five surfaces that
// bucket by this zone all read through usePerformance, whose key carries the
// zone inside its params — so a change lands on a NEW key and leaves the
// entries cut in the OLD zone sitting in the cache. Dropping them keeps a
// later revisit from painting figures bucketed in a zone the user has since
// left before the refetch arrives. Same direct-invalidation shape as
// useDisplayCurrencyMutation; the event bus is not used because this touches
// exactly one other prefix, not a fan-out across features.
export function useUserTimezoneMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (timezone: string) =>
      api.put<UserTimezoneResponse>('/users/me/timezone', { timezone }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users', 'me', 'timezone'] });
      queryClient.invalidateQueries({ queryKey: ['performance'] });
      toast.success('Reporting timezone updated');
    },
    onError: (err: unknown) => {
      toast.error(getErrorMessage(err, 'Failed to update reporting timezone'));
    },
  });
}

import { useMemo, useState } from 'react';

import { IANA_TIMEZONES, UserTimezoneSchema } from '@tradr/shared';

import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useUserTimezoneMutation, useUserTimezoneQuery } from '@/hooks/useUserTimezone';

/**
 * The user's reporting timezone (user-onboarding R2.6), viewable and changeable
 * from settings on its own, independent of onboarding.
 *
 * Lives in `components/` rather than a feature slice for the same reason
 * `hooks/useUserTimezone.ts` does: the zone is not owned by any one feature —
 * the dashboard widgets, the performance page and the position drawer all
 * bucket by it. Its two neighbours on this tab sit under the slice that owns
 * their endpoint (`accounting`, `calculator`); this preference has no such
 * slice.
 *
 * The copy carries R2.8. The two timezones in this product are different
 * quantities and neither is derived from the other, so the failure this
 * component has to prevent is a user setting one and believing they have set
 * the other.
 */
export function ReportingTimezoneSelect() {
  const { data, isLoading, isError, refetch } = useUserTimezoneQuery();
  const mutation = useUserTimezoneMutation();
  const [error, setError] = useState<string | null>(null);

  const selected = data?.timezone;

  // IANA_TIMEZONES is the PICKER list, not the set of valid zones:
  // `Intl.supportedValuesOf('timeZone')` omits every `Etc/*` entry and bare
  // `UTC`, all of which are real zones the server will happily store — and
  // `UTC` is the server's own default, so every row predating the column
  // resolves to a value this array does not contain. Without this the Select
  // would find no matching item and fall back to its placeholder, showing an
  // empty control to the user whose zone is the most common one of all.
  const options = useMemo(() => {
    if (!selected || IANA_TIMEZONES.includes(selected)) return IANA_TIMEZONES;
    return [selected, ...IANA_TIMEZONES];
  }, [selected]);

  function handleChange(value: string) {
    // The options are all resolvable, so this only fires if something else
    // put a value on the control. Validate with the same schema the PUT
    // validates against rather than sending a zone the server will reject.
    const parsed = UserTimezoneSchema.safeParse({ timezone: value });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Must be a valid IANA timezone name');
      return;
    }
    setError(null);
    mutation.mutate(parsed.data.timezone);
  }

  return (
    <div className="space-y-4 rounded-md border p-4">
      <div>
        <h2 className="text-lg font-semibold">Reporting timezone</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The zone your P&amp;L is bucketed into by day, week and month on your dashboard,
          performance page and position drawer. It follows you, so those figures stay the same
          wherever you open Tradr. Updating it re-cuts them.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="reportingTimezone">Reporting timezone</Label>
        {isLoading ? (
          <Skeleton className="h-9 w-64" />
        ) : (
          <Select value={selected} onValueChange={handleChange} disabled={mutation.isPending}>
            <SelectTrigger id="reportingTimezone" className="w-64 cursor-pointer">
              <SelectValue placeholder="Select a timezone" />
            </SelectTrigger>
            <SelectContent>
              {options.map((tz) => (
                <SelectItem key={tz} value={tz}>
                  {tz}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {/* The read failed after its retries. The control is left usable —
            a PUT may well succeed where the GET did not — but it shows its
            placeholder rather than a zone, because claiming a stored value we
            could not read would be the one thing worse than saying so. */}
        {isError && (
          <p className="text-sm text-destructive">
            Couldn&apos;t load your saved timezone.{' '}
            <button
              type="button"
              onClick={() => void refetch()}
              className="cursor-pointer underline"
            >
              Retry
            </button>
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <p className="text-sm text-muted-foreground">
          This is not an account&apos;s trading-day timezone. Each account carries its own separate
          timezone, which decides whether a position can be re-entered the same day and defaults to
          US Eastern because that is where NYSE, NASDAQ and NYSE Arca operate. Updating the zone
          here leaves every account&apos;s trading-day timezone untouched, and updating an
          account&apos;s leaves this one untouched — an account&apos;s timezone is edited on the
          account itself.
        </p>
      </div>
    </div>
  );
}

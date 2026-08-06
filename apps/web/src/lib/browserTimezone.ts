import { ReportingTimezoneField } from '@tradr/shared';

/**
 * The app's ONLY browser timezone detection (user-onboarding R2.2/R2.5). Every
 * render-time read of the reporting zone goes through `useUserTimezone`
 * instead, because a per-device guess is what moves a trade between calendar
 * days when the user opens Tradr elsewhere.
 *
 * It has exactly three callers, all of them writes or last resorts, never a
 * render-time bucketing input:
 *
 *  1. `routes/register.tsx` — seeds `users.timezone` at sign-up.
 *  2. `hooks/useUserTimezone.ts` — the ONE-TIME backfill of a pre-migration row
 *     (`stored: false`), which stores the very zone that user was already being
 *     bucketed by before the column existed.
 *  3. `hooks/useUserTimezone.ts` — the announced degraded value after the
 *     preference read has failed outright.
 *
 * `undefined` means OMIT THE FIELD, never send `timezone: null` —
 * `RegisterSchema.timezone` is optional but not nullable, so an explicit null
 * would 400 a registration with nothing wrong with it. There are two ways to
 * get there:
 *
 *  1. Intl is missing or throws (locked-down or exotic runtime).
 *  2. The browser reports a zone the server would reject — over 64 characters,
 *     or the `-u-` Unicode-extension form. That is checked HERE, with the same
 *     shared validator the API uses (`ReportingTimezoneField`), so an odd
 *     browser zone quietly falls back to the server default instead of making
 *     the person unable to create an account at all. A best-effort guess must
 *     never be the reason a signup fails; the zone is correctable in settings
 *     afterwards.
 */
export function detectBrowserTimezone(): string | undefined {
  let zone: string | undefined;
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
  if (!zone) return undefined;
  return ReportingTimezoneField.safeParse(zone).success ? zone : undefined;
}

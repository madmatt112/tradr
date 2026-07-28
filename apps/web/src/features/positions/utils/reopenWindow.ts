/**
 * R13 same-day reopen visibility: a closed position may be reopened only while
 * its openedAt still falls on the current trading day in the ACCOUNT's timezone
 * (never UTC — a US-Eastern evening session crosses UTC midnight but stays one
 * trading day). Compares the zone-local YYYY-MM-DD keys of openedAt and now via
 * Intl 'en-CA' (ISO order), mirroring the server's authoritative zonedDateKey.
 * Fallback: if the account timezone is somehow unavailable, show the action and
 * let the server's 409 surface as a toast rather than hiding a valid action.
 *
 * Shared by the detail header and the row action menus — the server stays
 * authoritative either way; this only governs whether the action is offered.
 */
export function isOpenedTodayInAccountTz(
  openedAt: string | null,
  accountTimezone: string | undefined,
  now: Date,
): boolean {
  if (!accountTimezone) return true;
  if (openedAt === null) return false;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: accountTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date(openedAt)) === fmt.format(now);
}

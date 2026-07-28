// Zone list for the account timezone picker, read from the runtime's own ICU
// data rather than hand-maintained (the tz database ships several releases a
// year — a checked-in list would rot).
//
// NOTE this is a *picker* list, not the validation set. Node 24's
// `Intl.supportedValuesOf('timeZone')` returns 418 primary zone identifiers and
// omits every `Etc/*` entry as well as bare `UTC` — all of which are genuine
// IANA zones. Validation therefore goes through `resolveTimezone` (see
// `schemas/account.ts`), which accepts anything Intl can resolve, so an API
// client may legitimately send a zone that does not appear in this array.
export const IANA_TIMEZONES: readonly string[] = Intl.supportedValuesOf('timeZone');

// Default account trading-day zone (position-lifecycle R1 amendment) — mirrors
// the `accounts.timezone` column default.
export const DEFAULT_ACCOUNT_TIMEZONE = 'America/New_York';

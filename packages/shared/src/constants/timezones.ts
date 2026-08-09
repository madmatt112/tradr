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

// Default user REPORTING zone. Used on two paths that must agree: the
// registration write when the client sends no browser-detected zone, and the
// read of a pre-migration NULL column.
//
// It is deliberately NOT `DEFAULT_ACCOUNT_TIMEZONE`. That one is
// 'America/New_York' because NYSE, NASDAQ and NYSE Arca run there, which says
// where the *market* is, not where the *person* is; the reporting zone follows
// the person, and neither zone is ever derived from the other. 'UTC' is also
// the fallback the six timezone-bucketing surfaces already use when `Intl`
// yields nothing, so a pre-migration row resolves to the value that path would
// have produced anyway rather than silently rebucketing that user's history.
// Any other zone would be an unfounded claim about the user's location.
export const DEFAULT_REPORTING_TIMEZONE = 'UTC';

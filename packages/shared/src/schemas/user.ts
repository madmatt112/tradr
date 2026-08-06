import { z } from 'zod';

import { resolveTimezone } from './performance';

// The user's REPORTING timezone (user-onboarding R2): the zone P&L is bucketed
// into by day, week and month. It follows the person, not the market. It is
// NOT a display format — nothing renders a timestamp in it.
//
// Deliberately NOT the same thing as `accounts.timezone`, which is the
// account's trading-day boundary and defaults to 'America/New_York' because
// that is where the US equity venues run. Neither is derived from the other
// (R2.7) — a user in Tokyo trading US equities correctly has an account
// timezone of America/New_York and a reporting timezone of Asia/Tokyo at the
// same time.
//
// Bounded to the users.timezone varchar(64) column, exactly as the account
// field is bounded to its own. Validation reuses `resolveTimezone` for the
// reasons set out at length in schemas/account.ts: Intl is the IANA authority,
// so there is no hand-maintained list to rot, and it already rejects the
// Unicode-extension bypass (`America/New_York-u-ca-japanese`) that Intl would
// otherwise silently strip. Deliberately NOT `IANA_TIMEZONES.includes(v)` —
// `Intl.supportedValuesOf('timeZone')` omits every `Etc/*` zone and bare
// `UTC`, which are real zones a client may legitimately send. That array is
// the picker's list, not the definition of validity.
export const ReportingTimezoneField = z
  .string()
  .max(64)
  .refine(
    (v) => {
      try {
        resolveTimezone(v);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Must be a valid IANA timezone name' },
  );

// Body for PUT /api/users/me/timezone (R2.6). Mirrors the established
// per-user-preference endpoint shape — `{ basis }` on
// /api/users/me/buying-power-basis — rather than inventing a new convention.
//
// Required here, unlike on RegisterSchema: an explicit preference write with
// no zone in it has no meaning. Clearing the preference is not offered, since
// a NULL column only ever means "predates the column" (R2.5).
export const UserTimezoneSchema = z.object({ timezone: ReportingTimezoneField });

export type UserTimezoneInput = z.infer<typeof UserTimezoneSchema>;

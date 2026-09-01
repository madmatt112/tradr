import { z } from 'zod';

import { CURRENCY_CODES } from '../constants/currencies';

import { resolveTimezone } from './performance';

// Starting balance: user-entered opening balance as a decimal string, bounded
// to the accounts.starting_balance numeric(18,4) column (≤14 integer digits,
// ≤4 fractional). Whitespace rejection via trim comparison mirrors
// schemas/accounting.ts `ledgerAmount` — Number("  50  ") passes a bounds
// check but new Decimal("  50  ") throws server-side.
const startingBalance = z.string().refine(
  (v) => {
    if (v.length === 0) return false;
    if (v !== v.trim()) return false;
    return /^\d{1,14}(\.\d{1,4})?$/.test(v);
  },
  { message: 'Must be a non-negative amount with up to 4 decimal places' },
);

// Account trading-day timezone (R1/R9 amendment 2026-07-19). Bounded to the
// accounts.timezone varchar(64) column; an unknown zone is a 400, never a
// silently-stored bad string. Unlike startingBalance this IS editable after
// creation: it changes only subsequent trading-day evaluations (R13) and
// rewrites no history.
//
// Validation reuses `resolveTimezone` — Intl is the IANA authority here, so
// there is no hand-maintained zone list to rot, and it already rejects the
// Unicode-extension bypass (`America/New_York-u-ca-japanese`) that Intl would
// otherwise silently strip. Deliberately NOT `IANA_TIMEZONES.includes(v)`:
// `Intl.supportedValuesOf('timeZone')` omits every `Etc/*` zone and bare
// `UTC`, which are real zones a client may legitimately send — that array is
// the picker's list, not the definition of validity.
const timezone = z
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

// Default risk percentage: the share of the account balance risked per trade,
// seeding the calculator's `riskPercent` input. Bounded to the
// accounts.default_risk_percent numeric(5,2) column (≤3 integer digits, ≤2
// fractional) AND to the 0–100 range the calculator's own `riskPercent`
// already uses (`positiveDecimal(100)`, schemas/calculator.ts). That module's
// helper is deliberately not reused: it bounds magnitude only and would accept
// `3.14159`, which the numeric(5,2) column would silently round. The
// whitespace rejection mirrors `startingBalance` above — Number("  3  ")
// passes a bounds check but new Decimal("  3  ") throws server-side.
//
// Unlike startingBalance this IS editable after creation (it appears in
// UpdateAccountSchema): it seeds a form field and rewrites no history.
//
// Strictly positive. Zero would mean "risk nothing on every trade", which is
// not a rule but the absence of one — and absence is already expressed by
// omitting the field entirely.
const defaultRiskPercent = z.string().refine(
  (v) => {
    if (v.length === 0) return false;
    if (v !== v.trim()) return false;
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(v)) return false;
    const n = Number(v);
    return n > 0 && n <= 100;
  },
  { message: 'Must be a percentage above 0 and up to 100, with at most 2 decimal places' },
);

export const CreateAccountSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  currency: z.enum(CURRENCY_CODES as [string, ...string[]]),
  brokerageId: z.string().uuid().nullable().optional(),
  // Optional — omitted means '0'. Creation-only: the derived balance is
  // startingBalance + SUM(ledger), so editing it later would silently move
  // every historical balance; deliberately absent from UpdateAccountSchema.
  startingBalance: startingBalance.optional(),
  // Optional — omitted falls back to the column default 'America/New_York'.
  timezone: timezone.optional(),
  // Optional — omitted means no rule is set, which preserves the calculator's
  // pre-existing behaviour exactly (empty field, user-supplied per calculation).
  defaultRiskPercent: defaultRiskPercent.optional(),
});

export const UpdateAccountSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  currency: z.enum(CURRENCY_CODES as [string, ...string[]]).optional(),
  brokerageId: z.string().uuid().nullable().optional(),
  timezone: timezone.optional(),
  // Nullable AND optional, and the two mean different things: omitted leaves
  // the stored value untouched (standard PATCH semantics), while an explicit
  // null clears the rule back to unset. Without the null case a user who set a
  // percentage could never remove it.
  defaultRiskPercent: defaultRiskPercent.nullable().optional(),
});

export const AccountSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  name: z.string(),
  currency: z.string(),
  timezone: z.string(),
  brokerageId: z.string().uuid().nullable(),
  brokerageName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Optional — populated by accounts LIST/GET once the ledger-balances spec
  // ships derived account balances. Kept optional so existing callers/tests
  // that construct accounts without a balance continue to parse.
  balance: z.string().optional(),
  // Null when no rule is set. `.optional()` as well as `.nullable()` for the
  // same reason as `balance` above — existing callers and test fixtures build
  // accounts without this field and must keep parsing.
  defaultRiskPercent: z.string().nullable().optional(),
  // The two halves of `balance` (ledger-balances Req 10), same optionality
  // rationale. `cash` is the deployable figure; `positionValue` is the cost
  // basis of open positions and is NEGATIVE for shorts, where the unexited size
  // is proceeds received against shares still owed. Cost basis only — neither
  // moves with the market. `cash + positionValue === balance` always.
  cash: z.string().optional(),
  positionValue: z.string().optional(),
  // True on the disposable sample account and on nothing else. Server-set and
  // read-only: it is absent from both CreateAccountSchema and
  // UpdateAccountSchema, so no request can claim it. `.optional()` for the same
  // reason as `balance` above — existing fixtures build accounts without it.
  isDemo: z.boolean().optional(),
  // True on the user's default account — the one pickers preselect — and on
  // exactly one account per user. Server-set and read-only like `isDemo`: the
  // first account created takes it, and `PUT /api/accounts/default` moves it.
  // `.optional()` for the same reason as `balance` above.
  isDefault: z.boolean().optional(),
});

// Body of PUT /api/accounts/default — mirrors SetWritableAccountSchema
// (schemas/tier.ts), but the default designation is an accounts concern, so it
// lives here.
export const SetDefaultAccountSchema = z.object({
  accountId: z.string().uuid(),
});

export type CreateAccountInput = z.infer<typeof CreateAccountSchema>;
export type UpdateAccountInput = z.infer<typeof UpdateAccountSchema>;
export type Account = z.infer<typeof AccountSchema>;
export type SetDefaultAccountInput = z.infer<typeof SetDefaultAccountSchema>;

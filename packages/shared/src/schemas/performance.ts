import { z } from 'zod';

import { CURRENCY_CODES } from '../constants/currencies';

// Resolves an IANA timezone via Intl. Rejects Unicode-extension-decorated IDs
// (e.g. `America/New_York-u-ca-japanese`) which Intl silently strips. Throws
// `Error('invalid_timezone')` on failure so callers can catch by message.
export function resolveTimezone(tz: string): string {
  if (tz.includes('-u-')) throw new Error('invalid_timezone');
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    throw new Error('invalid_timezone');
  }
}

export const GranularitySchema = z.enum(['day', 'week', 'month', 'year']);
export type Granularity = z.infer<typeof GranularitySchema>;

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

// Extracts the local wall-clock of a UTC instant in `tz` as "fake UTC" ms
// (i.e. `Date.UTC(year, month, day, hour, minute, second)` where year/…/second
// are what the clock reads in `tz` at the given instant). We use Intl directly
// because `date-fns-tz`'s `getTimezoneOffset(tz, date)` interprets `date`'s
// numeric fields as local time (useful for `fromZonedTime`, wrong for our
// "UTC instant → local" direction across DST transitions).
const LOCAL_DTF_CACHE = new Map<string, Intl.DateTimeFormat>();
function localMsInTz(utcDate: Date, tz: string): number {
  let dtf = LOCAL_DTF_CACHE.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    LOCAL_DTF_CACHE.set(tz, dtf);
  }
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const p of dtf.formatToParts(utcDate)) {
    if (p.type === 'year') year = Number(p.value);
    else if (p.type === 'month') month = Number(p.value);
    else if (p.type === 'day') day = Number(p.value);
    else if (p.type === 'hour') hour = Number(p.value);
    else if (p.type === 'minute') minute = Number(p.value);
    else if (p.type === 'second') second = Number(p.value);
  }
  // `hourCycle: 'h23'` is 0-23, but some ICU builds still emit "24" at local
  // midnight (a longstanding quirk). Treat 24 as 00 of the NEXT day via
  // Date.UTC's overflow semantics (passing day+1 rolls month/year correctly).
  if (hour === 24) {
    hour = 0;
    day += 1;
  }
  return Date.UTC(year, month - 1, day, hour, minute, second) + utcDate.getUTCMilliseconds();
}

// Arithmetic-only bucket count. Boundaries are local midnights (day), local
// Sun/Mon midnights (week), local first-of-month midnights (month), local
// Jan 1 midnights (year). Returns the number of buckets whose interval
// overlaps `[start, end)`, matching the oracle `for (cur=start; cur<end;
// cur=nextBoundary(cur)) n++`.
export function computeBucketCount(
  start: Date,
  end: Date,
  granularity: Granularity,
  tz: string,
  weekStartDay: 0 | 1 = 0,
): number {
  if (start.getTime() >= end.getTime()) return 0;

  const localStartMs = localMsInTz(start, tz);
  const localEndMs = localMsInTz(end, tz);

  if (granularity === 'day') {
    const firstBoundary = Math.floor(localStartMs / DAY_MS) * DAY_MS + DAY_MS;
    const lastBoundary = Math.ceil(localEndMs / DAY_MS - 1) * DAY_MS;
    if (firstBoundary > lastBoundary) return 1;
    return 2 + (lastBoundary - firstBoundary) / DAY_MS;
  }

  if (granularity === 'week') {
    // Jan 1 1970 UTC was Thursday; Jan 4 (Sun) = 3d, Jan 5 (Mon) = 4d.
    const weekEpochOffset = weekStartDay === 0 ? 3 * DAY_MS : 4 * DAY_MS;
    const adjStart = localStartMs - weekEpochOffset;
    const adjEnd = localEndMs - weekEpochOffset;
    const firstBoundary = Math.floor(adjStart / WEEK_MS) * WEEK_MS + WEEK_MS;
    const lastBoundary = Math.ceil(adjEnd / WEEK_MS - 1) * WEEK_MS;
    if (firstBoundary > lastBoundary) return 1;
    return 2 + (lastBoundary - firstBoundary) / WEEK_MS;
  }

  const localStart = new Date(localStartMs);
  const localEnd = new Date(localEndMs);
  const endIsFirstOfMonthMidnight =
    localEnd.getUTCDate() === 1 &&
    localEnd.getUTCHours() === 0 &&
    localEnd.getUTCMinutes() === 0 &&
    localEnd.getUTCSeconds() === 0 &&
    localEnd.getUTCMilliseconds() === 0;

  if (granularity === 'month') {
    const startYM = localStart.getUTCFullYear() * 12 + localStart.getUTCMonth();
    const endYM = localEnd.getUTCFullYear() * 12 + localEnd.getUTCMonth();
    const firstBoundary = startYM + 1;
    const lastBoundary = endIsFirstOfMonthMidnight ? endYM - 1 : endYM;
    if (firstBoundary > lastBoundary) return 1;
    return 2 + (lastBoundary - firstBoundary);
  }

  // year
  const endIsJan1Midnight = endIsFirstOfMonthMidnight && localEnd.getUTCMonth() === 0;
  const startYear = localStart.getUTCFullYear();
  const endYear = localEnd.getUTCFullYear();
  const firstBoundary = startYear + 1;
  const lastBoundary = endIsJan1Midnight ? endYear - 1 : endYear;
  if (firstBoundary > lastBoundary) return 1;
  return 2 + (lastBoundary - firstBoundary);
}

const decimalString = z.string().refine(
  (v) => {
    if (v.length === 0) return false;
    if (v !== v.trim()) return false;
    return /^-?\d+(\.\d+)?$/.test(v);
  },
  { message: 'Must be a decimal string' },
);

const percentRefinement = (n: number | null): boolean => {
  if (n === null) return true;
  if (!Number.isFinite(n)) return false;
  if (n < 0 || n > 100) return false;
  return Math.round(n * 10) / 10 === n;
};

const profitFactorRefinement = (n: number | null): boolean => {
  if (n === null) return true;
  if (!Number.isFinite(n)) return false;
  if (n < 0) return false;
  return Math.round(n * 100) / 100 === n;
};

export const SeriesBucketSchema = z.object({
  bucketStart: z.string(),
  netPnl: decimalString,
  grossPnl: decimalString,
  fees: decimalString,
  totalPositions: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  breakevens: z.number().int().nonnegative(),
});

export const EquityCurvePointSchema = z.object({
  bucketStart: z.string(),
  cumulativeNetPnl: decimalString,
});

export const PerformanceStatsSchema = z.object({
  totalPositions: z.number().int().nonnegative(),
  totalNetPnl: decimalString,
  winRate: z.number().nullable().refine(percentRefinement, {
    message: 'winRate must be null or a number in [0, 100] with at most 1 decimal place',
  }),
  breakevenRate: z.number().nullable().refine(percentRefinement, {
    message: 'breakevenRate must be null or a number in [0, 100] with at most 1 decimal place',
  }),
  avgWin: decimalString.nullable(),
  avgLoss: decimalString.nullable(),
  profitFactor: z.number().nullable().refine(profitFactorRefinement, {
    message: 'profitFactor must be null or a non-negative number with at most 2 decimal places',
  }),
  largestWin: decimalString.nullable(),
  largestLoss: decimalString.nullable(),
  hasWins: z.boolean(),
  hasLosses: z.boolean(),
});

export const PerformanceCurrencySchema = z.object({
  code: z.string(),
  historyRange: z.object({
    earliestClosedAt: z.string().nullable(),
    mostRecentClosedAt: z.string().nullable(),
    totalClosedPositions: z.number().int().nonnegative(),
  }),
  series: z.array(SeriesBucketSchema),
  equityCurve: z.array(EquityCurvePointSchema),
  stats: PerformanceStatsSchema,
});

export const PerformanceResponseSchema = z.object({
  resolvedTimezone: z.string(),
  resolvedWeekStartDay: z.union([z.literal(0), z.literal(1)]),
  dataQuality: z.object({
    timeframeExcluded: z.object({
      total: z.number().int().nonnegative(),
      unsupported: z.number().int().nonnegative(),
      mismatch: z.number().int().nonnegative(),
    }),
    historyExcluded: z.object({
      total: z.number().int().nonnegative(),
      closed_at_null: z.number().int().nonnegative(),
    }),
  }),
  hasAnyAccounts: z.boolean(),
  hasAnyClosedPositions: z.boolean(),
  hasAnyClosedPositionsInSupportedCurrency: z.boolean(),
  defaultCurrency: z.string().nullable(),
  currencies: z.array(PerformanceCurrencySchema),
  // Present only when the free-tier lookback floor clamped the requested
  // window (plan-tiers D13, REQ-7.1). Additive per the Shared Schema
  // Extension Policy.
  tierWindow: z
    .object({
      clamped: z.literal(true),
      effectiveStart: z.string().datetime(),
      lookbackMonths: z.number().int(),
    })
    .optional(),
});

const BUCKET_COUNT_CAP = 1095;
const MIN_START = new Date('2000-01-01T00:00:00.000Z');

export const PerformanceQuerySchema = z
  .object({
    granularity: GranularitySchema,
    start: z.string(),
    end: z.string(),
    tz: z.string().default('UTC'),
    currency: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    // 1. timezone — short-circuit with z.NEVER so later refinements don't run
    //    and return a noisy second issue against a broken tz.
    try {
      resolveTimezone(data.tz);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { code: 'INVALID_TIMEZONE' },
        message: `Invalid timezone: ${data.tz}`,
        path: ['tz'],
      });
      return z.NEVER;
    }

    // 2. ISO date parsing
    const start = new Date(data.start);
    const end = new Date(data.end);
    if (Number.isNaN(start.getTime())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { code: 'INVALID_DATE' },
        message: 'start must be a valid ISO date',
        path: ['start'],
      });
      return;
    }
    if (Number.isNaN(end.getTime())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { code: 'INVALID_DATE' },
        message: 'end must be a valid ISO date',
        path: ['end'],
      });
      return;
    }

    // 3. Date-range constraints — each a separate refinement so `details`
    //    names the failing constraint (not a bundled "date range invalid").
    let rangeHasError = false;
    if (start.getTime() >= end.getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { code: 'START_NOT_BEFORE_END' },
        message: 'start must be strictly before end',
        path: ['start'],
      });
      rangeHasError = true;
    }
    if (start.getTime() < MIN_START.getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { code: 'START_BEFORE_MIN' },
        message: 'start must be on or after 2000-01-01',
        path: ['start'],
      });
      rangeHasError = true;
    }
    // end <= today(tz) + 1 day — interpreted strictly: end must not be past
    // local midnight-of-tomorrow. `end` is an exclusive upper bound, so
    // end = start-of-tomorrow = today + 1 day is the maximum accepted value.
    const now = new Date();
    const nowLocalMs = localMsInTz(now, data.tz);
    const todayStartLocalMs = Math.floor(nowLocalMs / DAY_MS) * DAY_MS;
    const tomorrowStartLocalMs = todayStartLocalMs + DAY_MS;
    const endLocalMs = localMsInTz(end, data.tz);
    if (endLocalMs > tomorrowStartLocalMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { code: 'END_BEYOND_TODAY_PLUS_ONE' },
        message: 'end must be on or before (today + 1 day) in the provided tz',
        path: ['end'],
      });
      rangeHasError = true;
    }
    if (rangeHasError) return;

    // 4. Bucket count cap — arithmetic-only, O(1).
    const bucketCount = computeBucketCount(start, end, data.granularity, data.tz, 0);
    if (bucketCount > BUCKET_COUNT_CAP) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { code: 'BUCKET_COUNT_EXCEEDED', bucketCount },
        message: `Bucket count ${bucketCount} exceeds maximum ${BUCKET_COUNT_CAP}`,
        path: [],
      });
      return;
    }

    // 5. Currency whitelist (only when present).
    if (
      data.currency !== undefined &&
      !(CURRENCY_CODES as readonly string[]).includes(data.currency)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        params: { code: 'UNSUPPORTED_CURRENCY' },
        message: `Currency ${data.currency} is not in SUPPORTED_CURRENCIES`,
        path: ['currency'],
      });
    }
  });

export type PerformanceQueryInput = z.infer<typeof PerformanceQuerySchema>;
export type SeriesBucket = z.infer<typeof SeriesBucketSchema>;
export type EquityCurvePoint = z.infer<typeof EquityCurvePointSchema>;
export type PerformanceStats = z.infer<typeof PerformanceStatsSchema>;
export type PerformanceCurrency = z.infer<typeof PerformanceCurrencySchema>;
export type PerformanceResponse = z.infer<typeof PerformanceResponseSchema>;

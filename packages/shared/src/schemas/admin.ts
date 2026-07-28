import { z } from 'zod';

// Wire-side validation contract for the admin-platform feature.
//
// Per design.md §Component 9 (REQ-9.2, REQ-7.7). Shape only — consumed by both
// apps/api (response shaping + validation) and apps/web (hook return types),
// never redefined per app. No secret field (password hash, session token, key
// material) is representable in any schema here (REQ-3.6).
//
// All credit/token sums are bigint-bearing integer strings per the wallet.ts
// convention — never a float, so JSON cannot silently coerce to a lossy
// IEEE-754 number.

// Non-negative integer amount as a decimal string (bigint micro-USD / tokens).
const intString = z.string().regex(/^\d+$/, { message: 'Must be a non-negative integer string' });

// Signed integer amount as a decimal string (reversals are negative).
const signedIntString = z.string().regex(/^-?\d+$/, { message: 'Must be an integer string' });

const nonNegativeInt = z.number().int().nonnegative();

// --- GET /api/admin/stats -------------------------------------------------

export const AdminStatsSchema = z.object({
  totalUsers: nonNegativeInt,
  activeUsers: nonNegativeInt,
  // Pinned constant, serialized for honest labeling ("Active now (last 30 min)").
  // last_accessed is touched at most every 5 minutes, so the count lags real
  // activity by up to 5 minutes — never presented as a precise live count.
  activeUsersWindowMinutes: z.literal(30),
  positions: z.object({
    total: nonNegativeInt,
    draft: nonNegativeInt,
    open: nonNegativeInt,
    closed: nonNegativeInt,
  }),
  revenue: z.object({
    // micro-USD integer string: sum(credit)+sum(reversal) over wallet_transactions
    allTime: signedIntString,
    // micro-USD integer string, UTC month, reversal-attributed
    currentMonth: signedIntString,
    // Pinned literal — credits are micro-USD at the current 1:1 pack mapping.
    basis: z.literal('purchased-credit-volume'),
  }),
});
export type AdminStats = z.infer<typeof AdminStatsSchema>;

// --- GET /api/admin/users -------------------------------------------------

export const AdminUserListItemSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  isAdmin: z.boolean(),
  // Read-only verified signal (transactional-email REQ-5.7) — v1 gates nothing.
  emailVerified: z.boolean(),
  createdAt: z.string(),
  lastActiveAt: z
    .string()
    .nullable()
    .describe('Last recorded session activity — may be arbitrarily old'),
});
export type AdminUserListItem = z.infer<typeof AdminUserListItemSchema>;

export const AdminUserListResponseSchema = z.object({
  items: z.array(AdminUserListItemSchema),
  nextCursor: z.string().nullable(),
});
export type AdminUserListResponse = z.infer<typeof AdminUserListResponseSchema>;

// --- GET /api/admin/users/:id ----------------------------------------------

export const AdminUserDetailSchema = AdminUserListItemSchema.extend({
  positionCount: nonNegativeInt,
  // From advisor_turn_counters.turn_count — platform-key turns only from
  // plan-tiers on (REQ-8.3); BYOK turns are not counted.
  advisorTurns: nonNegativeInt.describe('Platform-key advisor turns (current UTC month)'),
  // All-time sums over usage_records, as integer strings.
  usage: z.object({
    inputTokens: intString,
    outputTokens: intString,
    billedCredits: intString,
  }),
  // micro-USD integer string; '0' when no wallet row.
  walletBalance: intString,
});
export type AdminUserDetail = z.infer<typeof AdminUserDetailSchema>;

// --- PATCH /api/admin/users/:id/admin ---------------------------------------

export const ToggleAdminRequestSchema = z.object({
  isAdmin: z.boolean(),
});
export type ToggleAdminRequest = z.infer<typeof ToggleAdminRequestSchema>;

// --- GET /api/admin/usage ----------------------------------------------------

const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

// Cross-field rules pinned here so API, schema, and tests agree (REQ-4.6):
// `from > to` is rejected (a naive range-length check alone would pass a
// negative range); `to − from > 366 days` is rejected (keeps every scan
// bounded); `from == to` and future ranges are valid.
export const AdminUsageQuerySchema = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .refine(({ from, to }) => !(from && to) || new Date(from).getTime() <= new Date(to).getTime(), {
    message: 'from must not be after to',
  })
  .refine(
    ({ from, to }) =>
      !(from && to) || new Date(to).getTime() - new Date(from).getTime() <= MAX_RANGE_MS,
    { message: 'Range must not exceed 366 days' },
  );
export type AdminUsageQuery = z.infer<typeof AdminUsageQuerySchema>;

export const AdminUsageSchema = z.object({
  period: z.object({ from: z.string(), to: z.string() }),
  totals: z.object({
    inputTokens: intString,
    outputTokens: intString,
    // sum(credit_cost) — as-charged, markup-inclusive (REQ-4.2).
    billedCredits: intString,
    // sum(raw_cost) over covered rows; null when zero covered rows. Pre-markup,
    // persisted at turn time — never derived from current config.
    providerCost: intString.nullable(),
    // Honesty: rows charged before migration 0013 have raw_cost = NULL.
    providerCostCoverage: z.object({
      records: nonNegativeInt,
      recordsWithRawCost: nonNegativeInt,
    }),
  }),
  // UTC day buckets.
  series: z.array(
    z.object({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Must be a YYYY-MM-DD UTC day' }),
      billedCredits: intString,
      inputTokens: intString,
      outputTokens: intString,
    }),
  ),
  // Top 50 by billedCredits.
  topUsers: z
    .array(
      z.object({
        userId: z.string().uuid(),
        email: z.string().email(),
        billedCredits: intString,
        inputTokens: intString,
        outputTokens: intString,
        turns: nonNegativeInt,
      }),
    )
    .max(50),
  // Period revenue, reversal-attributed (reversals are negative).
  revenue: z.object({
    credited: intString,
    reversed: signedIntString,
    net: signedIntString,
  }),
});
export type AdminUsage = z.infer<typeof AdminUsageSchema>;

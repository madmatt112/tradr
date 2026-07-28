import {
  AdminUsageQuerySchema,
  type AdminStats,
  type AdminUsage,
  type AdminUserDetail,
  type AdminUserListResponse,
} from '@tradr/shared';

import { db } from '@/db';
import { config } from '@/lib/config';
import { AppError, InvariantViolationError, NotFoundError, ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { withTransaction } from '@/lib/transaction';

import {
  countActiveUsersNow,
  countAdmins,
  countAllPositionsByStatus,
  countAllUsers,
  decodeAdminUserCursor,
  insertAdminAuditEntry,
  promoteUserByEmail,
  selectAdminIdsForUpdate,
  selectAdminUserById,
  selectAllUsersPage,
  selectTopUsersByBilledCredits,
  selectUsageDaySeries,
  selectUserDetailAggregates,
  selectUserEmailById,
  selectUserFlagForUpdate,
  selectUserForAdminToggle,
  sumAllTimeRevenue,
  sumPeriodRevenue,
  sumUsageTotals,
  updateUserIsAdmin,
  type AdminToggleTarget,
} from './admin.query';

// ---------------------------------------------------------------------------
// Admin services (admin-platform design Components 2, 3 & 5). Thin
// orchestration from the admin.query.ts system queries to the shared wire
// contracts (packages/shared/src/schemas/admin.ts), plus the spec's single
// write: toggleAdmin (race-safe last-admin guard + audit).
//
// All bigint sums are serialized as decimal integer strings — never JS
// floats. Empty/unconfigured instances return well-formed zeros, never
// errors (REQ-2.7, REQ-4.6, REQ-8.3). Services receive userId/params from
// the route — they never extract them from a request.
// ---------------------------------------------------------------------------

/** User-list page-size bounds (design Component 3). */
const DEFAULT_USERS_LIMIT = 25;
const MAX_USERS_LIMIT = 100;

/** Default usage window: trailing 30 days ending now (design Component 5). */
const DEFAULT_USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Platform statistics (REQ-2, REQ-4.4): five aggregate reads via
 * `Promise.all` on the shared `db` — deliberately NO transaction (each is a
 * single statement; the dashboard is a monitoring view, cross-metric snapshot
 * consistency is not promised). `revenue.currentMonth` is the
 * reversal-attributed `sumPeriodRevenue` evaluated over the current UTC
 * calendar month (month start → now) — NEVER a naive in-month credit sum, so
 * a refund this month of a prior-month purchase reduces the prior month's
 * net, leaving `currentMonth` untouched (REQ-4.4).
 */
export async function getPlatformStats(): Promise<AdminStats> {
  const now = new Date();
  const monthStartUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [totalUsers, activeUsers, positions, allTimeRevenue, currentMonthRevenue] =
    await Promise.all([
      countAllUsers(db),
      countActiveUsersNow(db),
      countAllPositionsByStatus(db),
      sumAllTimeRevenue(db),
      sumPeriodRevenue(db, monthStartUtc, now),
    ]);
  return {
    totalUsers,
    activeUsers,
    // Pinned constant — serialized for honest "Active now (last 30 min)" labeling.
    activeUsersWindowMinutes: 30,
    positions,
    revenue: {
      allTime: allTimeRevenue.toString(),
      currentMonth: currentMonthRevenue.net.toString(),
      // Pinned literal — credits are micro-USD at the current 1:1 pack mapping.
      basis: 'purchased-credit-volume',
    },
  };
}

/**
 * Cursor-paginated user list (REQ-3.1), newest-first. Default limit 25, max
 * 100. A missing/malformed cursor yields the first page (the wallet-history
 * convention — the query layer's decode returns null on garbage).
 */
export async function listUsers(cursor?: string, limit?: number): Promise<AdminUserListResponse> {
  const pageSize = Math.min(Math.max(Math.trunc(limit ?? DEFAULT_USERS_LIMIT), 1), MAX_USERS_LIMIT);
  const decoded = cursor ? decodeAdminUserCursor(cursor) : null;
  return selectAllUsersPage(db, decoded, pageSize);
}

/**
 * Per-user admin detail (REQ-3.2): list fields + position count, current
 * UTC-month advisor turns, all-time usage sums, and wallet balance ('0' when
 * no wallet row). 404 `NotFoundError` for an unknown id.
 */
export async function getUserDetail(userId: string): Promise<AdminUserDetail> {
  const row = await selectAdminUserById(db, userId);
  if (!row) throw new NotFoundError('User', userId);
  const aggregates = await selectUserDetailAggregates(db, userId);
  return {
    ...row,
    positionCount: aggregates.positionCount,
    advisorTurns: aggregates.advisorTurns,
    usage: {
      inputTokens: aggregates.usage.inputTokens.toString(),
      outputTokens: aggregates.usage.outputTokens.toString(),
      billedCredits: aggregates.usage.billedCredits.toString(),
    },
    walletBalance: aggregates.walletBalance.toString(),
  };
}

/**
 * Toggle a user's admin flag (REQ-3.3/3.4/3.5) — the spec's single write,
 * design Component 3 verbatim. All decisions are made POST-LOCK inside one
 * `withTransaction`, so concurrent same-target toggles cannot write duplicate
 * audit rows and the instance can never reach zero admins through the API.
 *
 * - Promotion locks ONLY the target row; already-admin ⇒ 200 no-op (no
 *   update, no audit row).
 * - Demotion locks the current admin set (`FOR UPDATE` re-evaluates
 *   `is_admin = true` on lock-wait via EvalPlanQual, so a concurrently
 *   demoted row drops out): target absent from the locked set ⇒ no-op;
 *   `adminIds.length <= 1` ⇒ `409/'LAST_ADMIN'`. Self-demotion is permitted
 *   when not the last admin. The bare conditional `UPDATE` is NOT used.
 * - Lock-order note: the tx touches only `users` rows + an
 *   `admin_audit_log` INSERT — disjoint from the close-flow/wallet lock
 *   enumerations, no AB/BA pair. The rare same-set deadlock abort under
 *   divergent plan lock order is accepted — no retry machinery.
 */
export async function toggleAdmin(
  actorId: string,
  targetId: string,
  nextValue: boolean,
): Promise<AdminToggleTarget> {
  return withTransaction(db, async (tx) => {
    // Actor email for the audit snapshot — resolved INSIDE the tx via an
    // explicit-column PK read; authMiddleware exposes only userId/isAdmin on
    // context, not email. A missing actor row aborts the toggle (unreachable
    // today: no user-deletion path exists; pinned so the wire shape is
    // designed, not improvised).
    const actorEmail = await selectUserEmailById(tx, actorId);
    if (actorEmail === null) {
      throw new InvariantViolationError(`Toggle actor ${actorId} has no user row`);
    }
    // Explicit columns, unlocked: the 404 feeder + target-email snapshot only.
    const target = await selectUserForAdminToggle(tx, targetId);
    if (!target) throw new NotFoundError('User', targetId);
    if (nextValue) {
      // Promotion: lock ONLY the target row, then decide no-op post-lock.
      const locked = await selectUserFlagForUpdate(tx, targetId);
      // The target existed unlocked above and no deletion path exists today —
      // a vanished row under lock is the same pinned invariant breach.
      if (!locked) throw new InvariantViolationError(`Toggle target ${targetId} vanished`);
      if (locked.isAdmin) return { ...target, isAdmin: true }; // post-lock no-op: 200, NO update, NO audit row
    } else {
      // Demotion: lock the current admin set (which includes the target while
      // it is still an admin). FOR UPDATE re-evaluates the predicate on
      // lock-wait (EvalPlanQual), so a row demoted by a concurrent committed
      // tx drops out — the race-safe last-admin guard.
      const adminIds = await selectAdminIdsForUpdate(tx);
      if (!adminIds.includes(targetId)) return { ...target, isAdmin: false }; // concurrently demoted ⇒ post-lock no-op, NO audit
      if (adminIds.length <= 1) {
        throw new AppError(409, 'LAST_ADMIN', 'Cannot remove the last admin');
      }
    }
    const updated = await updateUserIsAdmin(tx, targetId, nextValue);
    await insertAdminAuditEntry(tx, {
      action: 'admin_toggle',
      actorUserId: actorId,
      actorEmail,
      targetUserId: targetId,
      targetEmail: target.email,
      oldValue: !nextValue,
      newValue: nextValue, // post-lock state: the transition is real by construction
    });
    return updated;
  });
}

/**
 * First-admin bootstrap (REQ-8.4, design Component 10), called once at API
 * startup after migrations. Promotes `SEED_ADMIN_EMAIL` ONLY when the
 * instance has zero admins — a bootstrap mechanism, not a standing override:
 * a deliberately demoted user is never silently re-promoted. The config
 * chain already trimmed/lowercased the email (registration stores
 * lowercase). One COUNT, at most one UPDATE. The never-fatal try/catch
 * lives at the call site in the entrypoint.
 */
export async function bootstrapFirstAdmin(): Promise<void> {
  if (!config.SEED_ADMIN_EMAIL) return;
  const adminCount = await countAdmins(db);
  if (adminCount > 0) return; // never re-promotes a deliberately demoted user
  const promoted = await promoteUserByEmail(db, config.SEED_ADMIN_EMAIL);
  if (promoted) {
    logger.warn('First admin bootstrapped', { email: config.SEED_ADMIN_EMAIL });
  } else {
    logger.warn(
      'SEED_ADMIN_EMAIL set but no matching user registered yet — register, then restart',
    );
  }
}

/**
 * Validate a usage query against the shared `AdminUsageQuerySchema`, mapping
 * refine failures to the `400/'VALIDATION_ERROR'` path (REQ-4.6).
 */
function validateUsageQuery(query: { from?: string; to?: string }): void {
  const parsed = AdminUsageQuerySchema.safeParse(query);
  if (!parsed.success) {
    const details: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      details[issue.path.join('.') || '_root'] = issue.message;
    }
    throw new ValidationError('Validation failed', details);
  }
}

/**
 * Platform usage & revenue over `[from, to)` (REQ-4.1–4.6). Defaults to the
 * trailing 30 days ending now. The shared `AdminUsageQuerySchema` cross-field
 * refines reject `from > to` and >366-day ranges with `400/'VALIDATION_ERROR'`;
 * because those refines only fire when both bounds are present, the effective
 * pair (after defaulting) is re-validated through the same schema so a
 * `from`-only request cannot bypass the 366-day cap. `from == to` and future
 * ranges return well-formed zeros. `providerCost` is `null` when zero covered
 * rows (pre-0013 rows have `raw_cost = NULL`); period revenue is
 * reversal-attributed (REQ-4.4).
 */
export async function getUsage(from?: string, to?: string): Promise<AdminUsage> {
  validateUsageQuery({ from, to });
  const toDate = to ? new Date(to) : new Date();
  const fromDate = from ? new Date(from) : new Date(toDate.getTime() - DEFAULT_USAGE_WINDOW_MS);
  validateUsageQuery({ from: fromDate.toISOString(), to: toDate.toISOString() });
  const [totals, series, topUsers, revenue] = await Promise.all([
    sumUsageTotals(db, fromDate, toDate),
    selectUsageDaySeries(db, fromDate, toDate),
    selectTopUsersByBilledCredits(db, fromDate, toDate),
    sumPeriodRevenue(db, fromDate, toDate),
  ]);
  return {
    period: { from: fromDate.toISOString(), to: toDate.toISOString() },
    totals: {
      inputTokens: totals.inputTokens.toString(),
      outputTokens: totals.outputTokens.toString(),
      billedCredits: totals.billedCredits.toString(),
      providerCost: totals.providerCost !== null ? totals.providerCost.toString() : null,
      providerCostCoverage: totals.coverage,
    },
    series: series.map((bucket) => ({
      day: bucket.day,
      billedCredits: bucket.billedCredits.toString(),
      inputTokens: bucket.inputTokens.toString(),
      outputTokens: bucket.outputTokens.toString(),
    })),
    topUsers: topUsers.map((user) => ({
      userId: user.userId,
      email: user.email,
      billedCredits: user.billedCredits.toString(),
      inputTokens: user.inputTokens.toString(),
      outputTokens: user.outputTokens.toString(),
      turns: user.turns,
    })),
    revenue: {
      credited: revenue.credited.toString(),
      reversed: revenue.reversed.toString(),
      net: revenue.net.toString(),
    },
  };
}

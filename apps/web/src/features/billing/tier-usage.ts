// Pure plan-tier usage helpers for the disclosure surfaces (plan-tiers design
// Component 12; REQ-8.9, REQ-11.6). Deliberately hook-free with a type-only
// import so presentational components (the advisor Composer) can consume them
// without pulling in the query client or api layer.

import type { TierState } from '@tradr/shared';

/**
 * True when the user has free platform-turn headroom this month (REQ-8.9).
 * Requires populated usage (gating on, non-exempt, tier query resolved) — the
 * unknown states (self-host, admin, tier query in flight) count as NO headroom
 * so allowance marking/preselect/ordering stay inert (self-host parity).
 */
export function hasAllowanceHeadroom(tier: TierState | undefined): boolean {
  if (!tier?.usage) return false;
  const cap = tier.limits[tier.tier].platformTurns;
  return cap === null || tier.usage.platformTurns.allowanceUsed < cap;
}

/**
 * Remaining count once consumption crosses the ≥80% disclosure threshold
 * (REQ-11.6 working default): returns `max(0, cap - used)` when
 * `used >= 0.8 * cap`, else null (below the threshold, unlimited/unknown cap,
 * or unknown usage — no hint).
 */
export function approachingRemaining(
  used: number | undefined,
  cap: number | null | undefined,
): number | null {
  if (used === undefined || cap === null || cap === undefined || cap <= 0) return null;
  if (used < 0.8 * cap) return null;
  return Math.max(0, cap - used);
}

/**
 * True when the L1 writability restriction is active (D18/REQ-6.6): the user
 * is over the account cap on an enforced free tier. `usage` is populated only
 * when gating is on and the user is non-exempt, so its presence carries the
 * "gated" leg; the unknown states (self-host, admin, tier query in flight)
 * count as unrestricted — pickers stay fully enabled (self-host parity).
 */
export function writabilityRestricted(tier: TierState | undefined): boolean {
  if (!tier?.usage || tier.tier !== 'free') return false;
  const cap = tier.limits[tier.tier].accounts;
  return cap !== null && tier.usage.accounts.used > cap;
}

/**
 * Whether new positions can target this account (D18): every account is
 * writable unless the restriction is active, in which case only the
 * designated `usage.accounts.writableAccountId` accepts new positions.
 * Pickers disable/badge the rest instead of inviting 403s.
 */
export function isAccountWritable(tier: TierState | undefined, accountId: string): boolean {
  if (!writabilityRestricted(tier)) return true;
  return accountId === tier?.usage?.accounts.writableAccountId;
}

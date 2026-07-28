import type { Tier, TierLimits, TierState } from '@tradr/shared';

import type { Database, Transaction } from '@/db';
import { countAccountsByUser, resolveWritableAccountId } from '@/features/accounts/accounts.query';
import { getAllowanceUsage, getImageCount } from '@/features/admin/gating.query';
import { selectCsvImportCount } from '@/features/csv-import/csv-import.query';
import { countPositionsByUser } from '@/features/positions/positions.query';
import {
  isFeatureGatingEnabled,
  isProSubscriptionConfigured,
  isStripeConfigured,
} from '@/lib/config';

import { selectSubscriptionsByUser } from './subscription.query';
import type { SubscriptionRow } from './subscription.query';
import {
  ACTIVE_PERIOD_SLACK_MS,
  getTierLimits,
  PAST_DUE_HORIZON_MS,
  PERIOD_KEY,
} from './tier-limits.constants';

// ---------------------------------------------------------------------------
// Tier resolver (plan-tiers design D3 / Component 2) — the ONE home every
// enforcement point imports (NFR). Pure derivation over the local mirror; no
// Stripe call, no memo layer (one indexed read per request is the budget).
// ---------------------------------------------------------------------------

/**
 * Per-row qualifying predicate — REQ-1.3's total mapping with REQ-1.4's two
 * bounds. Exported because D7's duplicate reconciliation is defined over
 * "rows that currently qualify" per exactly this predicate.
 *
 * - `active`/`trialing` ⇒ qualifies while `now ≤ current_period_end +
 *   ACTIVE_PERIOD_SLACK_MS`. `cancel_at_period_end` plays no part: Stripe
 *   keeps `status: 'active'` until period end, so a canceled-pending row
 *   keeps Pro until then and lapses naturally.
 * - `past_due` ⇒ qualifies while `now ≤ entered_past_due_at +
 *   PAST_DUE_HORIZON_MS`. A NULL anchor is treated as EXPIRED — the
 *   default-deny backstop (D6's anchor maintenance guarantees a mirrored
 *   `past_due` transition always sets the anchor; this branch only exists so
 *   a corrupt row fails closed, never open).
 * - Everything else — `canceled`, `unpaid`, `incomplete`,
 *   `incomplete_expired`, `paused`, and ANY unknown future status — does not
 *   qualify. The mirror stores the raw status with no CHECK precisely so this
 *   default-deny keeps the mapping total.
 */
export function subscriptionQualifies(row: SubscriptionRow, now: Date): boolean {
  if (row.status === 'active' || row.status === 'trialing') {
    return now.getTime() <= row.currentPeriodEnd.getTime() + ACTIVE_PERIOD_SLACK_MS;
  }
  if (row.status === 'past_due') {
    if (row.enteredPastDueAt === null) return false; // null anchor ⇒ expired (backstop)
    return now.getTime() <= row.enteredPastDueAt.getTime() + PAST_DUE_HORIZON_MS;
  }
  return false; // default-deny: every other and every unknown status
}

/**
 * D3's single authoritative total order — ascending
 * `(stripe_created_at, stripe_subscription_id)`. The id tiebreak is
 * load-bearing, not cosmetic: Stripe's `created` has SECOND granularity, so a
 * double-subscribe race can create both subscriptions in the same epoch
 * second — without a total order, two reconciliation runs could each pick a
 * different survivor and cancel+refund BOTH. Everywhere this spec says
 * "earliest-created" (the resolver here, D7's survivor, D16's display row) it
 * means THIS order.
 */
export function compareSubscriptionOrder(a: SubscriptionRow, b: SubscriptionRow): number {
  const at = a.stripeCreatedAt.getTime();
  const bt = b.stripeCreatedAt.getTime();
  if (at !== bt) return at - bt;
  if (a.stripeSubscriptionId < b.stripeSubscriptionId) return -1;
  if (a.stripeSubscriptionId > b.stripeSubscriptionId) return 1;
  return 0;
}

export interface DerivedTier {
  tier: Tier;
  /** The single row entitlement and display derive from (REQ-1.5), or null. */
  qualifying: SubscriptionRow | null;
}

/**
 * Pure, TOTAL tier derivation (REQ-1.3/1.4/1.5): any qualifying row ⇒ `pro`;
 * none ⇒ `free`. Among multiple qualifying rows the earliest-created wins per
 * `compareSubscriptionOrder`. Never throws, never mutates `rows`.
 */
export function deriveTier(rows: SubscriptionRow[], now: Date): DerivedTier {
  let earliest: SubscriptionRow | null = null;
  for (const row of rows) {
    if (!subscriptionQualifies(row, now)) continue;
    if (earliest === null || compareSubscriptionOrder(row, earliest) < 0) earliest = row;
  }
  return earliest === null
    ? { tier: 'free', qualifying: null }
    : { tier: 'pro', qualifying: earliest };
}

/**
 * One indexed `SELECT … WHERE user_id = $1` + derive (D3). No Stripe call, no
 * memo — each enforcement point performs at most one such read per request.
 */
export async function resolveTier(
  db: Database | Transaction,
  userId: string,
): Promise<DerivedTier> {
  const rows = await selectSubscriptionsByUser(db, userId);
  return deriveTier(rows, new Date());
}

export type TierContext = { enforced: false } | { enforced: true; tier: Tier; limits: TierLimits };

/**
 * The enforcement-point entry (D9): `{ enforced: false }` when gating is off
 * or the user is an admin — the transparent pass-through doctrine carried
 * over from the retired `advisorTurnGate` middleware (`feature-gate.middleware.ts`,
 * deleted in Task 13; REQ-1.6, REQ-6.7) — else the resolved tier plus its
 * call-time limits. The pass-through branch performs NO database read.
 */
export async function getTierContext(
  db: Database | Transaction,
  args: { userId: string; isAdmin: boolean },
): Promise<TierContext> {
  if (!isFeatureGatingEnabled() || args.isAdmin) return { enforced: false };
  const { tier } = await resolveTier(db, args.userId);
  return { enforced: true, tier, limits: getTierLimits(tier) };
}

// ---------------------------------------------------------------------------
// Tier-state assembly for GET /api/billing/tier (design D16 / Component 6).
// ---------------------------------------------------------------------------

/**
 * D16's terminal set: a mirror row in these statuses is a dead end and never
 * renders. Everything else — including `unpaid` and a lapsed `active` — is
 * NON-terminal: it no longer confers Pro past the D3 bounds, but may still be
 * a live recurring charge, so it must keep rendering with its Portal link
 * (the failure REQ-11.7's carve-out exists to prevent).
 */
export const TERMINAL_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  'canceled',
  'incomplete_expired',
]);

/**
 * D16's pinned display-row rule, QUALIFYING-FIRST: the earliest-created
 * qualifying row when one exists (D3's total order — literally the D7
 * reconciliation survivor), ELSE the earliest-created non-terminal row, else
 * null. The fallback engages only when nothing qualifies: a re-subscribed Pro
 * user (dead `unpaid` row + live `active` row) sees the live subscription,
 * never the zombie.
 */
export function selectDisplaySubscription(
  rows: SubscriptionRow[],
  now: Date,
): SubscriptionRow | null {
  const { qualifying } = deriveTier(rows, now);
  if (qualifying !== null) return qualifying;
  let earliest: SubscriptionRow | null = null;
  for (const row of rows) {
    if (TERMINAL_SUBSCRIPTION_STATUSES.has(row.status)) continue;
    if (earliest === null || compareSubscriptionOrder(row, earliest) < 0) earliest = row;
  }
  return earliest;
}

/**
 * Assemble the GET /api/billing/tier response (Task 1's `TierStateSchema`
 * shape; D16, REQ-11.1/11.4/11.7):
 *
 * - `subscription` derives from the LOCAL MIRROR ONLY (no Stripe call) via the
 *   qualifying-first display rule, so it renders with Stripe unconfigured;
 *   `manageable = subscription exists && isStripeConfigured()` drives the
 *   Portal link vs the "billing temporarily unavailable" notice. It is carried
 *   even with gating off (the REQ-11.7 carve-out).
 * - `usage` is populated ONLY when gating is on and the user is non-exempt:
 *   small indexed reads, deliberately non-transactional — momentary
 *   cross-count skew is acceptable for an advisory display surface.
 * - Booleans and state only: no server credentials, and price IDS never leave
 *   the API — the card shows the mirrored amount.
 */
export async function getTierState(
  db: Database | Transaction,
  args: { userId: string; isAdmin: boolean },
): Promise<TierState> {
  const gatingEnabled = isFeatureGatingEnabled();
  const exempt = args.isAdmin;

  const rows = await selectSubscriptionsByUser(db, args.userId);
  const now = new Date();
  const { tier } = deriveTier(rows, now);
  const display = selectDisplaySubscription(rows, now);

  const subscription =
    display === null
      ? null
      : {
          status: display.status,
          currentPeriodEnd: display.currentPeriodEnd.toISOString(),
          cancelAtPeriodEnd: display.cancelAtPeriodEnd,
          pastDue: display.status === 'past_due',
          priceUnitAmount: display.priceUnitAmount,
          priceCurrency: display.priceCurrency,
          manageable: isStripeConfigured(),
        };

  let usage: TierState['usage'] = null;
  if (gatingEnabled && !exempt) {
    const periodKey = PERIOD_KEY();
    const accountsUsed = await countAccountsByUser(db, args.userId);
    const writableAccountId = await resolveWritableAccountId(db, args.userId);
    const positionsUsed = await countPositionsByUser(db, args.userId);
    const allowanceUsed = await getAllowanceUsage(db, args.userId, periodKey);
    const imagesUsed = await getImageCount(db, args.userId, periodKey);
    const csvImportsUsed = await selectCsvImportCount(db, args.userId);
    usage = {
      accounts: { used: accountsUsed, writableAccountId },
      positions: { used: positionsUsed },
      platformTurns: { allowanceUsed },
      images: { used: imagesUsed },
      csvImports: { used: csvImportsUsed },
    };
  }

  return {
    gatingEnabled,
    exempt,
    tier,
    purchasable: isProSubscriptionConfigured(),
    subscription,
    limits: { free: getTierLimits('free'), pro: getTierLimits('pro') },
    usage,
  };
}

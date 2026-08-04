import { eq } from 'drizzle-orm';

import type { BuyingPowerBasis } from '@tradr/shared';

import type { Database, Transaction } from '@/db';
import { users } from '@/db/schema';

/**
 * The user's buying-power basis — which account figure the calculator caps
 * position size against (calculator-balance-sizing).
 *
 * The column is `NOT NULL DEFAULT 'cash'`, so the fallback here is unreachable
 * for an existing user and exists only for the missing-row case (a deleted user
 * racing a request). It matches the column default deliberately: a read that
 * silently returned 'balance' would reintroduce the overshoot the default is
 * there to prevent.
 */
export async function getBuyingPowerBasis(
  db: Database | Transaction,
  userId: string,
): Promise<BuyingPowerBasis> {
  const rows = await db
    .select({ buyingPowerBasis: users.buyingPowerBasis })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return (rows[0]?.buyingPowerBasis as BuyingPowerBasis | undefined) ?? 'cash';
}

/** Persist the buying-power basis. Value validity is the route's Zod duty. */
export async function setBuyingPowerBasis(
  db: Database | Transaction,
  userId: string,
  basis: BuyingPowerBasis,
): Promise<void> {
  await db
    .update(users)
    .set({ buyingPowerBasis: basis, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

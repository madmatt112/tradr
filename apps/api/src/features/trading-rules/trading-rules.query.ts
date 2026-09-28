import { and, eq, sql } from 'drizzle-orm';

import type { Database, Transaction } from '@/db';
import { accounts, tags, tradingRules } from '@/db/schema';

// The stored row shape the service maps to the wire `TradingRule`. `params` is
// the canonical JSON (decimal strings, currency inside for amount types, D3).
export type TradingRuleRow = typeof tradingRules.$inferSelect;

// What the service writes: the validated, canonicalised rule plus its dedup key.
export interface TradingRuleInsert {
  userId: string;
  type: string;
  params: Record<string, unknown>;
  weight: string;
  enabled: boolean;
  accountId: string | null;
  tagId: string | null;
  dedupKey: string;
}

/** All of a user's rules, oldest first, for `GET /api/trading-rules`. */
export function findRulesByUser(
  db: Database | Transaction,
  userId: string,
): Promise<TradingRuleRow[]> {
  return db
    .select()
    .from(tradingRules)
    .where(eq(tradingRules.userId, userId))
    .orderBy(tradingRules.createdAt, tradingRules.id);
}

/** A single owned rule (or none) — the 404 check on edit and delete. */
export function findRuleById(db: Database | Transaction, id: string, userId: string) {
  return db
    .select()
    .from(tradingRules)
    .where(and(eq(tradingRules.id, id), eq(tradingRules.userId, userId)))
    .limit(1);
}

/** Per-user rule count for the per-user cap in `createTradingRule`. */
export async function countRulesByUser(
  db: Database | Transaction,
  userId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tradingRules)
    .where(eq(tradingRules.userId, userId));
  return row?.count ?? 0;
}

/** Insert one rule; used by `createTradingRule`. */
export function insertRule(tx: Transaction, data: TradingRuleInsert) {
  return tx.insert(tradingRules).values(data).returning();
}

/** Full-replacement update of an owned rule, bumping `updatedAt`; used by `editTradingRule`. */
export function updateRule(
  tx: Transaction,
  id: string,
  userId: string,
  data: Omit<TradingRuleInsert, 'userId'>,
) {
  return tx
    .update(tradingRules)
    .set({
      type: data.type,
      params: data.params,
      weight: data.weight,
      enabled: data.enabled,
      accountId: data.accountId,
      tagId: data.tagId,
      dedupKey: data.dedupKey,
      updatedAt: new Date(),
    })
    .where(and(eq(tradingRules.id, id), eq(tradingRules.userId, userId)))
    .returning();
}

/** Delete an owned rule; used by `removeTradingRule`. Zero rows → 404. */
export function deleteRule(tx: Transaction, id: string, userId: string) {
  return tx
    .delete(tradingRules)
    .where(and(eq(tradingRules.id, id), eq(tradingRules.userId, userId)))
    .returning({ id: tradingRules.id });
}

/**
 * The owned account's currency, or undefined when the id is not the user's. The
 * service uses it both for the ownership check (Requirement 1.3) and the
 * scoped-currency match (Requirement 1.4).
 */
export async function findOwnedAccountCurrency(
  db: Database | Transaction,
  userId: string,
  accountId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)))
    .limit(1);
  return row?.currency;
}

/** True when the tag id belongs to the user — the scope ownership check (Requirement 1.3). */
export async function userOwnsTag(
  db: Database | Transaction,
  userId: string,
  tagId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.id, tagId), eq(tags.userId, userId)))
    .limit(1);
  return row !== undefined;
}

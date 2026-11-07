// Thin Drizzle wrappers for IBKR Flex connections (design C1). Each function is
// a single statement; every user-facing one is scoped by `userId`. The token
// and query id live only as ciphertext — no query returns or logs plaintext, and
// `listConnections` never selects a ciphertext column (Req 1.1, 1.2, 5.1).

import { and, eq } from 'drizzle-orm';

import type { Database, Transaction } from '@/db';
import { ibkrFlexConnections } from '@/db/schema';

type Db = Database | Transaction;

/** The masked view of a stored connection — never any ciphertext (Req 1.1, 1.2). */
export interface ConnectionMasked {
  accountId: string;
  tokenHintTail: string;
  lastFetchedAt: Date | null;
  lastPeriodStart: string | null;
  lastPeriodEnd: string | null;
}

/** The ciphertext envelope a fetch decrypts, plus the id `recordFetch` writes by. */
export interface ConnectionCiphertext {
  id: string;
  encryptedToken: string;
  encryptedQueryId: string;
  keyVersion: number;
}

/** The last-fetch record: only the fetch time and the report's trade-date span (Req 7.4). */
export interface FetchRecord {
  fetchedAt: Date;
  periodStart: string | null;
  periodEnd: string | null;
}

/**
 * The user's connections as masked columns only (Req 1.1). Returns neither
 * ciphertext value, so a listing can never leak a token or query id.
 */
export async function listConnections(db: Db, userId: string): Promise<ConnectionMasked[]> {
  return db
    .select({
      accountId: ibkrFlexConnections.accountId,
      tokenHintTail: ibkrFlexConnections.tokenHintTail,
      lastFetchedAt: ibkrFlexConnections.lastFetchedAt,
      lastPeriodStart: ibkrFlexConnections.lastPeriodStart,
      lastPeriodEnd: ibkrFlexConnections.lastPeriodEnd,
    })
    .from(ibkrFlexConnections)
    .where(eq(ibkrFlexConnections.userId, userId))
    .orderBy(ibkrFlexConnections.createdAt);
}

/**
 * The ciphertext envelope of one account's connection, scoped by `userId`, for
 * decryption at fetch time (design C6 step 1). `null` when the user holds no
 * connection for that account — which a fetch maps to 404 (Req 5.7).
 */
export async function selectConnectionCiphertext(
  db: Db,
  userId: string,
  accountId: string,
): Promise<ConnectionCiphertext | null> {
  const rows = await db
    .select({
      id: ibkrFlexConnections.id,
      encryptedToken: ibkrFlexConnections.encryptedToken,
      encryptedQueryId: ibkrFlexConnections.encryptedQueryId,
      keyVersion: ibkrFlexConnections.keyVersion,
    })
    .from(ibkrFlexConnections)
    .where(
      and(eq(ibkrFlexConnections.userId, userId), eq(ibkrFlexConnections.accountId, accountId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Replace the account's connection: delete then insert (design D13, Req 1.4),
 * so the saved row gets a fresh `id` and an empty last-fetch record. The new id
 * voids any late in-flight `recordFetch` against the old row. Takes a
 * `Transaction` so the delete and insert commit together.
 */
export async function replaceConnection(
  tx: Transaction,
  row: typeof ibkrFlexConnections.$inferInsert,
): Promise<typeof ibkrFlexConnections.$inferSelect> {
  await tx.delete(ibkrFlexConnections).where(eq(ibkrFlexConnections.accountId, row.accountId));
  const [inserted] = await tx.insert(ibkrFlexConnections).values(row).returning();
  return inserted!;
}

/**
 * Hard-delete the account's connection, scoped by `userId`. Returns the deleted
 * count, so the caller maps 0 to 404 — a user cannot remove another's
 * connection (Req 5.7).
 */
export async function deleteConnection(db: Db, userId: string, accountId: string): Promise<number> {
  const rows = await db
    .delete(ibkrFlexConnections)
    .where(
      and(eq(ibkrFlexConnections.userId, userId), eq(ibkrFlexConnections.accountId, accountId)),
    )
    .returning({ id: ibkrFlexConnections.id });
  return rows.length;
}

/**
 * Record a completed fetch's time and trade-date span by connection `id` (Req
 * 7.1, 7.4). Updating by `id` makes this a no-op when the connection was
 * replaced or removed mid-fetch (design C1) — the surviving row keeps its state.
 */
export async function recordFetch(
  db: Db,
  connectionId: string,
  record: FetchRecord,
): Promise<void> {
  await db
    .update(ibkrFlexConnections)
    .set({
      lastFetchedAt: record.fetchedAt,
      lastPeriodStart: record.periodStart,
      lastPeriodEnd: record.periodEnd,
      updatedAt: new Date(),
    })
    .where(eq(ibkrFlexConnections.id, connectionId));
}

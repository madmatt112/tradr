import { and, desc, eq, lt, or, sql } from 'drizzle-orm';

import type { Database, Transaction } from '@/db';
import { usageRecords, walletTransactions, wallets, webhookEvents } from '@/db/schema';

// ---------------------------------------------------------------------------
// Wallet store & balance query layer (design Component 1, REQ-1, REQ-9).
//
// Type rules (structure.md:315-317): writes/locks take `Transaction` (the
// `FOR UPDATE` row lock only exists inside `withTransaction`); reads accept
// `Database | Transaction`. User-facing queries scope by `userId`; the
// webhook-side credit/claim helpers are clearly-named system queries that
// operate off Stripe event metadata, not a session `userId`.
//
// Credits are bigint micro-USD. `balance` MAY go negative (REQ-3.9).
// ---------------------------------------------------------------------------

export interface WalletRow {
  balance: bigint;
  reserved: bigint;
  reservedAt: Date | null;
}

/**
 * Row-lock the user's wallet for the duration of the transaction (REQ-1.5,
 * REQ-9.2/9.3). Reuses the raw `FOR UPDATE` idiom from
 * `positions.query.ts:107`. Returns `null` when no wallet row exists yet
 * (lazy wallet — REQ-1.1); callers `ensureWallet` first when they need to
 * mutate.
 */
export async function getWalletForUpdate(
  tx: Transaction,
  userId: string,
): Promise<WalletRow | null> {
  const result = await tx.execute(
    sql`SELECT balance, reserved, reserved_at FROM wallets WHERE user_id = ${userId} FOR UPDATE`,
  );
  const row = (result as unknown as Array<Record<string, unknown>>)[0];
  if (!row) return null;
  return {
    balance: BigInt(row.balance as string | number | bigint),
    reserved: BigInt(row.reserved as string | number | bigint),
    reservedAt: row.reserved_at ? new Date(row.reserved_at as string) : null,
  };
}

/**
 * Lazily create the user's wallet row, then return it row-locked. Idempotent:
 * `INSERT … ON CONFLICT (user_id) DO NOTHING` followed by a `FOR UPDATE`
 * re-select. After this returns, the row is guaranteed to exist and be locked
 * for the rest of the transaction (REQ-1.1).
 */
export async function ensureWallet(tx: Transaction, userId: string): Promise<WalletRow> {
  await tx.insert(wallets).values({ userId }).onConflictDoNothing({ target: wallets.userId });
  const row = await getWalletForUpdate(tx, userId);
  // The wallet row exists after the upsert; the lock re-select always returns it.
  return row as WalletRow;
}

export type WalletTxnKind = 'credit' | 'debit' | 'reversal';

export interface BalanceDelta {
  /** Signed change applied to `wallets.balance` (micro-USD). */
  deltaBalance: bigint;
  /** Signed change applied to `wallets.reserved` (micro-USD). */
  deltaReserved: bigint;
  /** Audit-row kind. Reservations pass `deltaReserved` with a no-op `amount`. */
  kind: WalletTxnKind;
  /** Signed audit amount recorded on the `wallet_transactions` row. */
  amount: bigint;
  /** Provenance keys for the audit row (idempotency + refund/dispute join). */
  reference?: {
    stripeEventId?: string | null;
    stripePaymentIntentId?: string | null;
    usageRecordId?: string | null;
  };
}

export interface AppliedBalance {
  balance: bigint;
  reserved: bigint;
}

/**
 * The single mutation primitive (design Component 1). Updates the **already
 * row-locked** wallet and appends the `wallet_transactions` audit row with
 * `balance_after`. Credit/debit/reversal/reserve all funnel through here under
 * the `FOR UPDATE` lock so concurrent mutations serialize (REQ-9.2/9.3).
 *
 * Callers MUST have called `ensureWallet`/`getWalletForUpdate` first so the
 * row exists and is locked.
 */
export async function applyBalanceDelta(
  tx: Transaction,
  userId: string,
  delta: BalanceDelta,
): Promise<AppliedBalance> {
  const [updated] = await tx
    .update(wallets)
    .set({
      balance: sql`${wallets.balance} + ${delta.deltaBalance}`,
      reserved: sql`${wallets.reserved} + ${delta.deltaReserved}`,
      reservedAt: delta.deltaReserved > 0n ? new Date() : wallets.reservedAt,
      updatedAt: new Date(),
    })
    .where(eq(wallets.userId, userId))
    .returning({ balance: wallets.balance, reserved: wallets.reserved });

  await tx.insert(walletTransactions).values({
    userId,
    kind: delta.kind,
    amount: delta.amount,
    balanceAfter: updated.balance,
    stripeEventId: delta.reference?.stripeEventId ?? null,
    stripePaymentIntentId: delta.reference?.stripePaymentIntentId ?? null,
    usageRecordId: delta.reference?.usageRecordId ?? null,
  });

  return { balance: updated.balance, reserved: updated.reserved };
}

export interface UsageRecordInsert {
  userId: string;
  conversationId: string | null;
  /** The assistant turn row this usage attributes to. */
  messageId: string | null;
  providerId: string;
  model: string;
  /** Cumulative across all platform calls in the turn (REQ-5.1). */
  inputTokens: bigint;
  outputTokens: bigint;
  /** `priceTurnUsage(...)` result, as charged. */
  creditCost: bigint;
  /**
   * Pre-markup rate-table cost as charged at turn time (admin-platform
   * REQ-4.2 option (i)) — persisted, never derived from current config.
   * Itself ceil-rounded per-token to whole micro-USD (slight over-statement
   * for sub-micro-USD models). Omitted → NULL (pre-0013 rows are NULL).
   */
  rawCost?: bigint;
}

/**
 * Insert the immutable per-turn `usage_record` (REQ-5.2) and return its id so
 * the matching debit's `wallet_transactions` row can reference it. Called inside
 * the same `withTransaction` as the advisor message writes and the debit so the
 * charge, the record, and the messages all commit or roll back together
 * (Component 7, REQ-5.4/9.2).
 */
export async function insertUsageRecord(
  tx: Transaction,
  record: UsageRecordInsert,
): Promise<string> {
  const [row] = await tx
    .insert(usageRecords)
    .values({
      userId: record.userId,
      conversationId: record.conversationId,
      messageId: record.messageId,
      providerId: record.providerId,
      model: record.model,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      creditCost: record.creditCost,
      rawCost: record.rawCost ?? null,
    })
    .returning({ id: usageRecords.id });
  return row.id;
}

export interface UserBalance {
  /** Cached authoritative balance (micro-USD); may be negative (REQ-3.9). */
  balance: bigint;
  /** Spendable = balance − reserved (REQ-1.4). */
  available: bigint;
}

/**
 * Read the user's balance. A user with no wallet row reads as zero (REQ-1.1) —
 * never errors on a missing row. Accepts `Database | Transaction` (read).
 */
export async function getBalanceForUser(
  db: Database | Transaction,
  userId: string,
): Promise<UserBalance> {
  const [row] = await db
    .select({ balance: wallets.balance, reserved: wallets.reserved })
    .from(wallets)
    .where(eq(wallets.userId, userId))
    .limit(1);
  if (!row) return { balance: 0n, available: 0n };
  return { balance: row.balance, available: row.balance - row.reserved };
}

export interface WalletHistoryItem {
  id: string;
  kind: WalletTxnKind;
  amount: bigint;
  balanceAfter: bigint;
  createdAt: string;
  /** Token detail when this debit links a usage record (REQ-7.3), else null. */
  usage: {
    providerId: string;
    model: string;
    inputTokens: bigint;
    outputTokens: bigint;
    creditCost: bigint;
  } | null;
}

export interface WalletHistoryResult {
  items: WalletHistoryItem[];
  nextCursor: string | null;
}

/**
 * Paginated unified wallet history — credit/debit/reversal rows LEFT-JOINed to
 * `usage_records` for token detail (REQ-7.3). Cursor mirrors the advisor
 * conversation cursor (`(created_at, id)` tuple, newest-first). User-scoped.
 * `limit` is the already-clamped page size.
 */
export async function listWalletHistory(
  db: Database | Transaction,
  userId: string,
  args: { cursor: { createdAt: Date; id: string } | null; limit: number },
): Promise<WalletHistoryResult> {
  const { cursor, limit } = args;
  const where = cursor
    ? and(
        eq(walletTransactions.userId, userId),
        or(
          lt(walletTransactions.createdAt, cursor.createdAt),
          and(
            eq(walletTransactions.createdAt, cursor.createdAt),
            lt(walletTransactions.id, cursor.id),
          ),
        ),
      )
    : eq(walletTransactions.userId, userId);

  const rows = await db
    .select({
      id: walletTransactions.id,
      kind: walletTransactions.kind,
      amount: walletTransactions.amount,
      balanceAfter: walletTransactions.balanceAfter,
      createdAt: walletTransactions.createdAt,
      providerId: usageRecords.providerId,
      model: usageRecords.model,
      inputTokens: usageRecords.inputTokens,
      outputTokens: usageRecords.outputTokens,
      creditCost: usageRecords.creditCost,
    })
    .from(walletTransactions)
    .leftJoin(usageRecords, eq(walletTransactions.usageRecordId, usageRecords.id))
    .where(where)
    .orderBy(desc(walletTransactions.createdAt), desc(walletTransactions.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      id: r.id,
      kind: r.kind as WalletTxnKind,
      amount: r.amount,
      balanceAfter: r.balanceAfter,
      createdAt: r.createdAt.toISOString(),
      usage:
        r.providerId !== null
          ? {
              providerId: r.providerId,
              model: r.model as string,
              inputTokens: r.inputTokens as bigint,
              outputTokens: r.outputTokens as bigint,
              creditCost: r.creditCost as bigint,
            }
          : null,
    })),
    nextCursor: hasMore && last ? encodeWalletCursor(last.createdAt, last.id) : null,
  };
}

/** Encode a `(created_at, id)` tuple into the stable base64 history cursor. */
export function encodeWalletCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64');
}

/** Decode a base64 history cursor into its tuple, or `null` if malformed. */
export function decodeWalletCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    const sep = raw.indexOf('|');
    if (sep === -1) return null;
    const iso = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    const createdAt = new Date(iso);
    if (id.length === 0 || Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * SYSTEM QUERY (no `userId` scoping — structure.md:317). Claim a Stripe webhook
 * event for processing via `INSERT … ON CONFLICT (stripe_event_id) DO NOTHING`
 * — the unique-constraint idempotency mechanism (REQ-3.2, REQ-9.1). Returns
 * `true` if this call claimed the event (first delivery), `false` if it was
 * already claimed (duplicate ⇒ ack without re-crediting).
 */
export async function claimWebhookEvent(
  tx: Transaction,
  args: { stripeEventId: string; eventType: string; status?: string },
): Promise<boolean> {
  const inserted = await tx
    .insert(webhookEvents)
    .values({
      stripeEventId: args.stripeEventId,
      eventType: args.eventType,
      status: args.status ?? 'received',
    })
    .onConflictDoNothing({ target: webhookEvents.stripeEventId })
    .returning({ id: webhookEvents.id });
  return inserted.length > 0;
}

/**
 * SYSTEM QUERY (no `userId` scoping — structure.md:317). Record the terminal
 * outcome of a claimed webhook event (REQ-3.8): move `webhook_events.status`
 * from the in-progress `received` to `processed` (credited), `ignored`
 * (acked-without-credit), or `failed` (definitive refuse-and-record), stamping
 * `completed_at` and an optional `error`. Operates on the row claimed earlier in
 * the same transaction, keyed by `stripe_event_id`.
 */
export async function recordWebhookOutcome(
  tx: Transaction,
  args: { stripeEventId: string; status: 'processed' | 'ignored' | 'failed'; error?: string },
): Promise<void> {
  await tx
    .update(webhookEvents)
    .set({
      status: args.status,
      completedAt: new Date(),
      error: args.error ?? null,
    })
    .where(eq(webhookEvents.stripeEventId, args.stripeEventId));
}

/**
 * SYSTEM QUERY (no `userId` scoping — structure.md:317). Idempotency guard for
 * F3 reversals (REQ-3.9): returns true if a `reversal` audit row already exists
 * for this dispute/refund `stripe_event_id`, so a Stripe redelivery of the same
 * dispute/refund event cannot reverse the grant twice.
 */
export async function findReversalByEventId(
  tx: Transaction,
  stripeEventId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: walletTransactions.id })
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.stripeEventId, stripeEventId),
        eq(walletTransactions.kind, 'reversal'),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * SYSTEM QUERY (no `userId` scoping — structure.md:317). Sum the magnitude of
 * reversals ALREADY applied for a payment intent (REQ-3.9). Stripe's
 * `charge.refunded` carries the CUMULATIVE `amount_refunded`, and each sequential
 * partial refund fires a distinct event id — so idempotency-by-event-id alone
 * would let two partial refunds over-claw (30% then 50% cumulative reversing
 * 30%+50%=80%). The reversal must be INCREMENTAL: this returns the total already
 * reversed (as a positive bigint; reversal `amount`s are stored negative) for the
 * PI so the caller applies only the remainder up to the new cumulative target.
 */
export async function sumReversalsByPaymentIntent(
  tx: Transaction,
  paymentIntentId: string,
): Promise<bigint> {
  const rows = await tx
    .select({ total: sql<string>`coalesce(-sum(${walletTransactions.amount}), 0)` })
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.stripePaymentIntentId, paymentIntentId),
        eq(walletTransactions.kind, 'reversal'),
      ),
    );
  return BigInt(rows[0]?.total ?? 0);
}

/**
 * SYSTEM QUERY (no `userId` scoping — structure.md:317). Locate the original
 * credit grant for an F3 refund/dispute reversal by joining the event's
 * `payment_intent` to `wallet_transactions.stripe_payment_intent_id`. Returns
 * the original credit row(s) so the reversal can be applied proportionally and
 * idempotently (REQ-3.9). Named for the webhook system context, not a user.
 */
export async function findCreditByPaymentIntent(
  tx: Transaction,
  paymentIntentId: string,
): Promise<Array<{ id: string; userId: string; amount: bigint; stripeEventId: string | null }>> {
  return tx
    .select({
      id: walletTransactions.id,
      userId: walletTransactions.userId,
      amount: walletTransactions.amount,
      stripeEventId: walletTransactions.stripeEventId,
    })
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.stripePaymentIntentId, paymentIntentId),
        eq(walletTransactions.kind, 'credit'),
      ),
    );
}

/**
 * SYSTEM QUERY (no `userId` scoping — structure.md:317). Credit the wallet for
 * a settled Stripe event: resolve+lock the user's wallet (lazy-created) and
 * apply the grant through the single mutation primitive, recording the event id
 * and payment intent on the audit row for idempotency and F3 reversal joins
 * (REQ-3.3). `userId` is resolved from event/session metadata by the caller,
 * never from a session. Returns the post-credit balance.
 */
export async function creditWalletForEvent(
  tx: Transaction,
  args: {
    userId: string;
    creditGrant: bigint;
    stripeEventId: string;
    stripePaymentIntentId: string | null;
  },
): Promise<AppliedBalance> {
  await ensureWallet(tx, args.userId);
  return applyBalanceDelta(tx, args.userId, {
    deltaBalance: args.creditGrant,
    deltaReserved: 0n,
    kind: 'credit',
    amount: args.creditGrant,
    reference: {
      stripeEventId: args.stripeEventId,
      stripePaymentIntentId: args.stripePaymentIntentId,
    },
  });
}

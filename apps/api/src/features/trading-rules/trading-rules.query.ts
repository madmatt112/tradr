import { and, eq, sql } from 'drizzle-orm';

import { describeRule } from '@tradr/shared/lib/trading-rules';
import type {
  RuleWeight,
  TradingRule,
  TradingRuleDefinition,
} from '@tradr/shared/schemas/trading-rule';

import type { Database, Transaction } from '@/db';
import { accounts, tags, tradingRules } from '@/db/schema';
import { BALANCE_ENTRY_TYPES } from '@/features/accounting/accounting.query';

import type { BalanceEntry, ScoringData, ScoringPosition } from './rule-evaluator';

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

// A stored row → the wire `TradingRule` the evaluator scores from. The mapping
// mirrors the service's `toTradingRule`: `type` and `params` recombine into the
// definition, whose `description` is generated on read (D6, never stored).
function toScoringRule(row: TradingRuleRow): TradingRule {
  const definition = { type: row.type, params: row.params } as TradingRuleDefinition;
  return {
    id: row.id,
    definition,
    weight: row.weight as RuleWeight,
    enabled: row.enabled,
    accountId: row.accountId,
    tagId: row.tagId,
    description: describeRule(definition),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The bounded three-query scoring read (design C4). Everything the pure evaluator
 * needs for `targetIds`, in at most three statements whatever the position count:
 *
 * 1. the user's rules; with none enabled, positions and ledger stay empty;
 * 2. the windowed population — each non-draft user position with open instant at
 *    most `hi` (the latest target open) that is open, went flat at or after `lo`
 *    (the earliest target open minus eight days, D14) or has a fill at or after
 *    `lo` — with its account currency, timezone, starting balance, fills, tags
 *    and `has_notes` (the notes text is never read, NFR Security);
 * 3. the balance-type ledger rows of the targets' accounts before `hi`, loaded
 *    only when an enabled `max_risk_percent` rule needs a balance.
 *
 * Every statement filters by `user_id`.
 */
export async function loadScoringData(
  db: Database | Transaction,
  userId: string,
  targetIds: string[],
): Promise<ScoringData> {
  // Query 1: the user's rules. No enabled rule (or no target) means no scoring,
  // so the population and ledger reads are skipped entirely.
  const ruleRows = await findRulesByUser(db, userId);
  const rules = ruleRows.map(toScoringRule);
  const enabled = rules.filter((r) => r.enabled);
  if (enabled.length === 0 || targetIds.length === 0) {
    return { rules, positions: [], ledger: [] };
  }

  // Ids bind as `fetchGroup` does (export.query.ts:287-290).
  const idList = sql.join(
    targetIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  // Query 2: one jsonb envelope over the window `[lo, hi]`. `lo`/`hi` come from
  // the non-draft targets; all-draft targets leave `hi` null and the set empty.
  const positionResult = await db.execute<{ envelope: ScoringPosition[] }>(sql`
    WITH targets AS (
      SELECT COALESCE(p.opened_at, p.created_at) AS open_instant
      FROM positions p
      WHERE p.user_id = ${userId}
        AND p.id IN (${idList})
        AND p.status <> 'draft'
    ),
    bounds AS (
      SELECT
        MIN(open_instant) - INTERVAL '8 days' AS lo,
        MAX(open_instant)                     AS hi
      FROM targets
    ),
    population AS (
      SELECT
        p.id, p.side, p.asset_type, p.symbol, p.status,
        p.closed_at, p.last_flat_at, p.last_flat_net_pnl,
        p.account_id, p.opened_at, p.created_at, p.stop_loss, p.target_price,
        (p.notes IS NOT NULL AND btrim(p.notes) <> '') AS has_notes,
        a.currency, a.timezone, a.starting_balance
      FROM positions p
      JOIN accounts a ON a.id = p.account_id AND a.user_id = p.user_id
      CROSS JOIN bounds b
      WHERE p.user_id = ${userId}
        AND p.status <> 'draft'
        AND b.hi IS NOT NULL
        AND COALESCE(p.opened_at, p.created_at) <= b.hi
        AND (
          p.status = 'open'
          OR (
            COALESCE(p.last_flat_at, p.closed_at) IS NOT NULL
            AND COALESCE(p.last_flat_at, p.closed_at) >= b.lo
          )
          OR EXISTS (
            SELECT 1 FROM fills f
            WHERE f.position_id = p.id AND f.filled_at >= b.lo
          )
        )
    ),
    population_fills AS (
      SELECT
        f.position_id,
        jsonb_agg(
          jsonb_build_object(
            'type', f.type, 'price', f.price::text,
            'quantity', f.quantity::text, 'fees', f.fees::text,
            'filledAt', f.filled_at
          ) ORDER BY f.filled_at
        ) AS fills
      FROM fills f
      JOIN population pop ON pop.id = f.position_id
      GROUP BY f.position_id
    ),
    population_tag_sets AS (
      SELECT pt.position_id,
             jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name,
                                          'category', t.category, 'color', t.color)
                       ORDER BY t.id) AS tags
      FROM position_tags pt
      JOIN tags t ON t.id = pt.tag_id AND t.user_id = ${userId}
      JOIN population pop ON pop.id = pt.position_id
      GROUP BY pt.position_id
    )
    SELECT COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', pop.id, 'side', pop.side, 'assetType', pop.asset_type,
        'symbol', pop.symbol, 'currency', pop.currency,
        'closedAt', pop.closed_at, 'status', pop.status,
        'lastFlatAt', pop.last_flat_at, 'lastFlatNetPnl', pop.last_flat_net_pnl::text,
        'fills', COALESCE(pf.fills, '[]'::jsonb),
        'tags', COALESCE(pts.tags, '[]'::jsonb),
        'accountId', pop.account_id,
        'openedAt', pop.opened_at,
        'createdAt', pop.created_at,
        'stopLoss', pop.stop_loss::text,
        'targetPrice', pop.target_price::text,
        'hasNotes', pop.has_notes,
        'accountTimezone', pop.timezone,
        'startingBalance', pop.starting_balance::text
      ))
      FROM population pop
        LEFT JOIN population_fills pf ON pf.position_id = pop.id
        LEFT JOIN population_tag_sets pts ON pts.position_id = pop.id
    ), '[]'::jsonb) AS envelope
  `);
  const positions = positionResult[0].envelope;

  // Query 3: the balance ledger, only when an enabled `max_risk_percent` rule
  // needs an account balance (Requirement 2.2). Signed amount is credit minus
  // debit (accounting.query.ts:499-503), served by the balance partial index.
  const needsLedger = enabled.some((r) => r.definition.type === 'max_risk_percent');
  if (!needsLedger) {
    return { rules, positions, ledger: [] };
  }

  const entryTypesLiteral = `{${[...BALANCE_ENTRY_TYPES].join(',')}}`;
  const ledgerResult = await db.execute<{ envelope: BalanceEntry[] }>(sql`
    WITH targets AS (
      SELECT p.account_id, COALESCE(p.opened_at, p.created_at) AS open_instant
      FROM positions p
      WHERE p.user_id = ${userId}
        AND p.id IN (${idList})
        AND p.status <> 'draft'
    ),
    bounds AS (SELECT MAX(open_instant) AS hi FROM targets),
    target_accounts AS (SELECT DISTINCT account_id FROM targets)
    SELECT COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'accountId', le.account_id,
        'occurredAt', le.occurred_at,
        'signedAmount', (
          CASE WHEN le.direction = 'credit' THEN le.amount ELSE -le.amount END
        )::text
      ))
      FROM ledger_entries le
      JOIN target_accounts ta ON ta.account_id = le.account_id
      CROSS JOIN bounds b
      WHERE le.user_id = ${userId}
        AND le.entry_type = ANY(${entryTypesLiteral}::text[])
        AND b.hi IS NOT NULL
        AND le.occurred_at < b.hi
    ), '[]'::jsonb) AS envelope
  `);

  return { rules, positions, ledger: ledgerResult[0].envelope };
}

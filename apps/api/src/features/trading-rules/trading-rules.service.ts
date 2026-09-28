import { canonicalDefinition, describeRule } from '@tradr/shared/lib/trading-rules';
import { TRADING_RULE_LIMIT } from '@tradr/shared/schemas/trading-rule';
import type {
  RuleWeight,
  TradingRule,
  TradingRuleDefinition,
  TradingRuleInput,
} from '@tradr/shared/schemas/trading-rule';

import type { Database, Transaction } from '@/db';
import {
  NotFoundError,
  TradingRuleDuplicateError,
  TradingRuleLimitError,
  ValidationError,
} from '@/lib/errors';
import { withTransaction } from '@/lib/transaction';

import { ruleDedupKey } from './rule-key';
import {
  countRulesByUser,
  deleteRule,
  findOwnedAccountCurrency,
  findRuleById,
  findRulesByUser,
  insertRule,
  updateRule,
  userOwnsTag,
  type TradingRuleInsert,
  type TradingRuleRow,
} from './trading-rules.query';

// The module-private Postgres-error shape and guard (tags.service.ts:34-41): the
// query layer surfaces driver errors raw so the service maps a unique-index
// (23505) violation on the dedup index to the domain 409.
interface PgError {
  code?: string;
  constraint_name?: string;
}
function isPgError(err: unknown): err is PgError {
  return typeof err === 'object' && err !== null && 'code' in err;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

// A stored row → the wire `TradingRule`. `type` and `params` recombine into the
// definition, whose `description` is generated on read (D6, never stored).
function toTradingRule(row: TradingRuleRow): TradingRule {
  const definition = { type: row.type, params: row.params } as TradingRuleDefinition;
  return {
    id: row.id,
    definition,
    weight: row.weight as RuleWeight,
    enabled: row.enabled,
    accountId: row.accountId,
    tagId: row.tagId,
    description: describeRule(definition),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

// The currency of an amount-type definition, else null. `'currency' in params`
// narrows the discriminated union to the amount arms.
function definitionCurrency(definition: TradingRuleDefinition): string | null {
  return 'currency' in definition.params ? definition.params.currency : null;
}

/**
 * Validate the scopes and currency against the user's own accounts and tags, and
 * return the canonical definition and dedup key to store. An unowned account or
 * tag id is a `400` field error (Requirement 1.3); a scoped amount rule whose
 * currency differs from the account's is a `400` at `definition.params.currency`
 * (Requirement 1.4). Runs inside the caller's transaction.
 */
async function prepareRule(
  tx: Transaction,
  userId: string,
  input: TradingRuleInput,
): Promise<{ canonical: TradingRuleDefinition; dedupKey: string }> {
  const canonical = canonicalDefinition(input.definition);

  if (input.accountId !== null) {
    const accountCurrency = await findOwnedAccountCurrency(tx, userId, input.accountId);
    if (accountCurrency === undefined) {
      throw new ValidationError('Unknown account scope', {
        accountId: 'must be one of your accounts',
      });
    }
    const ruleCurrency = definitionCurrency(canonical);
    if (ruleCurrency !== null && ruleCurrency !== accountCurrency) {
      throw new ValidationError('Rule currency must match the account currency', {
        'definition.params.currency': `must equal the account currency (${accountCurrency})`,
      });
    }
  }

  if (input.tagId !== null && !(await userOwnsTag(tx, userId, input.tagId))) {
    throw new ValidationError('Unknown tag scope', {
      tagId: 'must be one of your tags',
    });
  }

  return { canonical, dedupKey: ruleDedupKey(canonical, input.accountId, input.tagId) };
}

function insertValues(
  userId: string,
  input: TradingRuleInput,
  canonical: TradingRuleDefinition,
  dedupKey: string,
): TradingRuleInsert {
  return {
    userId,
    type: canonical.type,
    params: canonical.params,
    weight: input.weight,
    enabled: input.enabled,
    accountId: input.accountId,
    tagId: input.tagId,
    dedupKey,
  };
}

/** `GET /api/trading-rules`: the user's rules, oldest first. */
export async function listTradingRules(db: Database, userId: string): Promise<TradingRule[]> {
  const rows = await findRulesByUser(db, userId);
  return rows.map(toTradingRule);
}

/**
 * Create a rule. Validates scopes, enforces the per-user cap (the tags
 * count-then-insert overshoot posture) and maps a duplicate to a 409.
 */
export async function createTradingRule(
  db: Database,
  userId: string,
  input: TradingRuleInput,
): Promise<TradingRule> {
  return withTransaction(db, async (tx) => {
    const { canonical, dedupKey } = await prepareRule(tx, userId, input);
    if ((await countRulesByUser(tx, userId)) >= TRADING_RULE_LIMIT) {
      throw new TradingRuleLimitError(TRADING_RULE_LIMIT);
    }
    try {
      const [row] = await insertRule(tx, insertValues(userId, input, canonical, dedupKey));
      return toTradingRule(row);
    } catch (err: unknown) {
      if (isPgError(err) && err.code === '23505') throw new TradingRuleDuplicateError();
      throw err;
    }
  });
}

/**
 * Edit a rule by full replacement (D2). A foreign id is a 404; a duplicate is a
 * 409. Validation matches create.
 */
export async function editTradingRule(
  db: Database,
  id: string,
  userId: string,
  input: TradingRuleInput,
): Promise<TradingRule> {
  return withTransaction(db, async (tx) => {
    const [existing] = await findRuleById(tx, id, userId);
    if (!existing) throw new NotFoundError('Trading rule', id);
    const { canonical, dedupKey } = await prepareRule(tx, userId, input);
    try {
      const [row] = await updateRule(tx, id, userId, {
        type: canonical.type,
        params: canonical.params,
        weight: input.weight,
        enabled: input.enabled,
        accountId: input.accountId,
        tagId: input.tagId,
        dedupKey,
      });
      return toTradingRule(row);
    } catch (err: unknown) {
      if (isPgError(err) && err.code === '23505') throw new TradingRuleDuplicateError();
      throw err;
    }
  });
}

/** Delete an owned rule; scoped rows never block. Zero rows → 404. */
export async function removeTradingRule(db: Database, id: string, userId: string): Promise<void> {
  await withTransaction(db, async (tx) => {
    const deleted = await deleteRule(tx, id, userId);
    if (deleted.length === 0) throw new NotFoundError('Trading rule', id);
  });
}

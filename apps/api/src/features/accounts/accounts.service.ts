import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '@/db';
import { users } from '@/db/schema';
import { getTierContext } from '@/features/billing/tier.query';
import { findBrokerageById } from '@/features/brokerages/brokerages.query';
import { AppError, NotFoundError, ConflictError, ForbiddenError } from '@/lib/errors';
import { captureServerEvent } from '@/lib/posthog';
import { withTransaction } from '@/lib/transaction';

interface PgError {
  code?: string;
  constraint_name?: string;
  detail?: string;
}
function isPgError(err: unknown): err is PgError {
  return typeof err === 'object' && err !== null && 'code' in err;
}

import {
  findAccountsByUser,
  findAccountById,
  insertAccount,
  updateAccount,
  deleteAccount,
  countPositionsByAccount,
  accountHasLedgerEntries,
  countAccountsByUser,
  setWritableAccountId,
} from './accounts.query';

export async function listAccounts(db: Database, userId: string) {
  return findAccountsByUser(db, userId);
}

export async function getAccount(db: Database, id: string, userId: string) {
  const rows = await findAccountById(db, id, userId);
  if (rows.length === 0) throw new NotFoundError('Account', id);
  return rows[0];
}

export async function createAccount(
  db: Database,
  userId: string,
  data: {
    name: string;
    currency: string;
    brokerageId?: string | null;
    startingBalance?: string;
    timezone?: string;
    // Omitted means no rule set (user-onboarding R1.1/R1.4). Bounds are
    // CreateAccountSchema's job — never re-checked here.
    defaultRiskPercent?: string;
  },
  // Routes pass `isAdmin` from AuthEnv — services never read Hono context
  // (plan-tiers D9).
  gate: { isAdmin: boolean },
) {
  return withTransaction(db, async (tx) => {
    // L1 creation cap (plan-tiers D9, REQ-6.1). Admin / gating-off pass
    // through with zero behaviour change ({ enforced: false } does no DB
    // read). Indexed count(*); the concurrent-overshoot posture is accepted
    // (REQ-6.3). Terminal-for-state 403 — never 429, no Retry-After (D12).
    const tier = await getTierContext(tx, { userId, isAdmin: gate.isAdmin });
    if (tier.enforced && tier.limits.accounts !== null) {
      const accountCount = await countAccountsByUser(tx, userId);
      if (accountCount >= tier.limits.accounts) {
        captureServerEvent('tier_limit_hit', {
          distinctId: userId,
          properties: { lever: 'accounts' },
        });
        throw new AppError(
          403,
          'TIER_LIMIT_ACCOUNTS',
          `Your plan allows ${tier.limits.accounts} account${tier.limits.accounts === 1 ? '' : 's'}. Upgrade to Pro for unlimited accounts.`,
        );
      }
    }

    if (data.brokerageId) {
      const brokerage = await findBrokerageById(tx, data.brokerageId, userId);
      if (!brokerage) throw new ForbiddenError('Cannot assign this brokerage');
    }

    try {
      const rows = await insertAccount(tx, { userId, ...data });

      // Materialize the user's display_currency on their first account creation.
      // Race-safe first-writer-wins: the `display_currency IS NULL` predicate
      // makes two concurrent first-account creations resolve deterministically —
      // the first to commit sets the value, the second is a no-op. Req 4.10.
      await tx
        .update(users)
        .set({ displayCurrency: data.currency })
        .where(and(eq(users.id, userId), isNull(users.displayCurrency)));

      const joined = await findAccountById(tx, rows[0].id, userId);
      return joined[0];
    } catch (err: unknown) {
      if (
        isPgError(err) &&
        err.code === '23505' &&
        err.constraint_name === 'accounts_user_id_name_unique'
      ) {
        throw new ConflictError('An account with this name already exists');
      }
      throw err;
    }
  });
}

export async function editAccount(
  db: Database,
  id: string,
  userId: string,
  // `defaultRiskPercent` omitted leaves the stored value untouched; an
  // explicit null clears the rule back to unset (user-onboarding R1.1). The
  // distinction is carried all the way to `.set()` — see updateAccount.
  data: Partial<{
    name: string;
    currency: string;
    brokerageId: string | null;
    timezone: string;
    defaultRiskPercent: string | null;
  }>,
) {
  return withTransaction(db, async (tx) => {
    const existing = await findAccountById(tx, id, userId);
    if (existing.length === 0) throw new NotFoundError('Account', id);

    if (data.currency && data.currency !== existing[0].currency) {
      // Currency stays locked for any account that has ever closed a position:
      // ledger rows are append-only, so their presence is a permanent lock.
      // Deleting all positions (closed-position delete drops the count to zero)
      // must NOT unlock currency while old-currency ledger rows remain, else
      // balance derivation corrupts (ledger-balances Req 7 cross-spec note,
      // d-536e8750).
      const [{ count }] = await countPositionsByAccount(tx, id);
      const hasLedger = count > 0 ? false : await accountHasLedgerEntries(tx, id);
      if (count > 0 || hasLedger) {
        throw new ConflictError('Cannot change currency while account has positions');
      }
    }

    if (data.brokerageId) {
      const brokerage = await findBrokerageById(tx, data.brokerageId, userId);
      if (!brokerage) throw new ForbiddenError('Cannot assign this brokerage');
    }

    try {
      await updateAccount(tx, id, userId, data);
      const joined = await findAccountById(tx, id, userId);
      return joined[0];
    } catch (err: unknown) {
      if (
        isPgError(err) &&
        err.code === '23505' &&
        err.constraint_name === 'accounts_user_id_name_unique'
      ) {
        throw new ConflictError('An account with this name already exists');
      }
      throw err;
    }
  });
}

/**
 * Set the writable-account designation (plan-tiers D18, REQ-6.6). Always-on —
 * a harmless stored preference independent of gating/tier/over-cap state; it
 * only *matters* when L1-writability enforcement consults
 * `resolveWritableAccountId`. Ownership-validated: a non-owned account id is a
 * 404, exactly like every other accounts endpoint.
 */
export async function setWritableAccount(db: Database, userId: string, accountId: string) {
  const rows = await findAccountById(db, accountId, userId);
  if (rows.length === 0) throw new NotFoundError('Account', accountId);
  await setWritableAccountId(db, userId, accountId);
  return { writableAccountId: accountId };
}

export async function removeAccount(db: Database, id: string, userId: string) {
  return withTransaction(db, async (tx) => {
    const existing = await findAccountById(tx, id, userId);
    if (existing.length === 0) throw new NotFoundError('Account', id);

    const [{ count }] = await countPositionsByAccount(tx, id);
    if (count > 0) {
      throw new ConflictError('Cannot delete account while it has positions');
    }

    await deleteAccount(tx, id, userId);
  });
}

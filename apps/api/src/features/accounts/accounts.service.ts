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

import { teardownDemoAccount, wasDemoAccount } from './accounts.demo';
import {
  findAccountsByUser,
  findAccountById,
  insertAccount,
  updateAccount,
  deleteAccount,
  countPositionsByAccount,
  accountHasLedgerEntries,
  countAccountsByUser,
  lockUserForAccountChange,
  promoteOldestAccountToDefault,
  selectOwnedAccountDemoFlag,
  setDefaultAccountId,
  setWritableAccountId,
  userHasDefaultAccount,
  userHasDemoAccount,
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
    // Omitted means no rule set, and the calculator then behaves exactly as it
    // did before this column existed. Bounds are CreateAccountSchema's job —
    // never re-checked here.
    defaultRiskPercent?: string;
  },
  // Routes pass `isAdmin` from AuthEnv — services never read Hono context
  // (plan-tiers D9).
  gate: { isAdmin: boolean },
) {
  return withTransaction(db, async (tx) => {
    // Before reading anything about the user's account set, and for the whole
    // of this transaction. The seeder takes the same lock on the same row, so
    // the two cannot both look at a set the other is midway through changing —
    // see `lockUserForAccountChange` for why an unserialized read of it lets
    // the refusal below pass while sample data is being created.
    await lockUserForAccountChange(tx, userId);

    // Sample data and real accounts are mutually exclusive, and this is that
    // rule's creation half — the seeding half lives with the seeder. It is the
    // whole of what keeps invented figures out of real ones: the dashboard
    // widgets, the equity curve and the performance pages scope by currency and
    // pass no account filter at all, so a sample account sitting alongside a
    // real one would blend its trades into the user's own totals with nothing
    // to separate them again. That is why the answer here is a refusal rather
    // than a filter added to each of those queries.
    //
    // It carries its own code so the client can offer to remove the sample data
    // and retry, instead of reporting a bare conflict the user cannot act on.
    //
    // Deliberately ahead of the plan cap below, and the order is the point. The
    // sample account occupies an account slot, so a Free user who accepted the
    // offer of sample data is already at the cap; checked the other way round
    // they would be told to upgrade to escape data they were invited to try,
    // and the offer to remove it would never be reached.
    if (await userHasDemoAccount(tx, userId)) {
      throw new AppError(
        409,
        'DEMO_ACCOUNT_EXISTS',
        'Remove the sample data before creating an account.',
      );
    }

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
      // The first account a user creates is their default. Decided under the
      // lock above, so two concurrent first creations serialize and exactly one
      // takes the designation; the partial unique index backstops it. The demo
      // account never holds the flag, so a user whose only account is the
      // sample one still takes it with their first real account.
      const isDefault = !(await userHasDefaultAccount(tx, userId));
      const rows = await insertAccount(tx, { userId, ...data, isDefault });

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
  // `defaultRiskPercent` omitted leaves the stored value untouched; an explicit
  // null clears the rule back to unset. The distinction is carried all the way
  // to `.set()` — see updateAccount.
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

/**
 * Move the default-account designation. Ownership-validated (404, like every
 * other accounts endpoint), and refused for the sample account — the default
 * is what pickers preselect, and preselecting invented data would put the
 * demo account behind every new position by default. Runs under the per-user
 * account lock so the flip cannot interleave with a create or delete deciding
 * who holds the designation.
 */
export async function setDefaultAccount(db: Database, userId: string, accountId: string) {
  return withTransaction(db, async (tx) => {
    await lockUserForAccountChange(tx, userId);
    const existing = await selectOwnedAccountDemoFlag(tx, accountId, userId);
    if (!existing) throw new NotFoundError('Account', accountId);
    if (existing.isDemo) {
      throw new AppError(
        400,
        'DEMO_ACCOUNT_NOT_DEFAULTABLE',
        'The sample account cannot be the default account.',
      );
    }
    await setDefaultAccountId(tx, userId, accountId);
    return { defaultAccountId: accountId };
  });
}

/**
 * Delete an account.
 *
 * There are two paths through here, and which one runs is decided by the stored
 * row, never by the request. `cascade` is the caller ASKING for the sample-data
 * teardown — the one-click removal of an account together with every position,
 * fill and ledger row booked against it — and asking is not permission. The
 * account's own demo flag, read from the database on the line below, is the
 * permission. The two are separate on purpose: a cascade asked for on a real
 * account simply falls through to the ordinary path and meets the same guard it
 * always has, and deleting the request from this function, or inverting it,
 * would not change that. Nothing a client can send reaches the flag.
 *
 * Ownership is unchanged and orthogonal: an account belonging to somebody else
 * is not found, exactly as before, so no request shape can make it a deletion or
 * even an existence check.
 *
 * Returns whether anything was actually deleted, which is false only on the
 * idempotent repeat below.
 */
export async function removeAccount(
  db: Database,
  id: string,
  userId: string,
  options: { cascade?: boolean } = {},
): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    // Deleting can move the default designation (the promotion below), so this
    // serializes with the other account-set changes exactly as creation and
    // seeding do — same lock, same ordering, taken before any read.
    await lockUserForAccountChange(tx, userId);

    const existing = await selectOwnedAccountDemoFlag(tx, id, userId);

    if (!existing) {
      // Tearing down sample data that is already gone is the state the caller
      // asked for, so it succeeds — two tabs racing on the same button settle on
      // the same answer instead of one of them showing an error. Limited to an
      // id the user's own marker names; every other id, another user's included,
      // is the 404 it has always been.
      if (options.cascade && (await wasDemoAccount(tx, userId, id))) return false;
      throw new NotFoundError('Account', id);
    }

    if (existing.isDemo && options.cascade) {
      await teardownDemoAccount(tx, userId, id);
      return true;
    }

    const [{ count }] = await countPositionsByAccount(tx, id);
    if (count > 0) {
      throw new ConflictError('Cannot delete account while it has positions');
    }

    await deleteAccount(tx, id, userId);
    // Deleting the default hands the designation to the oldest remaining
    // non-demo account — "the first account the user created", the same rule
    // that assigned it — so a user with accounts always has a default for the
    // pickers to preselect. No-op when nothing remains.
    if (existing.isDefault) {
      await promoteOldestAccountToDefault(tx, userId);
    }
    return true;
  });
}

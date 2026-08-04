import Decimal from 'decimal.js';

import type {
  CreateExchangeRateInput,
  PreviewRateChangeInput,
  PreviewRateChangeResponse,
} from '@tradr/shared';
import { getCurrencyMinorUnits } from '@tradr/shared';

import type { Database } from '@/db';
import { findAccountById, findAccountsByUser } from '@/features/accounts/accounts.query';
import { ConflictError, MissingRateError, NotFoundError, ValidationError } from '@/lib/errors';
import { withTransaction } from '@/lib/transaction';

import {
  aggregateBalancesForAccounts,
  deleteExchangeRate as deleteExchangeRateQuery,
  findExchangeRateById,
  findSpotRate,
  findUserDisplayCurrency,
  insertLedgerEntries,
  listExchangeRatesForUser,
  lockAccountForUpdate,
  setUserDisplayCurrency as setUserDisplayCurrencyQuery,
  upsertExchangeRate,
  type ExchangeRateRow,
  type LedgerEntryRow,
} from './accounting.query';

// ---------------------------------------------------------------------------
// Threshold semantics (design.md §Component 6)
// ---------------------------------------------------------------------------
//
// `previewRateChangeImpact` is a per-write fat-finger guard, evaluated
// against the LIVE baseline (never a session checkpoint). The threshold is
// SYMMETRIC across displayability flips: a write that takes the aggregate
// from a displayed value to "no displayable total" is treated identically to
// a write that takes it from "no displayable total" to a value. Both are
// infinite-relative-move events from the user's frame, and both deserve the
// >5% confirmation modal. Concretely (per adversarial review r3 Topic 1):
//
//   exceedsThreshold = true when EITHER
//     (a) before !== null && after !== null && !before.isZero()
//         && abs(after − before) / abs(before) > 0.05      (standard >5%)
//     (b) (before === null) !== (after === null)            (displayability flip)
//
// Otherwise `false` — including both-null (no aggregate either side) and the
// baseline-zero edge case (rare; offsetting balances summing to exactly 0).
//
// The 5% threshold is evaluated PER WRITE against the LIVE baseline — v1
// accepts that sequential edits in one tab or concurrent edits across tabs
// can compose past 5% without firing the modal (see design.md §Component 6
// for the documented trade-off).

const THRESHOLD = new Decimal('0.05');

// ---------------------------------------------------------------------------
// Exchange-rate CRUD (Req 4.1, 4.2, 4.6)
// ---------------------------------------------------------------------------
//
// There is no `updateExchangeRate` — re-entry of a `(base, quote,
// effectiveDate)` triple is a POST upsert per Req 4.2; the v2 design.md
// reconciliation struck the orphan from §Component 6.

export async function createExchangeRate(
  db: Database,
  userId: string,
  input: CreateExchangeRateInput,
): Promise<ExchangeRateRow> {
  // The Zod schema and DB CHECK both reject same-currency pairs; reject early
  // here with a clean ValidationError rather than surfacing the DB CHECK as a
  // 500.
  if (input.baseCurrency === input.quoteCurrency) {
    throw new ValidationError('baseCurrency must differ from quoteCurrency');
  }
  return withTransaction(db, async (tx) => {
    return upsertExchangeRate(tx, { userId, ...input });
  });
}

export async function getUserDisplayCurrency(db: Database, userId: string): Promise<string | null> {
  return findUserDisplayCurrency(db, userId);
}

export async function setUserDisplayCurrency(
  db: Database,
  userId: string,
  currency: string,
): Promise<void> {
  await setUserDisplayCurrencyQuery(db, userId, currency);
}

export async function listExchangeRates(db: Database, userId: string): Promise<ExchangeRateRow[]> {
  return listExchangeRatesForUser(db, userId);
}

export async function deleteExchangeRate(db: Database, userId: string, id: string): Promise<void> {
  await withTransaction(db, async (tx) => {
    const result = await deleteExchangeRateQuery(tx, userId, id);
    if (!result.deleted) throw new NotFoundError('ExchangeRate', id);
  });
}

// ---------------------------------------------------------------------------
// Conversion (Req 4.5)
// ---------------------------------------------------------------------------

/**
 * Convert `amount` from `from` to `to` using the user's stored spot rates.
 *
 * - Identity short-circuit: when `from === to`, return `amount` unchanged
 *   (no rounding) — the caller's precision is preserved.
 * - Otherwise: look up the spot rate `as-of now`; throw `MissingRateError`
 *   when no direct or inverse rate exists.
 * - Multiplication is at the pinned global Decimal precision (20 sig figs,
 *   `ROUND_HALF_UP`); the final result is rounded HALF_UP to 4dp to match
 *   the `numeric(18, 4)` ledger-amount precision.
 */
export async function convertAmountForUser(
  db: Database,
  userId: string,
  amount: Decimal,
  from: string,
  to: string,
): Promise<Decimal> {
  if (from === to) return amount;

  const asOf = new Date();
  const spot = await findSpotRate(db, userId, from, to, asOf);
  if (spot.source === null) {
    throw new MissingRateError(from, to, asOf.toISOString().slice(0, 10));
  }
  return amount.times(spot.rate).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

// ---------------------------------------------------------------------------
// Dashboard total (Req 4.6, 4.13)
// ---------------------------------------------------------------------------

interface MissingPair {
  baseCurrency: string;
  quoteCurrency: string;
}

interface ComputedAggregate {
  total: Decimal | null;
  missingPairs: MissingPair[];
}

/**
 * Sum each account's native-currency balance into the user's `display_currency`.
 *
 * - When ANY pair lacks a spot rate, return `total: null` and the sorted
 *   `missingPairs` list (no partial total). The frontend's
 *   `useMissingRatePrompt` deeplinks to `missingPairs[0]`; the stable
 *   `(base ASC, quote ASC)` ordering makes that target deterministic.
 * - When the user's `display_currency` is NULL (pre-first-account window),
 *   short-circuit to `{displayCurrency: null, total: null, missingPairs: []}`
 *   — no aggregate is meaningful and no rate prompt should fire.
 */
export async function computeDashboardTotal(
  db: Database,
  userId: string,
): Promise<{
  displayCurrency: string | null;
  total: string | null;
  missingPairs: MissingPair[];
}> {
  const displayCurrency = await findUserDisplayCurrency(db, userId);
  if (displayCurrency === null) {
    return { displayCurrency: null, total: null, missingPairs: [] };
  }

  const accounts = await findAccountsByUser(db, userId);
  const accountIds = accounts.map((a) => a.id);
  const balances = await aggregateBalancesForAccounts(db, userId, accountIds);

  const ratesForUser = await listExchangeRatesForUser(db, userId);
  const aggregate = aggregateInDisplayCurrency(
    accounts.map((a) => ({ accountId: a.id, currency: a.currency })),
    balances,
    ratesForUser,
    displayCurrency,
  );

  return {
    displayCurrency,
    total: aggregate.total === null ? null : aggregate.total.toFixed(4),
    missingPairs: aggregate.missingPairs,
  };
}

// ---------------------------------------------------------------------------
// Preview rate-change impact (Req 4.12)
// ---------------------------------------------------------------------------

/**
 * Recompute the user's dashboard aggregate twice — once against the live rate
 * set, once against an in-memory copy with the proposed change applied — and
 * report whether the projected move exceeds the 5% / displayability-flip
 * threshold. NEVER commits anything.
 */
export async function previewRateChangeImpact(
  db: Database,
  userId: string,
  change: PreviewRateChangeInput,
): Promise<PreviewRateChangeResponse> {
  // (1) NULL display_currency: short-circuit — the modal must not gate any
  // write when there is no aggregate to compare against.
  const displayCurrency = await findUserDisplayCurrency(db, userId);
  if (displayCurrency === null) {
    return {
      displayCurrency: null,
      beforeTotal: null,
      afterTotal: null,
      exceedsThreshold: false,
    };
  }

  // (2) For `delete`, verify the rate exists FIRST — closes the concurrent-tab
  // race where Tab A previews delete after Tab B has committed delete.
  if (change.intent === 'delete') {
    const existing = await findExchangeRateById(db, userId, change.rateId);
    if (!existing) throw new NotFoundError('ExchangeRate', change.rateId);
  }

  const accounts = await findAccountsByUser(db, userId);
  const accountIds = accounts.map((a) => a.id);
  const balances = await aggregateBalancesForAccounts(db, userId, accountIds);
  const accountCurrencies = accounts.map((a) => ({
    accountId: a.id,
    currency: a.currency,
  }));

  const liveRates = await listExchangeRatesForUser(db, userId);

  // (3) Build the proposed rate set in-memory.
  const proposedRates = applyProposedChange(liveRates, change);

  // (4) Compute both aggregates against the same balances + accounts.
  const before = aggregateInDisplayCurrency(
    accountCurrencies,
    balances,
    liveRates,
    displayCurrency,
  );
  const after = aggregateInDisplayCurrency(
    accountCurrencies,
    balances,
    proposedRates,
    displayCurrency,
  );

  // (5) Symmetric threshold rule.
  const exceedsThreshold = computeExceedsThreshold(before.total, after.total);

  return {
    displayCurrency,
    beforeTotal: before.total === null ? null : before.total.toFixed(4),
    afterTotal: after.total === null ? null : after.total.toFixed(4),
    exceedsThreshold,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Aggregate per-account native balances into a single `displayCurrency` total
 * given a snapshot of exchange rates. Pure — does no IO. Used by both the
 * live `computeDashboardTotal` and the in-memory `previewRateChangeImpact`.
 *
 * Missing-pair collection: any account whose currency lacks a direct- OR
 * inverse-resolvable rate to `displayCurrency` adds the pair to
 * `missingPairs`. We do NOT throw — `total` is `null` when at least one pair
 * is missing, and the caller surfaces the missing list to the user.
 *
 * `missingPairs` is sorted by `(baseCurrency ASC, quoteCurrency ASC)` so the
 * frontend `useMissingRatePrompt` deeplinks to `missingPairs[0]`
 * deterministically.
 */
function aggregateInDisplayCurrency(
  accounts: Array<{ accountId: string; currency: string }>,
  balances: Map<string, string>,
  rates: ExchangeRateRow[],
  displayCurrency: string,
): ComputedAggregate {
  let total = new Decimal(0);
  const missingSet = new Map<string, MissingPair>();

  for (const account of accounts) {
    const balanceRaw = balances.get(account.accountId) ?? '0.00';
    const balance = new Decimal(balanceRaw);
    if (account.currency === displayCurrency) {
      total = total.plus(balance);
      continue;
    }
    const rate = findSpotRateInMemory(rates, account.currency, displayCurrency);
    if (rate === null) {
      const key = `${account.currency}->${displayCurrency}`;
      if (!missingSet.has(key)) {
        missingSet.set(key, {
          baseCurrency: account.currency,
          quoteCurrency: displayCurrency,
        });
      }
      continue;
    }
    total = total.plus(balance.times(rate).toDecimalPlaces(4, Decimal.ROUND_HALF_UP));
  }

  const missingPairs = Array.from(missingSet.values()).sort((a, b) => {
    if (a.baseCurrency !== b.baseCurrency) {
      return a.baseCurrency < b.baseCurrency ? -1 : 1;
    }
    if (a.quoteCurrency !== b.quoteCurrency) {
      return a.quoteCurrency < b.quoteCurrency ? -1 : 1;
    }
    return 0;
  });

  if (missingPairs.length > 0) {
    return { total: null, missingPairs };
  }
  return { total, missingPairs: [] };
}

/**
 * In-memory analogue of `findSpotRate` (Req 4.3) — direct match (latest
 * `effectiveDate` ≤ today) first, else inverse, else `null`. No
 * triangulation (Req 4.4).
 */
function findSpotRateInMemory(
  rates: ExchangeRateRow[],
  base: string,
  quote: string,
): Decimal | null {
  const today = new Date().toISOString().slice(0, 10);

  let directBest: ExchangeRateRow | null = null;
  let inverseBest: ExchangeRateRow | null = null;

  for (const row of rates) {
    if (row.effectiveDate > today) continue;
    if (row.baseCurrency === base && row.quoteCurrency === quote) {
      if (directBest === null || row.effectiveDate > directBest.effectiveDate) {
        directBest = row;
      }
    } else if (row.baseCurrency === quote && row.quoteCurrency === base) {
      if (inverseBest === null || row.effectiveDate > inverseBest.effectiveDate) {
        inverseBest = row;
      }
    }
  }

  if (directBest !== null) return new Decimal(directBest.rate);
  if (inverseBest !== null) return new Decimal(1).dividedBy(new Decimal(inverseBest.rate));
  return null;
}

/**
 * Produce the proposed rate set with `change` applied to the live set.
 *
 * - `upsert`: replace the matching `(base, quote, effectiveDate)` row, or
 *   insert if absent.
 * - `delete`: remove the row with `id === rateId`. (Existence already
 *   verified by the caller before this point.)
 *
 * Pure — does NOT mutate the input array.
 */
function applyProposedChange(
  rates: ExchangeRateRow[],
  change: PreviewRateChangeInput,
): ExchangeRateRow[] {
  if (change.intent === 'delete') {
    return rates.filter((r) => r.id !== change.rateId);
  }
  const proposed = change.rate;
  const existingIdx = rates.findIndex(
    (r) =>
      r.baseCurrency === proposed.baseCurrency &&
      r.quoteCurrency === proposed.quoteCurrency &&
      r.effectiveDate === proposed.effectiveDate,
  );
  // The in-memory row uses synthetic placeholders for id/createdAt — these
  // fields are never read by the aggregate calculation.
  const synthetic: ExchangeRateRow = {
    id: existingIdx >= 0 ? rates[existingIdx].id : '00000000-0000-0000-0000-000000000000',
    userId: existingIdx >= 0 ? rates[existingIdx].userId : '',
    baseCurrency: proposed.baseCurrency,
    quoteCurrency: proposed.quoteCurrency,
    rate: proposed.rate,
    effectiveDate: proposed.effectiveDate,
    createdAt: existingIdx >= 0 ? rates[existingIdx].createdAt : new Date(),
  };
  if (existingIdx >= 0) {
    const next = rates.slice();
    next[existingIdx] = synthetic;
    return next;
  }
  return [...rates, synthetic];
}

/**
 * Symmetric >5% / displayability-flip threshold. See the file header for the
 * full rationale.
 */
function computeExceedsThreshold(before: Decimal | null, after: Decimal | null): boolean {
  const beforeNull = before === null;
  const afterNull = after === null;
  if (beforeNull !== afterNull) return true; // displayability flip
  if (beforeNull || afterNull) return false; // both null
  if (before!.isZero()) return false; // baseline zero — relative move undefined
  const move = after!.minus(before!).abs().dividedBy(before!.abs());
  return move.greaterThan(THRESHOLD);
}

// ---------------------------------------------------------------------------
// Cash balance reconciliation (Req 8, design.md §C11)
// ---------------------------------------------------------------------------

/**
 * Make an account's derived balance equal `targetBalance` by INSERTing one
 * `balance_adjustment` ledger row for the difference.
 *
 * The caller supplies the TARGET, never a delta (Req 8.2). A delta computed in
 * the browser is stale the moment a position close commits; computing it here,
 * inside the same transaction and behind the same row lock as the INSERT, makes
 * `newBalance === targetBalance` a guarantee rather than a hope.
 *
 * What is being reconciled: the account's cash balance as Tradr models it —
 * `starting_balance + realized P&L`. Tradr holds no mark-to-market, so this
 * figure excludes the market value of open positions. That is a product
 * decision (Req 8, "What is being reconciled"), and the obligation it creates
 * is disclosure in the UI (Req 8.11), not a guard here: open positions do NOT
 * block or warn at this layer.
 *
 * Append-only. This adds a row; it never edits or deletes one. A wrong figure
 * is corrected by reconciling again (Req 8.9) — both rows persist as the audit
 * trail.
 */
export async function reconcileAccountBalance(
  db: Database,
  userId: string,
  accountId: string,
  targetBalance: string,
): Promise<{ entry: LedgerEntryRow; previousBalance: string; newBalance: string }> {
  return withTransaction(db, async (tx) => {
    const locked = await lockAccountForUpdate(tx, userId, accountId);
    if (!locked) throw new NotFoundError('Account', accountId);

    const target = new Decimal(targetBalance);

    // The user types a figure read off a broker statement, so it must be
    // expressible in that currency's minor units (Req 8.6). The close hook
    // applies the same rule via InvariantViolationError; here the input is
    // user-supplied, so a 400 is the correct shape rather than a 500.
    const minorUnits = getCurrencyMinorUnits(locked.currency);
    if (target.decimalPlaces() > minorUnits) {
      throw new ValidationError(
        `Target balance ${targetBalance} has more decimal places than ${locked.currency} allows (${minorUnits})`,
      );
    }

    const [account] = await findAccountById(tx, accountId, userId);
    // `balance` is a numeric(18,4) rendered to text by the projection — hand it
    // straight to Decimal. NEVER parseFloat a numeric column.
    const previous = new Decimal(account.balance);
    const delta = target.minus(previous);

    if (delta.isZero()) {
      throw new ConflictError('Account balance already matches the target');
    }

    // `amount` is a non-negative magnitude (`ledger_amount_nonneg_chk`); the
    // sign lives in `direction`, exactly as it does for position P&L.
    const [entry] = await insertLedgerEntries(tx, [
      {
        userId,
        accountId,
        positionId: null,
        entryType: 'balance_adjustment',
        direction: delta.isPositive() ? 'credit' : 'debit',
        amount: delta.abs().toFixed(4),
        currency: locked.currency,
        symbol: null,
        occurredAt: new Date(),
        groupId: crypto.randomUUID(),
        reversesGroupId: null,
      },
    ]);

    return {
      entry,
      previousBalance: previous.toFixed(4),
      newBalance: target.toFixed(4),
    };
  });
}

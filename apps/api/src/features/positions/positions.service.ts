import Decimal from 'decimal.js';

import { getCurrencyMinorUnits, parseOccSymbol } from '@tradr/shared';

import type { Database, Transaction } from '@/db';
import {
  findAccountById,
  countAccountsByUser,
  resolveWritableAccountId,
} from '@/features/accounts/accounts.query';
import { getTierContext } from '@/features/billing/tier.query';
import {
  AppError,
  NotFoundError,
  ConflictError,
  ValidationError,
  HookAlreadyRegisteredError,
  InvariantViolationError,
} from '@/lib/errors';
import { captureServerEvent } from '@/lib/posthog';
import { withTransaction } from '@/lib/transaction';

import { insertFill, findFillById, updateFill, deleteFill } from './fills.query';
import { aggregateFills, computePnlFromTotals } from './pnl';
import type { FillTotals } from './pnl';
import {
  insertPosition,
  countPositionsByUser,
  findPositionListByUser,
  findPositionById,
  findPositionWithAccount,
  findFillsByPosition,
  findPositionForUpdate,
  updatePosition,
  deletePosition,
  countFillsByType,
  sumFillQuantityByType,
  reopenedWithoutNewFills,
} from './positions.query';
import { computeRiskReward } from './risk-reward';
import {
  exitWouldExceedEntry,
  hasAtLeastOneEntry,
  reconciles,
  closeNotBeforeOpen,
  isWholeContracts,
} from './segment-invariants';

interface PgError {
  code?: string;
  detail?: string;
}
function isPgError(err: unknown): err is PgError {
  return typeof err === 'object' && err !== null && 'code' in err;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawRow = Record<string, any>;

// Calendar date (YYYY-MM-DD) of `date` as observed in the given IANA timezone.
// `Intl.DateTimeFormat('en-CA', …)` renders the zone-local date in ISO order
// with zero-padding, so a plain string compare of two keys is a same-day test.
// Used by the R13 reopen same-day guard (never UTC — a US-Eastern evening
// session crosses UTC midnight but stays one trading day). Node's ICU is the
// IANA authority here, so there is no hand-maintained zone table to rot.
function zonedDateKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

// --- Close-hook registry (design.md §Component 1) ---
// Named-callback registry that `closePosition` invokes inside its transaction.
// `position` and `account` track the actual return shapes of `updatePosition`
// and `findAccountById` — both already return camelCase typed rows via
// Drizzle's `.returning()` / `.select({...})` semantics, so no normalization
// is needed at the boundary.
export type CloseHookContext = {
  position: Awaited<ReturnType<typeof updatePosition>>[number];
  account: Awaited<ReturnType<typeof findAccountById>>[number];
  netPnl: string;
};

export type CloseHook = (tx: Transaction, ctx: CloseHookContext) => Promise<void>;

// Module-private map of registered hooks. Not exported.
const closeHooks = new Map<string, CloseHook>();

export function registerCloseHook(name: string, hook: CloseHook): void {
  if (closeHooks.has(name)) {
    throw new HookAlreadyRegisteredError(name);
  }
  closeHooks.set(name, hook);
}

export function unregisterCloseHook(name: string): void {
  closeHooks.delete(name);
}

// Insert-or-overwrite; never throws. Used by `bootstrap()` for idempotency and
// by tests that want "install this regardless of prior state".
export function replaceCloseHook(name: string, hook: CloseHook): void {
  closeHooks.set(name, hook);
}

export function listCloseHooks(): string[] {
  return Array.from(closeHooks.keys());
}

// --- Reverse-hook registry (design.md §Amendment C10; Req 7.5) ---
// Symmetric to the close-hook registry so positions↔accounting stay decoupled:
// the accounting module registers `reverseCloseForPosition` under a 'ledger'
// reverse-hook name; positions never imports accounting. `reopenPosition` /
// `removePosition` (position-lifecycle) invoke registered reverse hooks inside
// their transaction to neutralize a prior close (Req 7.1, 7.5). The context
// carries only `{ positionId, userId, occurredAt }` — the reversal reads what
// it needs by `positionId`, so callers need not build a full close context.
export type ReverseHookContext = { positionId: string; userId: string; occurredAt?: Date };
export type ReverseHook = (tx: Transaction, ctx: ReverseHookContext) => Promise<void>;

// Module-private map of registered reverse hooks. Not exported.
const reverseHooks = new Map<string, ReverseHook>();

export function registerReverseHook(name: string, hook: ReverseHook): void {
  if (reverseHooks.has(name)) {
    throw new HookAlreadyRegisteredError(name);
  }
  reverseHooks.set(name, hook);
}

export function unregisterReverseHook(name: string): void {
  reverseHooks.delete(name);
}

// Insert-or-overwrite; never throws. Used by `bootstrap()` for idempotency and
// by tests that want "install this regardless of prior state".
export function replaceReverseHook(name: string, hook: ReverseHook): void {
  reverseHooks.set(name, hook);
}

export function listReverseHooks(): string[] {
  return Array.from(reverseHooks.keys());
}

// --- Fill-hook registry (design.md §Amendment C16; Req 9.8) ---
// Third registry, same shape as the other two. Fired on every fill mutation so
// realized P&L posts as it happens rather than only when a position goes flat
// (Req 9).
//
// The context carries the position's CUMULATIVE realized P&L, computed here by
// `buildFillHookContext` — deliberately NOT identifiers-only. Computing it needs
// fills, `aggregateFills` and `computePnlFromTotals`, all of which are the
// positions feature's domain; making the hook fetch them would force a runtime
// import from accounting into positions and break the decoupling the hook
// registries exist to preserve. This mirrors `CloseHookContext`, which passes a
// precomputed `netPnl` for exactly the same reason.
//
// `occurredAt` is the triggering fill's `filledAt` — trade time, not edit time
// (the removed fill's, for removals).
export type FillHookContext = {
  positionId: string;
  userId: string;
  accountId: string;
  currency: string;
  symbol: string;
  /** Cumulative realized P&L over all fills, at scale 4. '0' when no exits yet. */
  cumulativeRealizedPnl: string;
  occurredAt: Date;
};
export type FillHook = (tx: Transaction, ctx: FillHookContext) => Promise<void>;

// Module-private map of registered fill hooks. Not exported.
const fillHooks = new Map<string, FillHook>();

export function registerFillHook(name: string, hook: FillHook): void {
  if (fillHooks.has(name)) {
    throw new HookAlreadyRegisteredError(name);
  }
  fillHooks.set(name, hook);
}

export function unregisterFillHook(name: string): void {
  fillHooks.delete(name);
}

// Insert-or-overwrite; never throws. Used by `bootstrap()` for idempotency and
// by tests that want "install this regardless of prior state".
export function replaceFillHook(name: string, hook: FillHook): void {
  fillHooks.set(name, hook);
}

export function listFillHooks(): string[] {
  return Array.from(fillHooks.keys());
}

/**
 * Build a FillHookContext for a position and run every registered fill hook
 * inside the caller's transaction. Extracted so the three seams — `addFillTx`,
 * `editFill`, `removeFill` — share one call shape.
 *
 * Short-circuits when no fill hooks are registered, so environments without the
 * accounting module (most unit tests) pay nothing: no position read, no fills
 * read. Same posture as the close flow's "no hook registered ⇒ no extra reads".
 *
 * Unlike `buildCloseHookContext`, a null `realizedPnl` is NOT an invariant
 * violation here — an entry-only position legitimately has no realized P&L yet.
 * It maps to '0', and the hook's delta rule then posts nothing (Req 9.4).
 */
export async function runFillHooks(
  tx: Transaction,
  positionId: string,
  userId: string,
  occurredAt: Date,
): Promise<void> {
  if (fillHooks.size === 0) return;

  const positionRows = await findPositionById(tx, positionId, userId);
  if (positionRows.length === 0) {
    throw new InvariantViolationError(
      `position ${positionId} not found at fill-hook call site for user ${userId}`,
    );
  }
  const position = positionRows[0];

  const accountRows = await findAccountById(tx, position.accountId, userId);
  if (accountRows.length === 0) {
    throw new InvariantViolationError(
      `account ${position.accountId} not found at fill-hook call site for user ${userId}`,
    );
  }
  const account = accountRows[0];

  const fills = await findFillsByPosition(tx, positionId);
  const totals = aggregateFills(
    fills.map((f) => ({ type: f.type, price: f.price, quantity: f.quantity, fees: f.fees })),
  );
  const pnl = computePnlFromTotals(
    totals,
    position.side as 'long' | 'short',
    position.assetType as 'stock' | 'option',
    getCurrencyMinorUnits(account.currency),
  );

  const ctx: FillHookContext = {
    positionId,
    userId,
    accountId: position.accountId,
    currency: account.currency,
    symbol: position.symbol,
    // null ⇒ no exits yet ⇒ nothing realized. Boundary conversion matches
    // buildCloseHookContext: number → Decimal → 4dp string under the
    // bootstrap-pinned ROUND_HALF_UP.
    cumulativeRealizedPnl: pnl.realizedPnl === null ? '0' : new Decimal(pnl.realizedPnl).toFixed(4),
    occurredAt,
  };

  for (const hook of fillHooks.values()) {
    await hook(tx, ctx);
  }
}

// --- Ledger hook co-registration invariant (Req 7.8, extended by Req 9.13) ---
// Dropping `ledger_position_pnl_unique_idx` (task 26) removes the only DB-level
// guard against a duplicate un-reversed `position_pnl` per position. The
// state-machine guarantee holds ONLY if every close hook has a same-named
// reverse hook to neutralize prior postings on reopen/delete.
//
// Req 9 extends this to the fill hook: partial P&L posted by a fill hook must
// be reversible on reopen too, so a fill hook without its reverse hook is the
// same class of bug. `bootstrap()` calls this after registering all three
// production hooks; it throws if any close hook lacks a same-named reverse or
// fill hook. (The other directions — a reverse or fill hook without a close
// hook — are harmless and intentionally not asserted.)
export function assertLedgerHooksCoRegistered(): void {
  const registeredReverse = new Set(reverseHooks.keys());
  const registeredFill = new Set(fillHooks.keys());
  const orphaned = Array.from(closeHooks.keys()).filter(
    (name) => !registeredReverse.has(name) || !registeredFill.has(name),
  );
  if (orphaned.length > 0) {
    throw new InvariantViolationError(
      `close hook(s) registered without same-named reverse and fill hooks: ${orphaned.join(', ')}`,
    );
  }
}

// --- buildCloseHookContext (design.md §Component 2) ---
// Extracted helper — testable seam. Builds a CloseHookContext from a
// closed-position row. Throws InvariantViolationError on any internal
// inconsistency (account missing, realizedPnl null). Unit-tested with
// mocked findAccountById/findFillsByPosition to cover the invariant
// branches without requiring FK bypass under SAVEPOINT isolation.
export async function buildCloseHookContext(
  tx: Transaction,
  position: Awaited<ReturnType<typeof updatePosition>>[number],
  userId: string,
): Promise<CloseHookContext> {
  const accountRows = await findAccountById(tx, position.accountId, userId);
  if (accountRows.length === 0) {
    throw new InvariantViolationError(
      `account ${position.accountId} not found at close-hook call site for user ${userId}`,
    );
  }
  const account = accountRows[0];
  const fills = await findFillsByPosition(tx, position.id);
  // Map the raw Drizzle fill rows to the {type, price, quantity, fees}
  // shape `aggregateFills` consumes — matching the existing convention in
  // `positions.query.ts` (`getPositionDetail`). Passing raw rows works
  // structurally but breaks repo style.
  const totals = aggregateFills(
    fills.map((f) => ({ type: f.type, price: f.price, quantity: f.quantity, fees: f.fees })),
  );
  const minorUnits = getCurrencyMinorUnits(account.currency);
  // computePnlFromTotals consumes the per-fill fees already stored on
  // fills.fees — no separate fee-schedule fetch is needed here.
  const pnl = computePnlFromTotals(
    totals,
    position.side as 'long' | 'short',
    position.assetType as 'stock' | 'option',
    minorUnits,
  );
  if (pnl.realizedPnl === null) {
    throw new InvariantViolationError(
      'realizedPnl null at close hook call site — fills should always be non-empty for a closeable position',
    );
  }
  // Boundary conversion: number → Decimal → string. Magnitudes here are
  // well under 2^53; round-trip is precision-safe. Global Decimal config
  // (pinned in bootstrap) sets ROUND_HALF_UP so toFixed matches the
  // rounding mode used inside computePnlFromTotals.
  const netPnl = new Decimal(pnl.realizedPnl).toFixed(4);
  return { position, account, netPnl };
}

// Public wrapper — owns its own transaction and maps the FK `23503` violation
// on `account_id` to NotFoundError (single-call semantics; this swallow is only
// safe because this statement owns the tx — design.md §Component 7b).
export async function createPosition(
  db: Database,
  userId: string,
  data: {
    accountId: string;
    symbol: string;
    side: string;
    assetType: string;
    notes?: string | null;
    targetPrice?: string | null;
    stopLoss?: string | null;
  },
  // Routes pass `isAdmin` from AuthEnv — services never read Hono context
  // (plan-tiers D9).
  gate: { isAdmin: boolean },
) {
  try {
    const position = await withTransaction(db, async (tx) => {
      // Plan-tiers enforcement (D9/D18) — single-create path only. The bulk
      // CSV path runs its own Phase-A checks in `commitImport`, so
      // `createPositionTx` stays check-free, and NO check exists on any
      // REQ-6.5 never-blocked path (close/fill/edit/delete/state
      // transitions). Admin / gating-off pass through with zero behaviour
      // change. 403s are terminal-for-state — never 429, no Retry-After.
      const tier = await getTierContext(tx, { userId, isAdmin: gate.isAdmin });
      if (tier.enforced) {
        // L2: per-user position cap (indexed count(*); accepted
        // concurrent-overshoot posture, REQ-6.3).
        if (tier.limits.positions !== null) {
          const positionCount = await countPositionsByUser(tx, userId);
          if (positionCount >= tier.limits.positions) {
            captureServerEvent('tier_limit_hit', {
              distinctId: userId,
              properties: { lever: 'positions' },
            });
            throw new AppError(
              403,
              'TIER_LIMIT_POSITIONS',
              `Your plan allows ${tier.limits.positions} positions. Upgrade to Pro for unlimited positions.`,
            );
          }
        }
        // L1 writability (D18): while over the account cap, new trading data
        // may only target the effective writable designation.
        if (tier.limits.accounts !== null) {
          const accountCount = await countAccountsByUser(tx, userId);
          if (accountCount > tier.limits.accounts) {
            const writableAccountId = await resolveWritableAccountId(tx, userId);
            if (data.accountId !== writableAccountId) {
              captureServerEvent('tier_limit_hit', {
                distinctId: userId,
                properties: { lever: 'accounts' },
              });
              throw new AppError(
                403,
                'TIER_ACCOUNT_NOT_WRITABLE',
                'This account is not writable on your current plan. New positions can only target your designated writable account — change the designation or upgrade to Pro.',
              );
            }
          }
        }
      }
      return createPositionTx(tx, userId, data);
    });
    // Fire-and-forget business event AFTER the tx commits (design Component 4,
    // REQ-4.2/4.4) — in the outer single-operation fn only, never in
    // createPositionTx (the bulk-import path), and carrying identifiers/enums
    // only (assetType), never financial values (REQ-4.3/8.1). The inner guard
    // keeps a telemetry fault from ever failing the committed business op.
    try {
      captureServerEvent('position_created', {
        distinctId: userId,
        properties: { assetType: data.assetType },
      });
    } catch {
      // ignore — capture is fire-and-forget
    }
    return position;
  } catch (err: unknown) {
    // FK violation on account_id (concurrent delete)
    if (isPgError(err) && err.code === '23503' && err.detail?.includes('account_id')) {
      throw new NotFoundError('Account', data.accountId);
    }
    throw err;
  }
}

// Tx-accepting variant — runs directly on the passed tx (NO re-wrap / savepoint)
// and is catch-free: a constraint error propagates and rolls back the caller's
// transaction (the bulk-import all-or-nothing guarantee, REQ-8.2).
export async function createPositionTx(
  tx: Transaction,
  userId: string,
  data: {
    accountId: string;
    symbol: string;
    side: string;
    assetType: string;
    notes?: string | null;
    targetPrice?: string | null;
    stopLoss?: string | null;
  },
) {
  // Verify account ownership
  const accountRows = await findAccountById(tx, data.accountId, userId);
  if (accountRows.length === 0) {
    throw new NotFoundError('Account', data.accountId);
  }

  const rows = await insertPosition(tx, { userId, ...data });
  return rows[0];
}

export async function listPositions(
  db: Database,
  userId: string,
  filters?: { status?: string; accountId?: string },
) {
  const rows = await findPositionListByUser(db, userId, filters);

  return (rows as RawRow[]).map((row) => {
    const totals: FillTotals = {
      entryQty: String(row.entry_qty),
      exitQty: String(row.exit_qty),
      entryCost: String(row.entry_cost),
      exitCost: String(row.exit_cost),
      entryFees: String(row.entry_fees),
      exitFees: String(row.exit_fees),
    };

    const currencyMinorUnits = getCurrencyMinorUnits(row.account_currency);
    const pnl = computePnlFromTotals(
      totals,
      row.side as 'long' | 'short',
      row.asset_type as 'stock' | 'option',
      currencyMinorUnits,
    );

    const brokerageName: string | null = row.brokerage_name ?? null;

    // Net realized P&L is `computePnlFromTotals`, full stop — it has ALREADY
    // subtracted `exitFees` and the pro-rated `allocatedEntryFees` recorded on
    // the fills.
    //
    // This previously did `pnl.realizedPnl − calculateFees(feeSchedule)`, under
    // the local name `grossPnl`. That name was the bug: the value is not gross,
    // so the schedule was being subtracted a SECOND time on top of fees already
    // stored on the fills. A brokerage fee schedule is an entry-time convenience
    // (FillDialog computes the fee from it as the user types, overridable, and
    // stores the result on `fills.fees`); it is not a reporting input, and
    // re-applying it at read time double-counts.
    const netPnl = pnl.realizedPnl;
    const grossPnl = pnl.grossPnl;
    // Fees actually recorded on the fills, not a schedule estimate.
    const brokerageFees = pnl.fees ?? 0;

    // Trade-plan fields & R/R (R14). `target_price`/`stop_loss` arrive via
    // `p.*` as raw Drizzle numeric strings — pass them straight into
    // computeRiskReward (numeric rule: no parseFloat/Number). The response
    // fields are numbers, so convert the strings via decimal.js.
    const targetPriceRaw: string | null = row.target_price ?? null;
    const stopLossRaw: string | null = row.stop_loss ?? null;
    const { targetRR, actualRR } = computeRiskReward({
      avgEntryPrice: pnl.avgEntryPrice,
      avgExitPrice: pnl.avgExitPrice,
      side: row.side as 'long' | 'short',
      targetPrice: targetPriceRaw,
      stopLoss: stopLossRaw,
    });

    return {
      id: row.id,
      userId: row.user_id,
      accountId: row.account_id,
      symbol: row.symbol,
      side: row.side,
      assetType: row.asset_type,
      status: row.status,
      notes: row.notes,
      openedAt: row.opened_at,
      closedAt: row.closed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      accountName: row.account_name,
      accountCurrency: row.account_currency,
      accountTimezone: row.account_timezone,
      ...pnl,
      brokerageName,
      grossPnl,
      brokerageFees,
      netPnl,
      targetPrice: targetPriceRaw === null ? null : new Decimal(targetPriceRaw).toNumber(),
      stopLoss: stopLossRaw === null ? null : new Decimal(stopLossRaw).toNumber(),
      targetRR,
      actualRR,
      openUnits: pnl.totalEntryQuantity - pnl.totalExitQuantity,
      closedUnits: pnl.totalExitQuantity,
    };
  });
}

export async function getPositionDetail(db: Database, id: string, userId: string) {
  const positionRows = await findPositionWithAccount(db, id, userId);
  if (positionRows.length === 0) {
    throw new NotFoundError('Position', id);
  }

  const row = positionRows[0];
  const { position, accountCurrency, accountTimezone } = row;
  const fillRows = await findFillsByPosition(db, position.id);

  const totals = aggregateFills(
    fillRows.map((f) => ({
      type: f.type,
      price: f.price,
      quantity: f.quantity,
      fees: f.fees,
    })),
  );

  const currencyMinorUnits = getCurrencyMinorUnits(accountCurrency);
  const pnl = computePnlFromTotals(
    totals,
    position.side as 'long' | 'short',
    position.assetType as 'stock' | 'option',
    currencyMinorUnits,
  );

  const brokerageName: string | null = row.brokerageName ?? null;

  // Same unification as the list path above: `computePnlFromTotals` has already
  // netted the fees recorded on the fills. Re-applying the brokerage schedule
  // here double-counted them — see the comment at the list site.
  const netPnl = pnl.realizedPnl;
  const grossPnl = pnl.grossPnl;
  const brokerageFees = pnl.fees ?? 0;

  // Trade-plan fields & R/R (R14). `position.targetPrice`/`position.stopLoss`
  // are raw Drizzle numeric strings — pass straight into computeRiskReward
  // (numeric rule), and convert to numbers for the response via decimal.js.
  // Same pure function + same avgEntry/avgExit/side/plan inputs as the list
  // path guarantees list/detail parity for targetRR/actualRR/openUnits/
  // closedUnits (the existing P&L parity guarantee extended).
  const { targetRR, actualRR } = computeRiskReward({
    avgEntryPrice: pnl.avgEntryPrice,
    avgExitPrice: pnl.avgExitPrice,
    side: position.side as 'long' | 'short',
    targetPrice: position.targetPrice,
    stopLoss: position.stopLoss,
  });

  return {
    ...position,
    // Account timezone defines the trading day the client uses to decide
    // whether a closed position may be reopened (R13 same-day rule). Surfaced
    // here so the frontend need not duplicate or guess the account's zone.
    accountTimezone,
    fills: fillRows,
    ...pnl,
    brokerageName,
    grossPnl,
    brokerageFees,
    netPnl,
    targetPrice:
      position.targetPrice === null ? null : new Decimal(position.targetPrice).toNumber(),
    stopLoss: position.stopLoss === null ? null : new Decimal(position.stopLoss).toNumber(),
    targetRR,
    actualRR,
    openUnits: pnl.totalEntryQuantity - pnl.totalExitQuantity,
    closedUnits: pnl.totalExitQuantity,
  };
}

export async function editPosition(
  db: Database,
  id: string,
  userId: string,
  data: {
    accountId?: string;
    symbol?: string;
    side?: string;
    assetType?: string;
    notes?: string | null;
    targetPrice?: string | null;
    stopLoss?: string | null;
  },
) {
  return withTransaction(db, async (tx) => {
    const rows = await findPositionById(tx, id, userId);
    if (rows.length === 0) throw new NotFoundError('Position', id);

    const position = rows[0];

    if (position.status !== 'draft') {
      // Open/closed: only plan annotations may change. `targetPrice`/`stopLoss`
      // join `notes` as always-editable (R2 amendment 2026-07-17) — they do not
      // affect fill quantities. Everything else (symbol/side/assetType/
      // accountId) stays draft-only.
      const alwaysAllowed = new Set(['notes', 'targetPrice', 'stopLoss']);
      const restrictedKeys = Object.keys(data)
        .filter((k) => !alwaysAllowed.has(k))
        .filter((k) => data[k as keyof typeof data] !== undefined);
      if (restrictedKeys.length > 0) {
        throw new ConflictError(
          `Cannot update ${restrictedKeys.join(', ')} on a ${position.status} position`,
        );
      }
    }

    // --- Service backstop (design.md §Component 3, REQ-5.2/5.3/5.5) ---
    // Authoritative server-side update gate: Zod cannot read the stored row's
    // assetType, so re-validate here. Both checks compare normalised values.
    const normalize = (s: string) => s.trim().toUpperCase();

    // (REQ-5.5) Reject any asset-type change — closes the option→stock→option
    // symbol-laundering vector and enforces the no-conversion scope.
    if (data.assetType !== undefined && data.assetType !== position.assetType) {
      throw new ConflictError('Cannot change the asset type of an existing position');
    }

    // (REQ-5.2/5.3) Re-validate a CHANGED option symbol. A normalisation-only
    // difference counts as unchanged, so a legacy non-OCC option row stays
    // editable for notes via a notes-only PUT that omits `symbol`.
    const effectiveAssetType = data.assetType ?? position.assetType;
    if (data.symbol !== undefined && normalize(data.symbol) !== normalize(position.symbol)) {
      if (effectiveAssetType === 'option' && !parseOccSymbol(normalize(data.symbol)).ok) {
        throw new ValidationError('Option symbol must be a valid OCC contract', {
          symbol: 'Option symbol must be a valid OCC contract (e.g. NVDA260321C120)',
        });
      }
    }

    if (data.accountId && data.accountId !== position.accountId) {
      const accountRows = await findAccountById(tx, data.accountId, userId);
      if (accountRows.length === 0) {
        throw new NotFoundError('Account', data.accountId);
      }
    }

    const result = await updatePosition(tx, id, userId, data);
    return result[0];
  });
}

export async function removePosition(db: Database, id: string, userId: string) {
  return withTransaction(db, async (tx) => {
    // Amended Data Integrity NFR (2026-07-17): load under a row lock so the
    // status/delete decision is serialized against concurrent transitions.
    const lockRows = await findPositionForUpdate(tx, id, userId);
    if ((lockRows as RawRow[]).length === 0) throw new NotFoundError('Position', id);

    // R4 amendment (task 23b): DELETE is now uniform across every status. Invoke
    // the registered reverse hooks FIRST, under the close-hook lock order
    // (`positions` FOR UPDATE already held above → `ledger_entries` written here)
    // — NOT the canonical alphabetical order, which would deadlock the close
    // flow. The 'ledger' reverse hook posts a `position_pnl_reversal` for any
    // un-reversed `position_pnl` (the close entry). It is IDEMPOTENT and keyed
    // by positionId, so it MUST run before the delete nulls that FK: a
    // draft/never-closed position has no position_pnl (no-op); a reopened-open
    // position was already reversed on reopen (no-op); a closed position posts
    // the reversal. Safe and correct on EVERY delete regardless of status.
    if (reverseHooks.size > 0) {
      const ctx: ReverseHookContext = { positionId: id, userId, occurredAt: new Date() };
      // Snapshot before iterating: freezes invocation order against a concurrent
      // replaceReverseHook racing across await points (matches reopenPositionTx).
      const hooks = Array.from(reverseHooks.entries());
      for (const [, hook] of hooks) {
        await hook(tx, ctx);
      }
    }

    // Then hard-delete the position. Fills cascade via `ON DELETE CASCADE`, and
    // `ledger_entries.positionId ON DELETE SET NULL` nulls BOTH the original
    // position_pnl and the just-inserted reversal — they remain append-only in
    // the ledger with NULL positionId, netting to zero in the balance and
    // dropping out of the expenses tax inner-join (ledger-balances Req 7.7).
    await deletePosition(tx, id, userId);
  });
}

export async function openPosition(db: Database, id: string, userId: string, openedAt?: string) {
  return withTransaction(db, (tx) => openPositionTx(tx, id, userId, openedAt));
}

// Tx-accepting variant — runs directly on the passed tx (no re-wrap / savepoint).
export async function openPositionTx(
  tx: Transaction,
  id: string,
  userId: string,
  openedAt?: string,
) {
  const lockRows = await findPositionForUpdate(tx, id, userId);
  if ((lockRows as RawRow[]).length === 0) {
    throw new NotFoundError('Position', id);
  }

  const position = (lockRows as RawRow[])[0];

  if (position.status !== 'draft') {
    throw new ConflictError(`Cannot open a ${position.status} position`);
  }

  const [{ count }] = await countFillsByType(tx, id, 'entry');
  if (!hasAtLeastOneEntry(count)) {
    throw new ConflictError('Position must have at least one entry fill to open');
  }

  const result = await updatePosition(tx, id, userId, {
    status: 'open',
    openedAt: openedAt ? new Date(openedAt) : new Date(),
  });
  return result[0];
}

export async function closePosition(db: Database, id: string, userId: string, closedAt?: string) {
  const position = await withTransaction(db, (tx) => closePositionTx(tx, id, userId, closedAt));
  // Fire-and-forget business event AFTER the tx commits (design Component 4,
  // REQ-4.2/4.4) — in the outer single-operation fn only, never in
  // closePositionTx (the bulk-import path). assetType comes off the returned
  // row (identifiers/enums only — no financial values, REQ-4.3/8.1). The inner
  // guard keeps a telemetry fault from ever failing the committed business op.
  try {
    captureServerEvent('position_closed', {
      distinctId: userId,
      properties: { assetType: position.assetType },
    });
  } catch {
    // ignore — capture is fire-and-forget
  }
  return position;
}

// Tx-accepting variant — runs directly on the passed tx (no re-wrap / savepoint).
// Retains the close-hook-firing block verbatim so the ledger hook fires inside
// the injected (e.g. bulk-import) transaction (design.md §Component 7b).
export async function closePositionTx(
  tx: Transaction,
  id: string,
  userId: string,
  closedAt?: string,
) {
  const lockRows = await findPositionForUpdate(tx, id, userId);
  if ((lockRows as RawRow[]).length === 0) {
    throw new NotFoundError('Position', id);
  }

  const position = (lockRows as RawRow[])[0];

  if (position.status !== 'open') {
    throw new ConflictError(`Cannot close a ${position.status} position`);
  }

  const [{ total: entryTotal }] = await sumFillQuantityByType(tx, id, 'entry');
  const [{ total: exitTotal }] = await sumFillQuantityByType(tx, id, 'exit');

  if (!reconciles(entryTotal, exitTotal)) {
    throw new ConflictError(
      'Position must be fully exited to close (exit quantity ≠ entry quantity)',
    );
  }

  // Transient zero-open-units guard (R13 reopen mitigation; design "Reopen
  // mechanics"). Right after a reopen the position is `open` with
  // `entryQty == exitQty` (openUnits == 0) carried over from the prior close, so
  // `reconciles` above passes immediately and a no-op re-close would churn the
  // ledger with no new activity. We CANNOT simply reject `openUnits == 0` — that
  // is exactly the state of every legitimate close. The real distinction is
  // whether any fill was added since the last reopen; `reopenedWithoutNewFills`
  // answers that from DB insertion timestamps (see its doc), so a normal close
  // (including a first close, or one preceded by a notes/plan edit) is never
  // affected.
  if (await reopenedWithoutNewFills(tx, id)) {
    throw new ConflictError('Add a fill before closing — nothing has changed since the reopen');
  }

  if (closedAt) {
    if (!closeNotBeforeOpen(position.opened_at ?? null, closedAt)) {
      throw new ValidationError('Close date cannot precede open date');
    }
  }

  const result = await updatePosition(tx, id, userId, {
    status: 'closed',
    closedAt: closedAt ? new Date(closedAt) : new Date(),
  });

  // Cross-spec contract: `pnl.realizedPnl` is `number | null` (see
  // requirements.md §Cross-spec Contracts). Any future change to that
  // type must be coordinated with this call site's boundary conversion
  // inside `buildCloseHookContext`.
  // Latch the flat snapshot BEFORE the hooks run, so it is set whether or not
  // the accounting module is registered. `netPnl` here is the same
  // `computePnlFromTotals` figure every other surface uses.
  const closedAtInstant = closedAt ? new Date(closedAt) : new Date();
  const flatTotals = aggregateFills(
    (await findFillsByPosition(tx, id)).map((f) => ({
      type: f.type,
      price: f.price,
      quantity: f.quantity,
      fees: f.fees,
    })),
  );
  const flatAccountRows = await findAccountById(tx, result[0].accountId, userId);
  if (flatAccountRows.length > 0) {
    const flatPnl = computePnlFromTotals(
      flatTotals,
      result[0].side as 'long' | 'short',
      result[0].assetType as 'stock' | 'option',
      getCurrencyMinorUnits(flatAccountRows[0].currency),
    );
    await updatePosition(tx, id, userId, {
      lastFlatAt: closedAtInstant,
      lastFlatNetPnl: new Decimal(flatPnl.realizedPnl ?? 0).toFixed(4),
    });
  }

  if (closeHooks.size > 0) {
    const ctx = await buildCloseHookContext(tx, result[0], userId);
    // Snapshot the hook list before iterating: freezes the invocation
    // order against concurrent replaceCloseHook calls racing the loop
    // across await points.
    const hooks = Array.from(closeHooks.entries());
    for (const [, hook] of hooks) {
      await hook(tx, ctx);
    }
  }

  return result[0];
}

export async function reopenPosition(
  db: Database,
  id: string,
  userId: string,
  reopenedAt?: string,
) {
  return withTransaction(db, (tx) => reopenPositionTx(tx, id, userId, reopenedAt));
}

// Tx-accepting variant — runs directly on the passed tx (no re-wrap / savepoint).
// Realizes the Closed→Open transition (R13). Mirrors open/close: lock the row
// FOR UPDATE, then validate inside the lock. The reverse hook fires inside the
// tx to neutralize the prior close's ledger row so a re-close cannot double
// count (R13 "accounting on reopen"). Lock order: positions (FOR UPDATE) →
// ledger_entries (structure.md close-hook exception).
export async function reopenPositionTx(
  tx: Transaction,
  id: string,
  userId: string,
  reopenedAt?: string,
) {
  const lockRows = await findPositionForUpdate(tx, id, userId);
  if ((lockRows as RawRow[]).length === 0) {
    throw new NotFoundError('Position', id);
  }

  const position = (lockRows as RawRow[])[0];

  if (position.status !== 'closed') {
    throw new ConflictError(`Cannot reopen a ${position.status} position`);
  }

  const reopenAt = reopenedAt ? new Date(reopenedAt) : new Date();

  // reopenedAt bounds (R13-AC8, mirrors R7-AC4): a supplied timestamp may not
  // precede the close nor lie in the future. Without this a client could
  // backdate `reopenedAt` onto the open day to defeat the same-day guard below.
  if (reopenedAt) {
    const closedAt = position.closed_at ? new Date(position.closed_at) : null;
    if (closedAt && reopenAt.getTime() < closedAt.getTime()) {
      throw new ValidationError('Reopen date cannot precede the close date');
    }
    if (reopenAt.getTime() > Date.now()) {
      throw new ValidationError('Reopen date cannot be in the future');
    }
  }

  // Same-day guard in the ACCOUNT's timezone (R13-AC1/AC2, R1 amendment), never
  // UTC. openedAt is preserved (AC4) and defines the identity day.
  const accountRows = await findAccountById(tx, position.account_id, userId);
  if (accountRows.length === 0) {
    throw new NotFoundError('Account', position.account_id);
  }
  const timeZone = accountRows[0].timezone;
  const openedAt = position.opened_at ? new Date(position.opened_at) : null;
  if (openedAt === null || zonedDateKey(openedAt, timeZone) !== zonedDateKey(reopenAt, timeZone)) {
    throw new ConflictError(
      'This position was opened on a previous day — create a new position instead',
    );
  }

  // Flip Closed→Open. openedAt is left untouched (AC4); the
  // `positions_closed_at_when_closed_chk` CHECK is satisfied since status=open
  // and closed_at=null move together.
  //
  // `lastFlatAt` / `lastFlatNetPnl` are deliberately NOT cleared: the
  // completed-trade statistics keep reporting this position's last flat value
  // until it goes flat again, at which point the close overwrites the snapshot.
  const result = await updatePosition(tx, id, userId, {
    status: 'open',
    closedAt: null,
  });

  // Post the reversing ledger row(s) for the prior close (R13 "accounting on
  // reopen"). Mirror closePositionTx's iteration over the private hook registry;
  // the co-registered `ledger` reverse hook delegates to reverseCloseForPosition,
  // which is idempotent (never-closed / already-reversed → no-op).
  if (reverseHooks.size > 0) {
    const ctx: ReverseHookContext = { positionId: id, userId, occurredAt: reopenAt };
    // Snapshot before iterating: freezes invocation order against a concurrent
    // replaceReverseHook racing across await points (matches closePositionTx).
    const hooks = Array.from(reverseHooks.entries());
    for (const [, hook] of hooks) {
      await hook(tx, ctx);
    }
  }

  return result[0];
}

// --- Fill operations ---

export async function addFill(
  db: Database,
  positionId: string,
  userId: string,
  data: {
    type: string;
    price: string;
    quantity: string;
    fees: string;
    notes?: string | null;
    filledAt: string;
  },
) {
  const { fill, closed } = await withTransaction(db, async (tx) => {
    const inserted = await addFillTx(tx, positionId, userId, data);

    // Auto-close (R7 amendment): an open position with nothing left open IS
    // closed, so the exit that balances entry quantity performs the transition
    // itself. Without this the position sits `open` with zero open units until
    // the user runs a separate close, which is a step with no decision in it.
    //
    // Deliberately here and NOT in addFillTx: the bulk importers (csv-import,
    // demo seed) call addFillTx directly and drive their own closePositionTx.
    // Auto-closing underneath them would make that follow-up call 409 against
    // an already-closed position. Same outer/inner split as
    // closePosition/closePositionTx.
    if (data.type !== 'exit') return { fill: inserted, closed: null };

    const [{ total: entryTotal }] = await sumFillQuantityByType(tx, positionId, 'entry');
    const [{ total: exitTotal }] = await sumFillQuantityByType(tx, positionId, 'exit');
    if (!reconciles(entryTotal, exitTotal)) return { fill: inserted, closed: null };

    const lockRows = await findPositionForUpdate(tx, positionId, userId);
    const position = (lockRows as RawRow[])[0];
    if (position?.status !== 'open') return { fill: inserted, closed: null };

    // closedAt is the fill's own timestamp — the position closed when its last
    // exit executed, not when the request was made. That accuracy matters:
    // closedAt feeds the tax and performance summaries, so stamping "now" onto
    // a trade being journalled after the fact would misreport it.
    //
    // Clamped to openedAt, because a backdated exit CAN legitimately precede
    // it: `POST /open` with no body stamps openedAt as now, so a user who
    // records historical fills afterwards has fills older than the open. Left
    // unclamped, closePositionTx's closeNotBeforeOpen guard would reject the
    // whole request and the fill itself would fail to save.
    const openedAt = position.opened_at ? new Date(position.opened_at) : null;
    const filledAt = new Date(data.filledAt);
    const closedAt = openedAt && filledAt < openedAt ? openedAt : filledAt;

    // closePositionTx re-locks the row (already held by this tx) and fires the
    // ledger close hook.
    const closedRow = await closePositionTx(tx, positionId, userId, closedAt.toISOString());
    return { fill: inserted, closed: closedRow };
  });

  // Same fire-and-forget business event a manual close emits, so an auto-close
  // is not invisible to analytics. After commit, never inside the tx.
  if (closed) {
    try {
      captureServerEvent('position_closed', {
        distinctId: userId,
        properties: { assetType: closed.assetType },
      });
    } catch {
      // ignore — capture is fire-and-forget
    }
  }

  return fill;
}

// Tx-accepting variant — runs directly on the passed tx (no re-wrap / savepoint).
export async function addFillTx(
  tx: Transaction,
  positionId: string,
  userId: string,
  data: {
    type: string;
    price: string;
    quantity: string;
    fees: string;
    notes?: string | null;
    filledAt: string;
  },
) {
  const lockRows = await findPositionForUpdate(tx, positionId, userId);
  if ((lockRows as RawRow[]).length === 0) {
    throw new NotFoundError('Position', positionId);
  }

  const position = (lockRows as RawRow[])[0];

  if (position.status === 'closed') {
    throw new ConflictError('Cannot add fills to a closed position');
  }

  if (data.type === 'exit' && position.status === 'draft') {
    throw new ConflictError('Cannot add exit fill to a draft position');
  }

  // Validate option integer quantity
  if (position.asset_type === 'option') {
    if (!isWholeContracts(data.quantity)) {
      throw new ValidationError('Option quantity must be a whole number');
    }
  }

  if (data.type === 'exit') {
    const [{ total: entryTotal }] = await sumFillQuantityByType(tx, positionId, 'entry');
    const [{ total: exitTotal }] = await sumFillQuantityByType(tx, positionId, 'exit');
    if (exitWouldExceedEntry(entryTotal, exitTotal, data.quantity)) {
      throw new ValidationError('Exit quantity would exceed available entry quantity');
    }
  }

  const rows = await insertFill(tx, {
    positionId,
    type: data.type,
    price: data.price,
    quantity: data.quantity,
    fees: data.fees,
    notes: data.notes,
    filledAt: new Date(data.filledAt),
  });

  // Post the realized-P&L delta for this fill (Req 9.9). Deliberately on the
  // INNER tx variant, not `addFill`: the bulk importers (csv-import, demo seed)
  // call `addFillTx` directly, and hooking only the outer function would leave
  // every imported trade unposted.
  await runFillHooks(tx, positionId, userId, new Date(data.filledAt));

  return rows[0];
}

export async function editFill(
  db: Database,
  positionId: string,
  fillId: string,
  userId: string,
  data: {
    price?: string;
    quantity?: string;
    fees?: string;
    notes?: string | null;
    filledAt?: string;
  },
) {
  return withTransaction(db, async (tx) => {
    const lockRows = await findPositionForUpdate(tx, positionId, userId);
    if ((lockRows as RawRow[]).length === 0) {
      throw new NotFoundError('Position', positionId);
    }

    const position = (lockRows as RawRow[])[0];

    const fillRows = await findFillById(tx, fillId, positionId);
    if (fillRows.length === 0) {
      throw new NotFoundError('Fill', fillId);
    }
    const fill = fillRows[0];

    // Validate option integer quantity
    if (data.quantity && position.asset_type === 'option') {
      const qty = new Decimal(data.quantity);
      if (!qty.isInteger()) {
        throw new ValidationError('Option quantity must be a whole number');
      }
    }

    if (position.status === 'closed' && data.quantity) {
      // On closed positions, quantity changes that break the balance are rejected
      const [{ total: entryTotal }] = await sumFillQuantityByType(tx, positionId, 'entry');
      const [{ total: exitTotal }] = await sumFillQuantityByType(tx, positionId, 'exit');

      let newEntryTotal = new Decimal(entryTotal);
      let newExitTotal = new Decimal(exitTotal);

      if (fill.type === 'entry') {
        newEntryTotal = newEntryTotal
          .minus(new Decimal(fill.quantity))
          .plus(new Decimal(data.quantity));
      } else {
        newExitTotal = newExitTotal
          .minus(new Decimal(fill.quantity))
          .plus(new Decimal(data.quantity));
      }

      if (!newEntryTotal.equals(newExitTotal)) {
        throw new ConflictError(
          'Cannot modify fills on a closed position in a way that changes quantity balance',
        );
      }
    }

    if (position.status !== 'closed' && data.quantity && fill.type === 'exit') {
      // For open positions, check exit qty doesn't exceed entry
      const [{ total: entryTotal }] = await sumFillQuantityByType(tx, positionId, 'entry');
      const [{ total: exitTotal }] = await sumFillQuantityByType(tx, positionId, 'exit');
      const newExitTotal = new Decimal(exitTotal)
        .minus(new Decimal(fill.quantity))
        .plus(new Decimal(data.quantity));
      if (newExitTotal.greaterThan(new Decimal(entryTotal))) {
        throw new ValidationError('Exit quantity would exceed available entry quantity');
      }
    }

    const updateData: Record<string, unknown> = {};
    if (data.price !== undefined) updateData.price = data.price;
    if (data.quantity !== undefined) updateData.quantity = data.quantity;
    if (data.fees !== undefined) updateData.fees = data.fees;
    if (data.notes !== undefined) updateData.notes = data.notes;
    if (data.filledAt !== undefined) updateData.filledAt = new Date(data.filledAt);

    const rows = await updateFill(tx, fillId, positionId, updateData);

    // Re-derive realized P&L (Req 9.9). A price/quantity/fee edit changes the
    // cumulative amount, and the delta rule posts the difference — a correcting
    // debit when the edit reduces P&L. `occurredAt` is the fill's own timestamp,
    // post-edit, so the ledger's time axis stays trade time rather than edit time.
    await runFillHooks(tx, positionId, userId, rows[0].filledAt);

    return rows[0];
  });
}

export async function removeFill(db: Database, positionId: string, fillId: string, userId: string) {
  return withTransaction(db, async (tx) => {
    const lockRows = await findPositionForUpdate(tx, positionId, userId);
    if ((lockRows as RawRow[]).length === 0) {
      throw new NotFoundError('Position', positionId);
    }

    const position = (lockRows as RawRow[])[0];

    if (position.status === 'closed') {
      throw new ConflictError('Cannot delete fills on a closed position');
    }

    const fillRows = await findFillById(tx, fillId, positionId);
    if (fillRows.length === 0) {
      throw new NotFoundError('Fill', fillId);
    }
    const fill = fillRows[0];

    if (fill.type === 'entry' && position.status === 'open') {
      const [{ total: entryTotal }] = await sumFillQuantityByType(tx, positionId, 'entry');
      const [{ total: exitTotal }] = await sumFillQuantityByType(tx, positionId, 'exit');

      const newEntryTotal = new Decimal(entryTotal).minus(new Decimal(fill.quantity));

      if (newEntryTotal.isZero()) {
        throw new ConflictError('Cannot delete fill: at least one entry fill must remain');
      }

      if (newEntryTotal.lessThan(new Decimal(exitTotal))) {
        throw new ConflictError('Cannot remove entry fill while exit fills depend on it');
      }
    }

    await deleteFill(tx, fillId, positionId);

    // Re-derive realized P&L (Req 9.9). Deleting an exit un-realizes it, so the
    // delta goes negative and posts a correcting debit. `occurredAt` is the
    // removed fill's own timestamp — the correction belongs at the trade time it
    // undoes, not at the time the user noticed.
    await runFillHooks(tx, positionId, userId, fill.filledAt);
  });
}

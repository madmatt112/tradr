import Decimal from 'decimal.js';

import { getCurrencyMinorUnits } from '@tradr/shared';

import type { CloseHook, FillHook, ReverseHook } from '@/features/positions/positions.service';
import { InvariantViolationError } from '@/lib/errors';

import {
  insertLedgerEntries,
  reverseCloseForPosition,
  sumPostedRealizedForPosition,
} from './accounting.query';

/**
 * The one posting rule (design.md §Amendment C15; Req 9.1).
 *
 *     delta = cumulativeRealizedNow − alreadyPostedForThisPosition
 *
 * Both the fill hook and the close hook route through this, so there is exactly
 * ONE place in the system that decides what a realized-P&L row looks like.
 *
 * Why a delta rather than the event's own amount:
 *  - **Idempotent.** Running it twice posts nothing the second time.
 *  - **Edits and deletes need no special case.** A recompute that goes down
 *    posts a negative delta as a debit. Fills on open positions are freely
 *    editable, and a late entry fill legitimately changes average cost and so
 *    retroactively changes P&L already realized.
 *  - **Fee proration stays exact.** Entry fees are allocated by
 *    `exitQty / entryQty`, so every recompute reprices the whole position;
 *    accumulating per-fill amounts instead would drift.
 *  - **The close hook becomes a natural no-op** once everything is posted.
 *
 * Append-only: a correction is a new row, never an UPDATE or DELETE.
 */
async function postRealizedDelta(
  // Derived from the hook contract rather than imported from '@/db': this module
  // is banned from importing the global db handle (ESLint no-restricted-imports
  // + the source tripwire in accounting.service.test.ts), and the ban is on the
  // module path, not just the runtime value.
  tx: Parameters<FillHook>[0],
  params: {
    userId: string;
    accountId: string;
    positionId: string;
    currency: string;
    symbol: string;
    cumulativeRealizedPnl: string;
    occurredAt: Date;
    /** Close-hook only: honour Req 2's amount-0 row when nothing is posted yet. */
    postZeroWhenUnposted?: boolean;
  },
): Promise<void> {
  const {
    userId,
    accountId,
    positionId,
    currency,
    symbol,
    cumulativeRealizedPnl,
    occurredAt,
    postZeroWhenUnposted = false,
  } = params;

  const cumulative = new Decimal(cumulativeRealizedPnl);
  const minorUnits = getCurrencyMinorUnits(currency);
  if (cumulative.decimalPlaces() > minorUnits) {
    throw new InvariantViolationError(
      `cumulative realized P&L ${cumulativeRealizedPnl} has more decimal places than ${currency} allows (${minorUnits})`,
    );
  }

  const posted = await sumPostedRealizedForPosition(tx, { userId, positionId });
  const delta = cumulative.minus(posted.total);

  // Nothing changed — the overwhelmingly common case (an entry-only position, a
  // close after everything is already posted, a no-op edit). Keeps the ledger
  // free of zero-amount noise.
  //
  // EXCEPT for `postZeroWhenUnposted`, which the close hook sets. Req 2 mandates
  // an amount-0 row for an exact-zero-P&L close, and it is load-bearing: the tax
  // summary INNER JOINs ledger_entries -> positions, so a closed position with no
  // ledger row at all would vanish from realized-P&L reporting entirely. The two
  // zeros are different events — "nothing changed" is a no-op, "this position
  // closed flat" is a fact worth recording. Keyed on rowCount, not total.isZero(),
  // so a position whose postings merely NET to zero does not get a spurious extra
  // row.
  if (delta.isZero() && !(postZeroWhenUnposted && posted.rowCount === 0)) return;

  await insertLedgerEntries(tx, [
    {
      userId,
      accountId,
      positionId,
      entryType: 'position_pnl',
      // `amount` is a non-negative magnitude (`ledger_amount_nonneg_chk`); the
      // sign lives in `direction`.
      direction: delta.isPositive() ? 'credit' : 'debit',
      amount: delta.abs().toFixed(4),
      currency,
      symbol,
      occurredAt,
      groupId: crypto.randomUUID(),
      reversesGroupId: null,
    },
  ]);
}

/**
 * Fill hook (design.md §Amendment C16; Req 9.1, 9.9). Fires on every fill
 * mutation — add, edit, remove — so realized P&L lands as it happens instead of
 * only when the position goes flat.
 *
 * Registered under the `'ledger'` fill-hook name in `app.ts bootstrap()`,
 * co-registered with the close and reverse hooks (Req 9.13).
 *
 * DB access is via `tx` only — this module MUST NOT import the global `db`
 * handle. An ESLint `no-restricted-imports` rule scoped to this file enforces
 * the invariant; the regex tripwire in `accounting.service.test.ts` is
 * belt-and-suspenders.
 */
export const postFillLedgerEntries: FillHook = async (tx, ctx) => {
  await postRealizedDelta(tx, {
    userId: ctx.userId,
    accountId: ctx.accountId,
    positionId: ctx.positionId,
    currency: ctx.currency,
    symbol: ctx.symbol,
    cumulativeRealizedPnl: ctx.cumulativeRealizedPnl,
    occurredAt: ctx.occurredAt,
  });
};

/**
 * Close hook (design.md §Component 3, collapsed onto the delta rule by
 * §Amendment C17).
 *
 * It no longer computes its own full-P&L row. `ctx.netPnl` is the position's
 * cumulative realized P&L — the same quantity the fill hook works from — so the
 * close posts whatever remains unposted. After partial exits that is the
 * remainder; on a fully-posted position it is nothing at all.
 *
 * Pre-amendment behaviour is preserved exactly for the common case: a position
 * with one entry and one balancing exit realizes nothing on the entry, its full
 * P&L on the exit, and zero at the close — one row, same amount, same
 * `occurredAt`, because auto-close stamps `closedAt` from the balancing fill's
 * `filledAt`. See §C18.
 */
export const insertPositionCloseLedgerEntries: CloseHook = async (tx, ctx) => {
  const { position, account, netPnl } = ctx;
  await postRealizedDelta(tx, {
    userId: position.userId,
    accountId: account.id,
    positionId: position.id,
    currency: account.currency,
    symbol: position.symbol,
    cumulativeRealizedPnl: netPnl,
    occurredAt: position.closedAt ?? new Date(),
    // Req 2: an exact-zero-P&L close still emits one amount-0 credit row.
    postZeroWhenUnposted: true,
  });
};

/**
 * Reverse hook implementation (design.md §Amendment C10; Req 7.5). Symmetric to
 * the close hook: neutralizes a position's prior postings by INSERTing a
 * flipped-direction `position_pnl_reversal` row per un-reversed `position_pnl`
 * (delegated to `reverseCloseForPosition`). Append-only — never DELETE/PATCH.
 *
 * Unchanged by Req 9 and already correct for multi-row positions: it reverses
 * EVERY un-reversed row, and `sumPostedRealizedForPosition` counts only
 * un-reversed rows, so a reopen resets the posted baseline to zero and the
 * re-close posts the full cumulative amount once.
 *
 * Registered under the `'ledger'` reverse-hook name in `app.ts bootstrap()`,
 * co-registered with the close and fill hooks (Req 7.8, 9.13). `reopenPosition`
 * / `removePosition` (position-lifecycle) invoke it inside their transaction. DB
 * access is via `tx` only — same `@/db`-import ban as the other hooks. The
 * reverse-query return value is intentionally discarded (the hook contract is
 * `Promise<void>`); callers that need the inserted rows use the query directly.
 */
export const reversePositionCloseLedgerEntries: ReverseHook = async (tx, ctx) => {
  await reverseCloseForPosition(tx, ctx);
};

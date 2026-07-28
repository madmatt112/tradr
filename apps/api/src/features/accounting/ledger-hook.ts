import Decimal from 'decimal.js';

import { getCurrencyMinorUnits } from '@tradr/shared';

import type { CloseHook, ReverseHook } from '@/features/positions/positions.service';
import { InvariantViolationError } from '@/lib/errors';

import { insertLedgerEntries, reverseCloseForPosition } from './accounting.query';

/**
 * Close hook implementation (design.md §Component 3). Emits exactly ONE
 * ledger entry per position close:
 *   - `credit` for profit-or-zero P&L
 *   - `debit`  for a loss
 *
 * DB access is via `tx` only — this module MUST NOT import the global `db`
 * handle. An ESLint `no-restricted-imports` rule scoped to this file
 * enforces the invariant (see `eslint.config.js`); the regex tripwire in
 * `accounting.service.test.ts` is belt-and-suspenders.
 *
 * `groupId` is application-generated (not a DB default) so the deferred
 * reversal spec (d-536e8750) can insert rows referencing it via
 * `reversesGroupId`. v1 always sets `reversesGroupId: null`.
 */
export const insertPositionCloseLedgerEntries: CloseHook = async (tx, ctx) => {
  const { position, account, netPnl } = ctx;
  const decimal = new Decimal(netPnl);
  const minorUnits = getCurrencyMinorUnits(account.currency);

  if (decimal.decimalPlaces() > minorUnits) {
    throw new InvariantViolationError(
      `netPnl ${netPnl} has more decimal places than ${account.currency} allows (${minorUnits})`,
    );
  }

  const magnitude = decimal.abs().toFixed(4);
  const isZero = decimal.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).isZero();
  const isProfit = !isZero && decimal.isPositive();

  const groupId = crypto.randomUUID();
  const occurredAt = position.closedAt ?? new Date();

  await insertLedgerEntries(tx, [
    {
      userId: position.userId,
      accountId: account.id,
      positionId: position.id,
      entryType: 'position_pnl',
      direction: isProfit || isZero ? 'credit' : 'debit',
      amount: magnitude,
      currency: account.currency,
      symbol: position.symbol,
      occurredAt,
      groupId,
      reversesGroupId: null,
    },
  ]);
};

/**
 * Reverse hook implementation (design.md §Amendment C10; Req 7.5). Symmetric to
 * the close hook: neutralizes a position's prior close(s) by INSERTing a
 * flipped-direction `position_pnl_reversal` row per un-reversed `position_pnl`
 * (delegated to `reverseCloseForPosition`). Append-only — never DELETE/PATCH.
 *
 * Registered under the `'ledger'` reverse-hook name in `app.ts bootstrap()`,
 * co-registered with the close hook (Req 7.8). `reopenPosition` /
 * `removePosition` (position-lifecycle) invoke it inside their transaction. DB
 * access is via `tx` only — same `@/db`-import ban as the close hook. The
 * reverse-query return value is intentionally discarded (the hook contract is
 * `Promise<void>`); callers that need the inserted rows use the query directly.
 */
export const reversePositionCloseLedgerEntries: ReverseHook = async (tx, ctx) => {
  await reverseCloseForPosition(tx, ctx);
};

/**
 * Settlement core, worthless outcome (design C3; task 7 of
 * option-lifecycle-events). Black-box over `settleLeg`/`settleLegTx`
 * directly — the house style from `option-seams.test.ts`: seed via raw
 * inserts and the existing `*Tx` seams, drive the function under test, assert
 * on committed state. No route exists yet (task 13), so every call here is
 * service-level.
 *
 * Contract block — one entry per success criterion this task covers.
 * Pre-condition → call through the seam → observable result → source of the
 * expected value.
 *
 * A. Short leg settles worthless after expiry (AC 2.4, AC 2.6 default fee)
 *   Pre: an open short option leg, one entry fill, no fee given, read after
 *     its expiry instant.
 *   Call: `settleLeg(db, userId, legId, { outcome: 'worthless' })`.
 *   Result: a new exit fill for all open units at price 0, fee 0, dated at
 *     the expiry instant; the leg closes with `closedAt` at that instant.
 *   Source: design C3 post-conditions 5-7; requirements AC 2.4, AC 2.6.
 *
 * B. Long leg settles worthless after expiry (AC 2.4)
 *   Pre: an open long option leg, one entry fill, read after its expiry
 *     instant.
 *   Call: `settleLeg(db, userId, legId, { outcome: 'worthless' })`.
 *   Result: same shape as A — exit at price 0 for all open units dated at
 *     the instant, leg closes at that instant.
 *   Source: requirements AC 2.4 ("a short and a long leg each settle...").
 *
 * C. An explicit fee lands on the worthless exit (AC 2.6)
 *   Pre: as A, settled with `fees: '1.25'`.
 *   Call: `settleLeg(db, userId, legId, { outcome: 'worthless', fees: '1.25' })`.
 *   Result: the written exit fill's `fees` is 1.25; the entry fill's fee is
 *     untouched.
 *   Source: design C3 post-condition 6; requirements AC 2.6.
 *
 * D. Worthless before the expiry instant is a 400 with no write
 *   Pre: an open leg; `now` one millisecond before its expiry instant.
 *   Call: `settleLegTx(tx, userId, legId, { outcome: 'worthless' }, now)`
 *     inside `withTransaction`.
 *   Result: rejects `ValidationError`; the leg stays open with its one
 *     original fill.
 *   Source: design C3 post-condition 2; requirements AC 2.4 refusal clause.
 *
 * E. Worthless carrying an explicit settledAt is a 400 with no write
 *   Pre: an open leg, read after its expiry instant.
 *   Call: `settleLeg(db, userId, legId, { outcome: 'worthless', settledAt })`.
 *   Result: rejects `ValidationError`; no fill or settlement row written.
 *   Source: design C3 post-condition 2.
 *
 * F. Worthless carrying an explicit quantity is a 400 with no write
 *   Pre: an open leg, read after its expiry instant.
 *   Call: `settleLeg(db, userId, legId, { outcome: 'worthless', quantity })`.
 *   Result: rejects `ValidationError`; no fill or settlement row written.
 *   Source: design C3 post-condition 2.
 *
 * G. Settling a stock position is a 400 (AC 2.1)
 *   Pre: an open stock position (not an option leg).
 *   Call: `settleLeg(db, userId, legId, { outcome: 'worthless' })`.
 *   Result: rejects `ValidationError`; no write.
 *   Source: design C3 post-condition 2; requirements AC 2.1.
 *
 * H. An outcome illegal for the leg's side is a 400 (AC 2.1)
 *   Pre: an open short leg (accepts worthless or assigned only).
 *   Call: `settleLeg(db, userId, legId, { outcome: 'exercised' })`.
 *   Result: rejects `ValidationError`; no write.
 *   Source: requirements AC 2.1 ("a short leg accepts worthless or
 *     assigned... anything else is a 400").
 *
 * I. An unparsable symbol is a 409 with the reason (AC 1.4)
 *   Pre: an open option leg carrying a legacy, non-OCC symbol.
 *   Call: `settleLeg(db, userId, legId, { outcome: 'worthless' })`.
 *   Result: rejects `ConflictError` whose message contains
 *     `parseOccSymbol`'s own failure reason for that symbol.
 *   Source: design C3 post-condition 2; requirements AC 1.4.
 *
 * J. A leg with no open units is a 409 (AC 2.8)
 *   Pre: an open leg whose entry and exit fills already net to zero units.
 *   Call: `settleLeg(db, userId, legId, { outcome: 'worthless' })`.
 *   Result: rejects `ConflictError`.
 *   Source: design C3 post-condition 2; requirements AC 2.8.
 *
 * K. The record holds outcome, quantity, premium, fill ids, the touched row
 *    and its prior latch pair (AC 2.9)
 *   Pre: an open short leg, one entry fill, never previously closed.
 *   Call: `settleLeg(db, userId, legId, { outcome: 'worthless' })`.
 *   Result: `option_settlements` carries outcome/quantity/premium;
 *     `option_settlement_rows` carries one row for the leg,
 *     `closedRow: true`, `priorLastFlatAt`/`priorLastFlatNetPnl` null;
 *     `option_settlement_fills` carries the written exit fill id and the
 *     baseline entry fill id.
 *   Source: design C3 post-condition 8, Data Models; requirements AC 2.9.
 *
 * L. A user at the tier cap can settle (AC 2.10)
 *   Pre: a user already at the free plan's position cap, gating on.
 *   Call: `settleLeg(db, userId, legId, { outcome: 'worthless' })`.
 *   Result: succeeds — no `TIER_LIMIT_POSITIONS` refusal.
 *   Source: design C3 Restrictions ("no assertPositionCreateAllowed");
 *     requirements AC 2.10.
 *
 * M. A registered fill hook posts the delta at the instant (NFR Reliability)
 *   Pre: an open leg; a fill hook registered to record the contexts it is
 *     called with.
 *   Call: `settleLeg(db, userId, legId, { outcome: 'worthless' })`.
 *   Result: the hook runs exactly once, with `occurredAt` equal to the
 *     expiry instant (the written exit fill's own `filledAt`).
 *   Source: requirements NFR Reliability; positions.service.ts
 *     `addFillTx`'s existing `runFillHooks` call.
 *
 * N. A throwing hook rolls back the fill, close and record, and emits no
 *    event (NFR Reliability, AC 11.7)
 *   Pre: an open leg; a fill hook registered to throw.
 *   Call: `settleLeg(db, userId, legId, { outcome: 'worthless' })`.
 *   Result: rejects; the leg stays open with its one original fill; no
 *     settlement row exists; `captureServerEvent` is never called.
 *   Source: requirements NFR Reliability; design Error Handling #4.
 *
 * O. A refused settlement fires no hook (NFR Reliability)
 *   Pre: an open leg; a fill hook registered to record calls; `now` before
 *     the expiry instant, so worthless is refused.
 *   Call: `settleLegTx(tx, userId, legId, { outcome: 'worthless' }, now)`
 *     inside `withTransaction`.
 *   Result: rejects; the hook is never called.
 *   Source: requirements NFR Reliability.
 *
 * P. position_settled carries enums only, after commit (AC 11.7)
 *   Pre: an open leg, read after its expiry instant.
 *   Call: `settleLeg(db, userId, legId, { outcome: 'worthless' })`.
 *   Result: `captureServerEvent` is called exactly once with
 *     `'position_settled'` and properties `{ outcome, source: 'manual' }`
 *     only (no legId/premium/quantity); the settlement row is already
 *     queryable when the call happens (after commit).
 *   Source: design C3 ("emits position_settled (outcome, source; enums
 *     only) after commit"); requirements AC 11.7.
 *
 * Folded/out-of-scope criteria (recorded, not separately retested here):
 *   - AC 2.6's "default 0" half folds into test A, which settles with no
 *     `fees` key and asserts the written exit's fee is 0; C then covers the
 *     explicit-fee half on the same code path.
 *   - AC 2.7 (lock ordering/atomicity) and the `_how-its-built.json` /
 *     eslint / check-types checklist items are restrictions and
 *     implementer-side checks, not success criteria the prompt lists under
 *     "Success:" — not retested here. N's rollback assertion is the closest
 *     observable proxy for atomicity this task's scope allows (the
 *     multi-row lock-ordering path belongs to task 8's stock side).
 *   - `assigned`/`exercised` stock-side behaviour (design C3 table, AC 3.*)
 *     is out of scope: the task prompt's own bridge has step 6's stock side
 *     throw a `ValidationError` for those outcomes until task 8. H exercises
 *     that only incidentally, through the side/outcome legality check that
 *     runs before the bridge is ever reached.
 */
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseOccSymbol } from '@tradr/shared';

import { db } from '@/db';
import {
  accounts,
  fills,
  optionSettlementFills,
  optionSettlementRows,
  optionSettlements,
  positions,
  users,
} from '@/db/schema';
import {
  insertPositionCloseLedgerEntries,
  reversePositionCloseLedgerEntries,
} from '@/features/accounting/ledger-hook';
import { getTierLimits } from '@/features/billing/tier-limits.constants';
import { getTaxSummary } from '@/features/expenses/expenses.service';
import { findLotSelectionsByPosition } from '@/features/positions/fills.query';
import { settleLeg, settleLegTx } from '@/features/positions/option-settlement.service';
import * as positionGroupsQuery from '@/features/positions/position-groups.query';
import {
  addFillTx,
  closeIfBalancedTx,
  closePositionTx,
  createPositionTx,
  listPositionLots,
  openPositionTx,
  registerFillHook,
  replaceCloseHook,
  replaceReverseHook,
  reopenPositionTx,
  unregisterCloseHook,
  unregisterFillHook,
  unregisterReverseHook,
  type FillHookContext,
} from '@/features/positions/positions.service';
import { config } from '@/lib/config';
import { ConflictError, ValidationError } from '@/lib/errors';
import * as posthog from '@/lib/posthog';
import { withTransaction } from '@/lib/transaction';

// Form-3 OCC symbols proven to parse in options.test.ts, expiring
// 2026-07-17 (instant 2026-07-17T20:00:00.000Z — AC 1.2's own July value).
const CALL_SYMBOL = 'AAPL260717C00150000';
const PUT_SYMBOL = 'AAPL260717P00150000';
const EXPIRY_INSTANT = new Date('2026-07-17T20:00:00.000Z');
const BEFORE_EXPIRY = '2026-06-01T00:00:00.000Z';

const HOOK_NAMES = ['option-settlement-spy', 'option-settlement-throw', 'option-settlement-o'];

afterEach(() => {
  for (const name of HOOK_NAMES) unregisterFillHook(name);
  vi.restoreAllMocks();
});

let counter = 0;
function uniqueEmail() {
  return `option-settlement-${Date.now()}-${++counter}@example.com`;
}

async function seedUserAndAccount() {
  const [user] = await db
    .insert(users)
    .values({ email: uniqueEmail(), passwordHash: 'x'.repeat(60) })
    .returning();
  const [account] = await db
    .insert(accounts)
    .values({ userId: user!.id, name: 'Settlement Account', currency: 'USD' })
    .returning();
  return { userId: user!.id, accountId: account!.id };
}

async function createOptionLeg(params: {
  side: 'long' | 'short';
  symbol: string;
  entryPrice: string;
  entryQty: string;
  entryFees?: string;
  filledAt: string;
}) {
  const { userId, accountId } = await seedUserAndAccount();
  const { legId, entryFillId } = await withTransaction(db, async (tx) => {
    const pos = await createPositionTx(tx, userId, {
      accountId,
      symbol: params.symbol,
      side: params.side,
      assetType: 'option',
    });
    const entryFill = await addFillTx(tx, pos!.id, userId, {
      type: 'entry',
      price: params.entryPrice,
      quantity: params.entryQty,
      fees: params.entryFees ?? '0',
      filledAt: params.filledAt,
    });
    await openPositionTx(tx, pos!.id, userId, params.filledAt);
    return { legId: pos!.id, entryFillId: entryFill.id as string };
  });
  return { userId, accountId, legId, entryFillId };
}

async function getPositionRow(id: string) {
  const rows = await db.select().from(positions).where(eq(positions.id, id));
  return rows[0]!;
}

async function getFillsForLeg(legId: string) {
  return db.select().from(fills).where(eq(fills.positionId, legId));
}

// Builds an OCC-form symbol matching CALL_SYMBOL/PUT_SYMBOL's own 19-char
// shape (ticker + the shared 260717 expiration + C/P + an 8-digit,
// thousandths-scaled strike field) for an arbitrary strike, so every task 8
// scenario below shares one expiry instant (EXPIRY_INSTANT).
function occSymbol(underlying: string, type: 'C' | 'P', strike: number) {
  const strikeField = Math.round(strike * 1000)
    .toString()
    .padStart(8, '0');
  return `${underlying}260717${type}${strikeField}`;
}

async function createStockRow(params: {
  userId: string;
  accountId: string;
  side: 'long' | 'short';
  symbol: string;
  entryPrice: string;
  entryQty: string;
  entryFilledAt: string;
  openedAt?: string;
}) {
  return withTransaction(db, async (tx) => {
    const pos = await createPositionTx(tx, params.userId, {
      accountId: params.accountId,
      symbol: params.symbol,
      side: params.side,
      assetType: 'stock',
    });
    const entryFill = await addFillTx(tx, pos!.id, params.userId, {
      type: 'entry',
      price: params.entryPrice,
      quantity: params.entryQty,
      fees: '0',
      filledAt: params.entryFilledAt,
    });
    await openPositionTx(tx, pos!.id, params.userId, params.openedAt ?? params.entryFilledAt);
    return { positionId: pos!.id, entryFillId: entryFill.id as string };
  });
}

async function getStockRows(accountId: string) {
  return db
    .select()
    .from(positions)
    .where(and(eq(positions.accountId, accountId), eq(positions.assetType, 'stock')));
}

describe('settleLeg — worthless, short leg (AC 2.4, AC 2.6 default fee)', () => {
  it('exits all open units at price 0, dated and closed at the expiry instant, fee defaults to 0', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: CALL_SYMBOL,
      entryPrice: '3',
      entryQty: '5',
      filledAt: BEFORE_EXPIRY,
    });

    const result = await settleLeg(db, userId, legId, { outcome: 'worthless' });
    expect(result.outcome).toBe('worthless');

    const legFills = await getFillsForLeg(legId);
    const exit = legFills.find((f) => f.type === 'exit');
    expect(exit).toBeDefined();
    expect(Number(exit!.price)).toBe(0);
    expect(Number(exit!.quantity)).toBe(5);
    expect(Number(exit!.fees)).toBe(0);
    expect(exit!.filledAt.getTime()).toBe(EXPIRY_INSTANT.getTime());

    const row = await getPositionRow(legId);
    expect(row.status).toBe('closed');
    expect(row.closedAt!.getTime()).toBe(EXPIRY_INSTANT.getTime());
  });
});

describe('settleLeg — worthless, long leg (AC 2.4)', () => {
  it('exits all open units at price 0, dated and closed at the expiry instant', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'long',
      symbol: PUT_SYMBOL,
      entryPrice: '2',
      entryQty: '4',
      filledAt: BEFORE_EXPIRY,
    });

    const result = await settleLeg(db, userId, legId, { outcome: 'worthless' });
    expect(result.outcome).toBe('worthless');

    const legFills = await getFillsForLeg(legId);
    const exit = legFills.find((f) => f.type === 'exit');
    expect(exit).toBeDefined();
    expect(Number(exit!.price)).toBe(0);
    expect(Number(exit!.quantity)).toBe(4);
    expect(exit!.filledAt.getTime()).toBe(EXPIRY_INSTANT.getTime());

    const row = await getPositionRow(legId);
    expect(row.status).toBe('closed');
    expect(row.closedAt!.getTime()).toBe(EXPIRY_INSTANT.getTime());
  });
});

describe('settleLeg — worthless with an explicit fee (AC 2.6)', () => {
  it('lands the fee on the written exit, leaving the entry fee untouched', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: CALL_SYMBOL,
      entryPrice: '3',
      entryQty: '5',
      entryFees: '0.50',
      filledAt: BEFORE_EXPIRY,
    });

    await settleLeg(db, userId, legId, { outcome: 'worthless', fees: '1.25' });

    const legFills = await getFillsForLeg(legId);
    const exit = legFills.find((f) => f.type === 'exit');
    const entry = legFills.find((f) => f.type === 'entry');
    expect(Number(exit!.fees)).toBe(1.25);
    expect(Number(entry!.fees)).toBe(0.5);
  });
});

describe('settleLeg — worthless before the expiry instant is a 400 with no write', () => {
  it('rejects ValidationError and leaves the leg untouched', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: CALL_SYMBOL,
      entryPrice: '3',
      entryQty: '5',
      filledAt: BEFORE_EXPIRY,
    });
    const now = new Date(EXPIRY_INSTANT.getTime() - 1);

    await expect(
      withTransaction(db, (tx) => settleLegTx(tx, userId, legId, { outcome: 'worthless' }, now)),
    ).rejects.toBeInstanceOf(ValidationError);

    const row = await getPositionRow(legId);
    expect(row.status).toBe('open');
    expect(await getFillsForLeg(legId)).toHaveLength(1);
  });
});

describe('settleLeg — worthless carrying an explicit settledAt is a 400 with no write', () => {
  it('rejects ValidationError and writes nothing', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: CALL_SYMBOL,
      entryPrice: '3',
      entryQty: '5',
      filledAt: BEFORE_EXPIRY,
    });

    await expect(
      settleLeg(db, userId, legId, {
        outcome: 'worthless',
        settledAt: '2026-07-18T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const row = await getPositionRow(legId);
    expect(row.status).toBe('open');
    expect(await getFillsForLeg(legId)).toHaveLength(1);
  });
});

describe('settleLeg — worthless carrying an explicit quantity is a 400 with no write', () => {
  it('rejects ValidationError and writes nothing', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: CALL_SYMBOL,
      entryPrice: '3',
      entryQty: '5',
      filledAt: BEFORE_EXPIRY,
    });

    await expect(
      settleLeg(db, userId, legId, { outcome: 'worthless', quantity: '3' }),
    ).rejects.toBeInstanceOf(ValidationError);

    const row = await getPositionRow(legId);
    expect(row.status).toBe('open');
    expect(await getFillsForLeg(legId)).toHaveLength(1);
  });
});

describe('settleLeg — a stock position is a 400 (AC 2.1)', () => {
  it('rejects ValidationError and writes nothing', async () => {
    const { userId, accountId } = await seedUserAndAccount();
    const legId = await withTransaction(db, async (tx) => {
      const pos = await createPositionTx(tx, userId, {
        accountId,
        symbol: 'AAPL',
        side: 'long',
        assetType: 'stock',
      });
      await addFillTx(tx, pos!.id, userId, {
        type: 'entry',
        price: '100',
        quantity: '10',
        fees: '0',
        filledAt: BEFORE_EXPIRY,
      });
      await openPositionTx(tx, pos!.id, userId, BEFORE_EXPIRY);
      return pos!.id;
    });

    await expect(settleLeg(db, userId, legId, { outcome: 'worthless' })).rejects.toBeInstanceOf(
      ValidationError,
    );

    const row = await getPositionRow(legId);
    expect(row.status).toBe('open');
    expect(await getFillsForLeg(legId)).toHaveLength(1);
  });
});

describe('settleLeg — an outcome illegal for the side is a 400 (AC 2.1)', () => {
  it('rejects a short leg given "exercised" with ValidationError', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: CALL_SYMBOL,
      entryPrice: '3',
      entryQty: '5',
      filledAt: BEFORE_EXPIRY,
    });

    await expect(settleLeg(db, userId, legId, { outcome: 'exercised' })).rejects.toBeInstanceOf(
      ValidationError,
    );

    const row = await getPositionRow(legId);
    expect(row.status).toBe('open');
    expect(await getFillsForLeg(legId)).toHaveLength(1);
  });
});

describe('settleLeg — an unparsable symbol is a 409 with the reason (AC 1.4)', () => {
  it('rejects ConflictError naming the parse failure', async () => {
    const legacySymbol = 'AAPL'; // not a valid OCC form
    const parsed = parseOccSymbol(legacySymbol);
    expect(parsed.ok).toBe(false);
    const reason = parsed.ok ? '' : parsed.error.message;

    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: legacySymbol,
      entryPrice: '3',
      entryQty: '5',
      filledAt: BEFORE_EXPIRY,
    });

    const err: unknown = await settleLeg(db, userId, legId, { outcome: 'worthless' }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toContain(reason);
  });
});

describe('settleLeg — a leg with no open units is a 409 (AC 2.8)', () => {
  it('rejects ConflictError', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: CALL_SYMBOL,
      entryPrice: '3',
      entryQty: '5',
      filledAt: BEFORE_EXPIRY,
    });
    // Fully exit via the raw seam (no auto-close), so the leg stays `open`
    // with zero open units — the distinct "no open units" branch of AC 2.8.
    await withTransaction(db, (tx) =>
      addFillTx(tx, legId, userId, {
        type: 'exit',
        price: '3',
        quantity: '5',
        fees: '0',
        filledAt: BEFORE_EXPIRY,
      }),
    );
    expect((await getPositionRow(legId)).status).toBe('open');

    await expect(settleLeg(db, userId, legId, { outcome: 'worthless' })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});

describe('settleLeg — the settlement record (AC 2.9)', () => {
  it('holds outcome, quantity, premium, fill ids, the touched row and its prior latch pair', async () => {
    const { userId, legId, entryFillId } = await createOptionLeg({
      side: 'short',
      symbol: CALL_SYMBOL,
      entryPrice: '3',
      entryQty: '5',
      filledAt: BEFORE_EXPIRY,
    });

    await settleLeg(db, userId, legId, { outcome: 'worthless' });

    const [settlement] = await db
      .select()
      .from(optionSettlements)
      .where(eq(optionSettlements.positionId, legId));
    expect(settlement).toBeDefined();
    expect(settlement!.outcome).toBe('worthless');
    expect(Number(settlement!.quantity)).toBe(5);
    expect(Number(settlement!.premium)).toBe(3);

    const rows = await db
      .select()
      .from(optionSettlementRows)
      .where(eq(optionSettlementRows.settlementId, settlement!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.positionId).toBe(legId);
    expect(rows[0]!.touch).toBe('leg');
    expect(rows[0]!.closedRow).toBe(true);
    expect(rows[0]!.priorLastFlatAt).toBeNull();
    expect(rows[0]!.priorLastFlatNetPnl).toBeNull();

    const settlementFills = await db
      .select()
      .from(optionSettlementFills)
      .where(eq(optionSettlementFills.settlementId, settlement!.id));
    const written = settlementFills.filter((f) => f.written);
    const baseline = settlementFills.filter((f) => !f.written);
    expect(written).toHaveLength(1);
    expect(baseline).toHaveLength(1);
    expect(baseline[0]!.fillId).toBe(entryFillId);

    const [exitFill] = await db
      .select()
      .from(fills)
      .where(and(eq(fills.positionId, legId), eq(fills.type, 'exit')));
    expect(written[0]!.fillId).toBe(exitFill!.id);
  });
});

describe('settleLeg — a user at the tier cap can settle (AC 2.10)', () => {
  const prevGating = config.FEATURE_GATING;
  afterEach(() => {
    config.FEATURE_GATING = prevGating;
  });

  it('settles despite being at the free plan position cap with gating on', async () => {
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: CALL_SYMBOL,
      entryPrice: '3',
      entryQty: '5',
      filledAt: BEFORE_EXPIRY,
    });

    const cap = getTierLimits('free').positions!;
    const rows = Array.from({ length: cap - 1 }, (_, i) => ({
      userId,
      accountId,
      symbol: `SYM${i}`,
      side: 'long',
      assetType: 'stock',
      status: 'open',
    }));
    // eslint-disable-next-line no-restricted-syntax
    await db.insert(positions).values(rows);

    config.FEATURE_GATING = true;

    const result = await settleLeg(db, userId, legId, { outcome: 'worthless' });
    expect(result.outcome).toBe('worthless');
    expect((await getPositionRow(legId)).status).toBe('closed');
  });
});

describe('settleLeg — a registered fill hook posts the delta at the instant (NFR Reliability)', () => {
  it('runs the hook exactly once with occurredAt at the expiry instant', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: CALL_SYMBOL,
      entryPrice: '3',
      entryQty: '5',
      filledAt: BEFORE_EXPIRY,
    });

    const seen: FillHookContext[] = [];
    registerFillHook('option-settlement-spy', async (_tx, ctx) => {
      seen.push(ctx);
    });

    await settleLeg(db, userId, legId, { outcome: 'worthless' });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.occurredAt.getTime()).toBe(EXPIRY_INSTANT.getTime());
  });
});

describe('settleLeg — a throwing fill hook rolls back and emits no event (NFR Reliability, AC 11.7)', () => {
  it('rejects, leaves the leg untouched, and never captures position_settled', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: CALL_SYMBOL,
      entryPrice: '3',
      entryQty: '5',
      filledAt: BEFORE_EXPIRY,
    });

    const captureSpy = vi.spyOn(posthog, 'captureServerEvent').mockImplementation(() => {});
    registerFillHook('option-settlement-throw', async () => {
      throw new Error('injected fill-hook failure');
    });

    await expect(settleLeg(db, userId, legId, { outcome: 'worthless' })).rejects.toThrow(
      'injected fill-hook failure',
    );

    expect(captureSpy).not.toHaveBeenCalled();
    const row = await getPositionRow(legId);
    expect(row.status).toBe('open');
    expect(await getFillsForLeg(legId)).toHaveLength(1);

    const settlementRows = await db
      .select()
      .from(optionSettlements)
      .where(eq(optionSettlements.positionId, legId));
    expect(settlementRows).toHaveLength(0);
  });
});

describe('settleLeg — a refused settlement fires no hook (NFR Reliability)', () => {
  it('never calls the registered fill hook when worthless is refused for timing', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: CALL_SYMBOL,
      entryPrice: '3',
      entryQty: '5',
      filledAt: BEFORE_EXPIRY,
    });
    const now = new Date(EXPIRY_INSTANT.getTime() - 1);

    const seen: FillHookContext[] = [];
    registerFillHook('option-settlement-o', async (_tx, ctx) => {
      seen.push(ctx);
    });

    await expect(
      withTransaction(db, (tx) => settleLegTx(tx, userId, legId, { outcome: 'worthless' }, now)),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(seen).toHaveLength(0);
  });
});

describe('settleLeg — position_settled carries enums only, after commit (AC 11.7)', () => {
  it('fires once with { outcome, source } and no other properties', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: CALL_SYMBOL,
      entryPrice: '3',
      entryQty: '5',
      filledAt: BEFORE_EXPIRY,
    });

    const captureSpy = vi.spyOn(posthog, 'captureServerEvent').mockImplementation(() => {});

    await settleLeg(db, userId, legId, { outcome: 'worthless' });

    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(captureSpy).toHaveBeenCalledWith('position_settled', {
      distinctId: userId,
      properties: { outcome: 'worthless', source: 'manual' },
    });
    expect(Object.keys(captureSpy.mock.calls[0]![1].properties!)).toEqual(['outcome', 'source']);

    // After-commit: the settlement is already persisted and queryable.
    const settlementRows = await db
      .select()
      .from(optionSettlements)
      .where(eq(optionSettlements.positionId, legId));
    expect(settlementRows).toHaveLength(1);
  });
});

/**
 * Task 8 — assignment and exercise (design C3's stock-side table; task 7's
 * bridge ValidationError removed). Same black-box style as above, through
 * `settleLeg`/`settleLegTx` only.
 *
 * Contract block — one entry per success criterion this task covers.
 *
 * Q. Short put assigned enters stock at 47.50; selling nets 750 less fees
 *    (AC 3.9, AC 2.6)
 *   Pre: a short put, strike 50, sold at 2.50.
 *   Call: `settleLeg(db, userId, legId, { outcome: 'assigned', fees: '0.65' })`,
 *     then a plain `addFillTx` exit of the resulting stock at 55.
 *   Result: the new stock entry is 100 shares at 47.50 carrying the 0.65 fee
 *     (not the leg's own exit); the stock row's `lastFlatNetPnl` after the
 *     sale is 749.35 (750 less the 0.65 entry fee, premium counted once).
 *   Source: design C3 table; requirements AC 3.9; AC 2.6 ("the fee lands on
 *     the first stock-side fill").
 *
 * R. Short call assigned exits held shares at 103, realising 1,300 less fees
 *    (AC 3.10, AC 3.3 short-call half)
 *   Pre: a short call, strike 100, sold at 3.00; a held long row, 100 shares
 *     at cost 90.
 *   Call: `settleLeg(db, userId, legId, { outcome: 'assigned', fees: '2.00' })`.
 *   Result: the held row's exit fill is 100 shares at 103 carrying the 2.00
 *     fee; the row closes with `lastFlatNetPnl` 1298.00.
 *   Source: design C3 table; requirements AC 3.10, AC 3.3.
 *
 * S. Long call exercised opens a new row at strike plus premium, never
 *    merging into an existing one (AC 3.1)
 *   Pre: a long call, strike 150, bought at 4, entry fee 0.30; an unrelated
 *     pre-existing open long stock row on the same underlying.
 *   Call: `settleLeg(db, userId, legId, { outcome: 'exercised' })`.
 *   Result: a brand-new ungrouped long stock row opens, 100 shares at 154,
 *     leaving the pre-existing row untouched; the leg itself closes with
 *     `lastFlatNetPnl` -0.30 (gross zero, its entry fee the only realised
 *     amount).
 *   Source: design C3 table; requirements AC 3.1; AC 3.2 (folded — the leg
 *     side's zero-gross/fee-realised check is the same mechanic test T
 *     exercises for the other side, so it is asserted here too rather than
 *     in a third dedicated test).
 *
 * T. Long put exercised exits held shares at strike minus premium, the leg's
 *    own gross P&L zero (AC 3.3 long-put half, AC 3.2)
 *   Pre: a long put, strike 100, bought at 2, entry fee 0.20; a held long
 *     row, 100 shares at cost 95.
 *   Call: `settleLeg(db, userId, legId, { outcome: 'exercised' })`.
 *   Result: the held row's exit fill is 100 shares at 98, closing with
 *     `lastFlatNetPnl` 300.00; the leg's own exit is at its premium (2),
 *     closing with `lastFlatNetPnl` -0.20.
 *   Source: design C3 table; requirements AC 3.3, AC 3.2.
 *
 * U. A shortfall exits the held row then opens a short row for the balance
 *    (AC 3.4)
 *   Pre: a short call, strike 100, sold at 3.00 (100 shares due); a held
 *     long row of only 60 shares at cost 80.
 *   Call: `settleLeg(db, userId, legId, { outcome: 'assigned', fees: '1.00' })`.
 *   Result: the held row exits fully (60 @ 103, fee 1.00) and closes; a new
 *     ungrouped short stock row opens for the remaining 40 shares at 103,
 *     fee 0 (the settlement fee already landed on the first stock-side
 *     fill).
 *   Source: design C3 table and Row order; requirements AC 3.4.
 *
 * V. Two held rows exit in the given `stockRowOrder` (AC 3.5)
 *   Pre: a short call needing 100 shares; Row1 (opened Jan, 50 shares), Row2
 *     (opened Feb, 100 shares).
 *   Call: `settleLeg(db, userId, legId, { outcome: 'assigned', stockRowOrder:
 *     [row2.id, row1.id] })`.
 *   Result: Row2 alone exits (100 shares) and closes; Row1 keeps its single
 *     original fill and stays open.
 *   Source: design C3 "Row order"; requirements AC 3.5.
 *
 * W. With no `stockRowOrder`, rows exit oldest `openedAt` first (AC 3.5)
 *   Pre: the same two rows as V, same leg, no `stockRowOrder`.
 *   Call: `settleLeg(db, userId, legId, { outcome: 'assigned' })`.
 *   Result: Row1 (older) exits fully (50) and closes; Row2 takes a partial
 *     50-share exit and stays open.
 *   Source: design C3 "Row order"; requirements AC 3.5.
 *
 * X. A `stockRowOrder` id that is not an eligible stock row is a 400 (AC 3.5)
 *   Pre: a short call with one eligible held row.
 *   Call: `settleLeg(db, userId, legId, { outcome: 'assigned', stockRowOrder:
 *     [legId] })` — the leg's own (option) id is ineligible.
 *   Result: rejects `ValidationError`; no write — the leg and the held row
 *     both keep only their original fill.
 *   Source: design C3 "Row order" ("A foreign or ineligible id is 400.").
 *
 * Y. The stock exit carries no lot selection (AC 3.6)
 *   Pre: a short call exiting a single held long row (R's setup).
 *   Call: `settleLeg(db, userId, legId, { outcome: 'assigned' })`.
 *   Result: `findLotSelectionsByPosition` for the held row returns `[]` —
 *     the exit runs the lot method's default, with no explicit selection.
 *   Source: requirements AC 3.6 ("no specific-ID picker ships here").
 *
 * Z. A balanced stock row closes through the close path, clamped to its
 *    later `openedAt` (AC 3.7, design D5)
 *   Pre: a held row whose entry fill is dated 2026-01-01 but whose `openedAt`
 *     is stamped later, 2026-01-10 (a backdated-entry journal, the same
 *     shape as option-seams.test.ts's own D5 case); a short call settled
 *     explicitly at 2026-01-05 — between the two.
 *   Call: `settleLeg(db, userId, legId, { outcome: 'assigned', settledAt:
 *     '2026-01-05T00:00:00.000Z' })`.
 *   Result: the row's exit fill is filled at 2026-01-05, but its `closedAt`
 *     is clamped to `openedAt`, 2026-01-10.
 *   Source: design D5; requirements AC 3.7.
 *
 * AA. A partial quantity leaves the rest open; an early date is accepted
 *    (AC 2.5)
 *   Pre: a short put, 5 contracts open.
 *   Call: `settleLeg(db, userId, legId, { outcome: 'assigned', quantity: '3',
 *     settledAt: '2026-07-10T15:00:00.000Z' })` (before the expiry instant,
 *     after the leg's own `openedAt`).
 *   Result: the leg's exit fill is 3 contracts; the leg stays `open` (2
 *     remain); the new stock row is 300 shares, filled at the given date.
 *   Source: requirements AC 2.5.
 *
 * AB. An explicit `settledAt` before the leg's own `openedAt` is a 400 (AC 2.5)
 *   Pre: a short put opened 2026-06-01.
 *   Call: `settleLeg(db, userId, legId, { outcome: 'assigned', settledAt:
 *     '2026-05-01T00:00:00.000Z' })`.
 *   Result: rejects `ValidationError`; no write.
 *   Source: requirements AC 2.5 ("never before openedAt").
 *
 * AC. An explicit `settledAt` in the future is a 400 (AC 2.5)
 *   Pre: a short put, open.
 *   Call: `settleLeg(db, userId, legId, { outcome: 'assigned', settledAt:
 *     '2030-01-01T00:00:00.000Z' })`.
 *   Result: rejects `ValidationError`; no write.
 *   Source: requirements AC 2.5 ("nor in the future").
 *
 * AD. A defaulted expiry in the future is a 400 asking for a date (design D6)
 *   Pre: a short put whose expiry (2026-07-17) is still ahead of the clock.
 *   Call: `settleLegTx(tx, userId, legId, { outcome: 'assigned' }, now)`
 *     inside `withTransaction`, `now` one millisecond before the expiry.
 *   Result: rejects `ValidationError` whose message asks for a date; no
 *     write.
 *   Source: design D6; design C3 post-condition 2 ("Defaulted expiry instant
 *     in the future: 400 asking for a date.").
 *
 * AE. A defaulted expiry before `openedAt` is accepted (design D6)
 *   Pre: a short put opened 2026-08-01, after its own 2026-07-17 expiry (a
 *     backfilled leg).
 *   Call: `settleLeg(db, userId, legId, { outcome: 'assigned' })` — no
 *     `settledAt`.
 *   Result: succeeds; `settledAt` defaults to the expiry instant even though
 *     it precedes `openedAt`.
 *   Source: design D6 ("refuse only an explicit earlier date").
 *
 * AF. A settlement dated before a same-day reopen succeeds (design D7)
 *   Pre: a held long row opened, closed, then reopened the same ET day with
 *     a new backdated entry fill (dated before the reopen) giving it fresh
 *     open units — real `ledger` close/reverse hooks registered, so
 *     `reopenedWithoutNewFills` reads true without the bypass.
 *   Call: a short call `settleLeg(..., { outcome: 'assigned', settledAt })`
 *     where `settledAt` is between the first close and the reopen.
 *   Result: succeeds — the row closes again at `settledAt`, which the
 *     ordinary `closePositionTx` reopen guard would otherwise refuse.
 *   Source: design D7; design C4 ("A settlement dated before a same-day
 *     reopen would otherwise be refused.").
 *
 * AG. An adjusted price below zero is a 400 (design D10)
 *   Pre: a short put, strike 5, sold at 6 (premium exceeding the strike).
 *   Call: `settleLeg(db, userId, legId, { outcome: 'assigned' })`.
 *   Result: rejects `ValidationError`; no write.
 *   Source: design D10.
 *
 * AH. A changed candidate set on the re-read is a 409 (design C3
 *    post-condition 1)
 *   Pre: a short call with one held candidate row.
 *   Call: `settleLeg(db, userId, legId, { outcome: 'assigned' })`, with
 *     `position-groups.query`'s `lockLegs` stubbed to close the candidate
 *     row (via the plain `db` handle) the moment it is called with that
 *     row's id — simulating a concurrent close committing between the
 *     unlocked candidate read and the lock, the same technique
 *     `position-groups.test.ts`'s "returns 409 when the leg is grouped by
 *     the time its lock is acquired" uses.
 *   Result: rejects `ConflictError` with message "The holdings changed; try
 *     again"; no settlement row is created.
 *   Source: design C3 post-condition 1.
 *
 * AI. The lots read and the tax summary show the adjusted price, hold
 *    periods from fill dates (AC 3.11)
 *   Pre: a short put assigned (Q's opening half), then its stock sold later
 *     the same year.
 *   Call: `listPositionLots(db, stockPositionId, userId)` and
 *     `getTaxSummary(userId, 2026)`.
 *   Result: the lots entry shows price 47.50 filled at the settlement date;
 *     the FIFO lot realisation shows basis 4750.00, proceeds 5500.00, net
 *     750.00, and `lotOpenedAt` equal to the settlement date (the stock's own
 *     fill date), term "short".
 *   Source: design Basis and lots table; requirements AC 3.11.
 *
 * Folded/out-of-scope criteria (recorded, not separately retested here):
 *   - AC 3.2 folds into tests S and T (noted above) rather than a third
 *     dedicated test: the leg-side zero-gross/fee-realised mechanic is
 *     identical for both outcomes and already observable from each.
 *   - AC 2.11 and AC 3.8 are regression guards per the task ("already hold at
 *     base"), not new red tests. AC 2.11's two branches — a closed group
 *     giving one flat event, and a not-fully-flat group giving none — are
 *     already pinned, independent of how a leg closes, by
 *     `performance.service.test.ts`'s `classifyGroup` suite: "sums figures
 *     and dates at the latest leg flat for a closed two-leg group (AC 5.1)"
 *     and "returns null unless every leg is currently flat" (lines 649 and
 *     681). Task 8 reuses the leg-closing mechanism (`closeIfBalancedTx`)
 *     those regression-guarded latches already come from — task 6/7's own
 *     guards (`option-seams.test.ts`, `positions.test.ts`) cover that it
 *     still writes the same latch. AC 3.8's two branches — no gross-cash
 *     posting, and the entry-type list unchanged — are covered respectively
 *     by `accounting.test.ts`'s "reverses the close, NULLs positionId..."
 *     case (asserting one net `position_pnl` credit row, never the gross
 *     notional, for any position close through the same fill/close-hook
 *     seam task 8 reuses unmodified) and by the DB-level
 *     `ledger_entry_type_chk` CHECK constraint
 *     (`apps/api/src/db/schema/accounting.schema.ts:94-95`), which this
 *     task's file list does not touch.
 */

describe('settleLeg — short put assigned, then sold, nets 750 less fees (AC 3.9, AC 2.6)', () => {
  it('enters stock at 47.50 with the settlement fee, realising 749.35 on sale', async () => {
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: occSymbol('AAPL', 'P', 50),
      entryPrice: '2.50',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
    });

    await settleLeg(db, userId, legId, { outcome: 'assigned', fees: '0.65' });

    const stockRows = await getStockRows(accountId);
    expect(stockRows).toHaveLength(1);
    const stockRow = stockRows[0]!;
    expect(stockRow.side).toBe('long');
    expect(stockRow.groupId).toBeNull();

    const stockFills = await getFillsForLeg(stockRow.id);
    expect(stockFills).toHaveLength(1);
    expect(stockFills[0]!.type).toBe('entry');
    expect(Number(stockFills[0]!.price)).toBe(47.5);
    expect(Number(stockFills[0]!.quantity)).toBe(100);
    expect(Number(stockFills[0]!.fees)).toBe(0.65);

    const legExit = (await getFillsForLeg(legId)).find((f) => f.type === 'exit')!;
    expect(Number(legExit.price)).toBe(2.5);
    expect(Number(legExit.fees)).toBe(0);

    await withTransaction(db, (tx) =>
      addFillTx(tx, stockRow.id, userId, {
        type: 'exit',
        price: '55',
        quantity: '100',
        fees: '0',
        filledAt: '2026-07-20T00:00:00.000Z',
      }),
    );
    const closedRow = await withTransaction(db, (tx) =>
      closeIfBalancedTx(tx, stockRow.id, userId, '2026-07-20T00:00:00.000Z'),
    );
    expect(closedRow).not.toBeNull();
    expect(Number(closedRow!.lastFlatNetPnl)).toBeCloseTo(749.35, 2);
  });
});

describe('settleLeg — short call assigned exits held shares, realising 1,298 (AC 3.10, AC 3.3)', () => {
  it('exits the held row at 103 with the settlement fee', async () => {
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: occSymbol('AAPL', 'C', 100),
      entryPrice: '3',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
    });
    const { positionId: heldRowId } = await createStockRow({
      userId,
      accountId,
      side: 'long',
      symbol: 'AAPL',
      entryPrice: '90',
      entryQty: '100',
      entryFilledAt: BEFORE_EXPIRY,
    });

    await settleLeg(db, userId, legId, { outcome: 'assigned', fees: '2.00' });

    const heldFills = await getFillsForLeg(heldRowId);
    const exit = heldFills.find((f) => f.type === 'exit')!;
    expect(Number(exit.price)).toBe(103);
    expect(Number(exit.quantity)).toBe(100);
    expect(Number(exit.fees)).toBe(2);

    const heldRow = await getPositionRow(heldRowId);
    expect(heldRow.status).toBe('closed');
    expect(Number(heldRow.lastFlatNetPnl)).toBeCloseTo(1298, 2);
  });
});

describe('settleLeg — long call exercised opens a new row, never merging (AC 3.1, AC 3.2)', () => {
  it('opens an ungrouped row at 154, leaving a pre-existing row untouched', async () => {
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'long',
      symbol: occSymbol('AAPL', 'C', 150),
      entryPrice: '4',
      entryQty: '1',
      entryFees: '0.30',
      filledAt: BEFORE_EXPIRY,
    });
    const { positionId: preExistingId } = await createStockRow({
      userId,
      accountId,
      side: 'long',
      symbol: 'AAPL',
      entryPrice: '200',
      entryQty: '10',
      entryFilledAt: BEFORE_EXPIRY,
    });

    await settleLeg(db, userId, legId, { outcome: 'exercised' });

    const stockRows = await getStockRows(accountId);
    expect(stockRows).toHaveLength(2);
    const newRow = stockRows.find((r) => r.id !== preExistingId)!;
    expect(newRow.side).toBe('long');
    expect(newRow.groupId).toBeNull();

    const newRowFills = await getFillsForLeg(newRow.id);
    expect(newRowFills).toHaveLength(1);
    expect(Number(newRowFills[0]!.price)).toBe(154);
    expect(Number(newRowFills[0]!.quantity)).toBe(100);

    const preExisting = await getPositionRow(preExistingId);
    expect(preExisting.status).toBe('open');
    expect(await getFillsForLeg(preExistingId)).toHaveLength(1);

    const legRow = await getPositionRow(legId);
    expect(legRow.status).toBe('closed');
    expect(Number(legRow.lastFlatNetPnl)).toBeCloseTo(-0.3, 2);
    const legExit = (await getFillsForLeg(legId)).find((f) => f.type === 'exit')!;
    expect(Number(legExit.price)).toBe(4);
  });
});

describe('settleLeg — long put exercised exits held shares at strike minus premium (AC 3.3, AC 3.2)', () => {
  it('exits the held row at 98, closing both sides at zero leg gross', async () => {
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'long',
      symbol: occSymbol('AAPL', 'P', 100),
      entryPrice: '2',
      entryQty: '1',
      entryFees: '0.20',
      filledAt: BEFORE_EXPIRY,
    });
    const { positionId: heldRowId } = await createStockRow({
      userId,
      accountId,
      side: 'long',
      symbol: 'AAPL',
      entryPrice: '95',
      entryQty: '100',
      entryFilledAt: BEFORE_EXPIRY,
    });

    await settleLeg(db, userId, legId, { outcome: 'exercised' });

    const exit = (await getFillsForLeg(heldRowId)).find((f) => f.type === 'exit')!;
    expect(Number(exit.price)).toBe(98);
    expect(Number(exit.quantity)).toBe(100);

    const heldRow = await getPositionRow(heldRowId);
    expect(heldRow.status).toBe('closed');
    expect(Number(heldRow.lastFlatNetPnl)).toBeCloseTo(300, 2);

    const legRow = await getPositionRow(legId);
    expect(legRow.status).toBe('closed');
    expect(Number(legRow.lastFlatNetPnl)).toBeCloseTo(-0.2, 2);
    const legExit = (await getFillsForLeg(legId)).find((f) => f.type === 'exit')!;
    expect(Number(legExit.price)).toBe(2);
  });
});

describe('settleLeg — a shortfall exits the held row then opens a short row for the balance (AC 3.4)', () => {
  it('exits 60 held shares and opens a new short row for the remaining 40', async () => {
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: occSymbol('AAPL', 'C', 100),
      entryPrice: '3',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
    });
    const { positionId: heldRowId } = await createStockRow({
      userId,
      accountId,
      side: 'long',
      symbol: 'AAPL',
      entryPrice: '80',
      entryQty: '60',
      entryFilledAt: BEFORE_EXPIRY,
    });

    await settleLeg(db, userId, legId, { outcome: 'assigned', fees: '1.00' });

    const heldExit = (await getFillsForLeg(heldRowId)).find((f) => f.type === 'exit')!;
    expect(Number(heldExit.price)).toBe(103);
    expect(Number(heldExit.quantity)).toBe(60);
    expect(Number(heldExit.fees)).toBe(1);
    expect((await getPositionRow(heldRowId)).status).toBe('closed');

    const stockRows = await getStockRows(accountId);
    const newShortRow = stockRows.find((r) => r.id !== heldRowId)!;
    expect(newShortRow).toBeDefined();
    expect(newShortRow.side).toBe('short');
    expect(newShortRow.groupId).toBeNull();
    expect(newShortRow.status).toBe('open');

    const newRowFills = await getFillsForLeg(newShortRow.id);
    expect(newRowFills).toHaveLength(1);
    expect(Number(newRowFills[0]!.price)).toBe(103);
    expect(Number(newRowFills[0]!.quantity)).toBe(40);
    expect(Number(newRowFills[0]!.fees)).toBe(0);
  });
});

describe('settleLeg — two held rows exit in the given stockRowOrder (AC 3.5)', () => {
  it('exits only the row named first, leaving the other untouched', async () => {
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: occSymbol('AAPL', 'C', 100),
      entryPrice: '3',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
    });
    const { positionId: row1Id } = await createStockRow({
      userId,
      accountId,
      side: 'long',
      symbol: 'AAPL',
      entryPrice: '80',
      entryQty: '50',
      entryFilledAt: '2026-01-01T00:00:00.000Z',
    });
    const { positionId: row2Id } = await createStockRow({
      userId,
      accountId,
      side: 'long',
      symbol: 'AAPL',
      entryPrice: '85',
      entryQty: '100',
      entryFilledAt: '2026-02-01T00:00:00.000Z',
    });

    await settleLeg(db, userId, legId, {
      outcome: 'assigned',
      stockRowOrder: [row2Id, row1Id],
    });

    const row2 = await getPositionRow(row2Id);
    expect(row2.status).toBe('closed');
    const row2Exit = (await getFillsForLeg(row2Id)).find((f) => f.type === 'exit')!;
    expect(Number(row2Exit.quantity)).toBe(100);

    const row1 = await getPositionRow(row1Id);
    expect(row1.status).toBe('open');
    expect(await getFillsForLeg(row1Id)).toHaveLength(1);
  });
});

describe('settleLeg — with no stockRowOrder, rows exit oldest openedAt first (AC 3.5)', () => {
  it('exits the older row fully, then partially exits the newer one', async () => {
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: occSymbol('AAPL', 'C', 100),
      entryPrice: '3',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
    });
    const { positionId: row1Id } = await createStockRow({
      userId,
      accountId,
      side: 'long',
      symbol: 'AAPL',
      entryPrice: '80',
      entryQty: '50',
      entryFilledAt: '2026-01-01T00:00:00.000Z',
    });
    const { positionId: row2Id } = await createStockRow({
      userId,
      accountId,
      side: 'long',
      symbol: 'AAPL',
      entryPrice: '85',
      entryQty: '100',
      entryFilledAt: '2026-02-01T00:00:00.000Z',
    });

    await settleLeg(db, userId, legId, { outcome: 'assigned' });

    const row1 = await getPositionRow(row1Id);
    expect(row1.status).toBe('closed');
    const row1Exit = (await getFillsForLeg(row1Id)).find((f) => f.type === 'exit')!;
    expect(Number(row1Exit.quantity)).toBe(50);

    const row2 = await getPositionRow(row2Id);
    expect(row2.status).toBe('open');
    const row2Exit = (await getFillsForLeg(row2Id)).find((f) => f.type === 'exit')!;
    expect(Number(row2Exit.quantity)).toBe(50);
  });
});

describe('settleLeg — an ineligible stockRowOrder id is a 400 (AC 3.5)', () => {
  it('rejects ValidationError and writes nothing', async () => {
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: occSymbol('AAPL', 'C', 100),
      entryPrice: '3',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
    });
    const { positionId: heldRowId } = await createStockRow({
      userId,
      accountId,
      side: 'long',
      symbol: 'AAPL',
      entryPrice: '80',
      entryQty: '100',
      entryFilledAt: BEFORE_EXPIRY,
    });

    const err: unknown = await settleLeg(db, userId, legId, {
      outcome: 'assigned',
      stockRowOrder: [legId],
    }).catch((e) => e);

    // Not task 7's blanket assigned/exercised bridge (already removed by
    // this task) — this must be the row-order validation refusing legId
    // specifically.
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).message).not.toContain('not yet supported');

    expect((await getPositionRow(legId)).status).toBe('open');
    expect(await getFillsForLeg(legId)).toHaveLength(1);
    expect((await getPositionRow(heldRowId)).status).toBe('open');
    expect(await getFillsForLeg(heldRowId)).toHaveLength(1);
  });
});

describe('settleLeg — the stock exit carries no lot selection (AC 3.6)', () => {
  it('records no fill_lot_selections row for the held row', async () => {
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: occSymbol('AAPL', 'C', 100),
      entryPrice: '3',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
    });
    const { positionId: heldRowId } = await createStockRow({
      userId,
      accountId,
      side: 'long',
      symbol: 'AAPL',
      entryPrice: '90',
      entryQty: '100',
      entryFilledAt: BEFORE_EXPIRY,
    });

    await settleLeg(db, userId, legId, { outcome: 'assigned' });

    expect(await findLotSelectionsByPosition(db, heldRowId)).toHaveLength(0);
  });
});

describe('settleLeg — a balanced stock row closes clamped to its later openedAt (AC 3.7, design D5)', () => {
  it('clamps closedAt to openedAt for a settlement dated before the open stamp', async () => {
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: occSymbol('AAPL', 'C', 100),
      entryPrice: '3',
      entryQty: '1',
      filledAt: '2025-12-01T00:00:00.000Z',
    });
    const { positionId: heldRowId } = await createStockRow({
      userId,
      accountId,
      side: 'long',
      symbol: 'AAPL',
      entryPrice: '80',
      entryQty: '100',
      entryFilledAt: '2026-01-01T00:00:00.000Z',
      openedAt: '2026-01-10T00:00:00.000Z',
    });

    await settleLeg(db, userId, legId, {
      outcome: 'assigned',
      settledAt: '2026-01-05T00:00:00.000Z',
      fees: '0',
    });

    const exit = (await getFillsForLeg(heldRowId)).find((f) => f.type === 'exit')!;
    expect(exit.filledAt.getTime()).toBe(new Date('2026-01-05T00:00:00.000Z').getTime());

    const heldRow = await getPositionRow(heldRowId);
    expect(heldRow.status).toBe('closed');
    expect(heldRow.closedAt!.getTime()).toBe(new Date('2026-01-10T00:00:00.000Z').getTime());
  });
});

describe('settleLeg — a partial quantity leaves the rest open; an early date is accepted (AC 2.5)', () => {
  it('exits 3 of 5 contracts at the given date, leaving the leg open', async () => {
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: occSymbol('AAPL', 'P', 50),
      entryPrice: '2.50',
      entryQty: '5',
      filledAt: BEFORE_EXPIRY,
    });

    const result = await settleLeg(db, userId, legId, {
      outcome: 'assigned',
      quantity: '3',
      settledAt: '2026-07-10T15:00:00.000Z',
    });

    expect(result.quantity).toBe('3');
    expect(new Date(result.settledAt).getTime()).toBe(
      new Date('2026-07-10T15:00:00.000Z').getTime(),
    );

    const legExit = (await getFillsForLeg(legId)).find((f) => f.type === 'exit')!;
    expect(Number(legExit.quantity)).toBe(3);
    expect((await getPositionRow(legId)).status).toBe('open');

    const stockRows = await getStockRows(accountId);
    expect(stockRows).toHaveLength(1);
    const stockFills = await getFillsForLeg(stockRows[0]!.id);
    expect(stockFills).toHaveLength(1);
    expect(Number(stockFills[0]!.quantity)).toBe(300);
  });
});

describe("settleLeg — an explicit settledAt before the leg's own openedAt is a 400 (AC 2.5)", () => {
  it('rejects ValidationError and writes nothing', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: occSymbol('AAPL', 'P', 50),
      entryPrice: '2.50',
      entryQty: '1',
      filledAt: '2026-06-01T00:00:00.000Z',
    });

    const err: unknown = await settleLeg(db, userId, legId, {
      outcome: 'assigned',
      settledAt: '2026-05-01T00:00:00.000Z',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).message).not.toContain('not yet supported');

    expect((await getPositionRow(legId)).status).toBe('open');
    expect(await getFillsForLeg(legId)).toHaveLength(1);
  });
});

describe('settleLeg — an explicit settledAt in the future is a 400 (AC 2.5)', () => {
  it('rejects ValidationError and writes nothing', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: occSymbol('AAPL', 'P', 50),
      entryPrice: '2.50',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
    });

    const err: unknown = await settleLeg(db, userId, legId, {
      outcome: 'assigned',
      settledAt: '2030-01-01T00:00:00.000Z',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).message).not.toContain('not yet supported');

    expect((await getPositionRow(legId)).status).toBe('open');
    expect(await getFillsForLeg(legId)).toHaveLength(1);
  });
});

describe('settleLeg — a defaulted expiry in the future is a 400 asking for a date (design D6)', () => {
  it('rejects ValidationError and writes nothing', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: occSymbol('AAPL', 'P', 50),
      entryPrice: '2.50',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
    });
    const now = new Date(EXPIRY_INSTANT.getTime() - 1);

    const err: unknown = await withTransaction(db, (tx) =>
      settleLegTx(tx, userId, legId, { outcome: 'assigned' }, now),
    ).catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).message.toLowerCase()).toContain('date');

    expect((await getPositionRow(legId)).status).toBe('open');
    expect(await getFillsForLeg(legId)).toHaveLength(1);
  });
});

describe('settleLeg — a defaulted expiry before openedAt is accepted (design D6)', () => {
  it('defaults settledAt to the expiry instant for a backfilled leg', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: occSymbol('AAPL', 'P', 50),
      entryPrice: '2.50',
      entryQty: '1',
      filledAt: '2026-08-01T00:00:00.000Z',
    });

    const result = await settleLeg(db, userId, legId, { outcome: 'assigned' });

    expect(new Date(result.settledAt).getTime()).toBe(EXPIRY_INSTANT.getTime());
  });
});

describe('settleLeg — a settlement dated before a same-day reopen succeeds (design D7)', () => {
  afterEach(() => {
    unregisterCloseHook('ledger');
    unregisterReverseHook('ledger');
  });

  it('closes the held row again despite the reopen guard', async () => {
    replaceCloseHook('ledger', insertPositionCloseLedgerEntries);
    replaceReverseHook('ledger', reversePositionCloseLedgerEntries);

    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: occSymbol('AAPL', 'C', 100),
      entryPrice: '3',
      entryQty: '1',
      filledAt: '2026-04-01T08:00:00.000Z',
    });

    const T0 = '2026-04-01T09:00:00.000Z';
    const T1 = '2026-04-01T10:00:00.000Z';
    const T2 = '2026-04-01T11:00:00.000Z';
    const T3 = '2026-04-01T09:30:00.000Z'; // backfilled, before the reopen
    const T4 = '2026-04-01T10:30:00.000Z'; // the settlement date, before T2

    const heldRowId = await withTransaction(db, async (tx) => {
      const pos = await createPositionTx(tx, userId, {
        accountId,
        symbol: 'AAPL',
        side: 'long',
        assetType: 'stock',
      });
      await addFillTx(tx, pos!.id, userId, {
        type: 'entry',
        price: '80',
        quantity: '100',
        fees: '0',
        filledAt: T0,
      });
      await openPositionTx(tx, pos!.id, userId, T0);
      await addFillTx(tx, pos!.id, userId, {
        type: 'exit',
        price: '85',
        quantity: '100',
        fees: '0',
        filledAt: T1,
      });
      await closePositionTx(tx, pos!.id, userId, T1);
      await reopenPositionTx(tx, pos!.id, userId, T2);
      await addFillTx(tx, pos!.id, userId, {
        type: 'entry',
        price: '82',
        quantity: '100',
        fees: '0',
        filledAt: T3,
      });
      return pos!.id;
    });
    expect((await getPositionRow(heldRowId)).status).toBe('open');

    await settleLeg(db, userId, legId, { outcome: 'assigned', settledAt: T4, fees: '0' });

    const heldRow = await getPositionRow(heldRowId);
    expect(heldRow.status).toBe('closed');
    expect(heldRow.closedAt!.getTime()).toBe(new Date(T4).getTime());

    const exit = (await getFillsForLeg(heldRowId)).find(
      (f) => f.type === 'exit' && new Date(f.filledAt).getTime() === new Date(T4).getTime(),
    )!;
    expect(Number(exit.quantity)).toBe(100);
    expect(Number(exit.price)).toBe(103);
  });
});

describe('settleLeg — an adjusted price below zero is a 400 (design D10)', () => {
  it('rejects ValidationError and writes nothing', async () => {
    const { userId, legId } = await createOptionLeg({
      side: 'short',
      symbol: occSymbol('AAPL', 'P', 5),
      entryPrice: '6',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
    });

    const err: unknown = await settleLeg(db, userId, legId, { outcome: 'assigned' }).catch(
      (e) => e,
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).message).not.toContain('not yet supported');

    expect((await getPositionRow(legId)).status).toBe('open');
    expect(await getFillsForLeg(legId)).toHaveLength(1);
  });
});

describe('settleLeg — a changed candidate set on the re-read is a 409 (design C3 post-condition 1)', () => {
  it('rejects ConflictError when the held row closes between the unlocked read and the lock', async () => {
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: occSymbol('AAPL', 'C', 100),
      entryPrice: '3',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
    });
    const { positionId: heldRowId } = await createStockRow({
      userId,
      accountId,
      side: 'long',
      symbol: 'AAPL',
      entryPrice: '90',
      entryQty: '100',
      entryFilledAt: BEFORE_EXPIRY,
    });

    const realLockLegs = positionGroupsQuery.lockLegs;
    const spy = vi
      .spyOn(positionGroupsQuery, 'lockLegs')
      .mockImplementation(async (tx, uid, ids) => {
        if (ids.includes(heldRowId)) {
          // Simulates a concurrent close committing between the unlocked
          // candidate read and the lock, via the plain `db` handle rather
          // than the caller's (possibly uncommitted) tx — the same
          // technique position-groups.test.ts's own race test uses.
          await db
            .update(positions)
            .set({ status: 'closed', closedAt: new Date() })
            .where(eq(positions.id, heldRowId));
        }
        return realLockLegs(tx, uid, ids);
      });

    let err: unknown;
    try {
      err = await settleLeg(db, userId, legId, { outcome: 'assigned' }).catch((e) => e);
    } finally {
      spy.mockRestore();
    }

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toBe('The holdings changed; try again');

    const settlementRows = await db
      .select()
      .from(optionSettlements)
      .where(eq(optionSettlements.positionId, legId));
    expect(settlementRows).toHaveLength(0);
  });
});

describe('settleLeg — the lots read and tax summary show the adjusted price (AC 3.11)', () => {
  it('reflects 47.50 as an ordinary fill price, with the hold period from the fill date', async () => {
    const { userId, accountId, legId } = await createOptionLeg({
      side: 'short',
      symbol: occSymbol('AAPL', 'P', 50),
      entryPrice: '2.50',
      entryQty: '1',
      filledAt: BEFORE_EXPIRY,
    });

    await settleLeg(db, userId, legId, { outcome: 'assigned', fees: '0' });

    const stockRow = (await getStockRows(accountId))[0]!;
    const stockEntry = (await getFillsForLeg(stockRow.id)).find((f) => f.type === 'entry')!;

    await withTransaction(db, (tx) =>
      addFillTx(tx, stockRow.id, userId, {
        type: 'exit',
        price: '55',
        quantity: '100',
        fees: '0',
        filledAt: '2026-08-01T00:00:00.000Z',
      }),
    );
    await withTransaction(db, (tx) =>
      closeIfBalancedTx(tx, stockRow.id, userId, '2026-08-01T00:00:00.000Z'),
    );

    const lots = await listPositionLots(db, stockRow.id, userId);
    expect(lots.lots).toHaveLength(1);
    expect(lots.lots[0]!.entryFillId).toBe(stockEntry.id);
    expect(Number(lots.lots[0]!.price)).toBe(47.5);
    expect(new Date(lots.lots[0]!.filledAt).getTime()).toBe(EXPIRY_INSTANT.getTime());
    expect(Number(lots.lots[0]!.available)).toBe(0);

    const summary = await getTaxSummary(userId, 2026);
    const realisation = summary.lotRealisations.find((r) => r.positionId === stockRow.id);
    expect(realisation).toBeDefined();
    expect(Number(realisation!.basis)).toBe(4750);
    expect(Number(realisation!.proceeds)).toBe(5500);
    expect(Number(realisation!.net)).toBe(750);
    expect(new Date(realisation!.lotOpenedAt).getTime()).toBe(EXPIRY_INSTANT.getTime());
    expect(realisation!.term).toBe('short');
  });
});

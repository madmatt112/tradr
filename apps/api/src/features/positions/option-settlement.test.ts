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
import { getTierLimits } from '@/features/billing/tier-limits.constants';
import { settleLeg, settleLegTx } from '@/features/positions/option-settlement.service';
import {
  addFillTx,
  createPositionTx,
  openPositionTx,
  registerFillHook,
  unregisterFillHook,
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

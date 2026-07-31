import Decimal from 'decimal.js';
import { describe, it, expect, vi } from 'vitest';

import { parseOccUnderlying } from '@tradr/shared/lib/occ';

import { db } from '@/db';
import { users } from '@/db/schema';
import {
  createExpense,
  getTaxJurisdiction,
  removeExpense,
  updateExpense,
} from '@/features/expenses/expenses.service';
import { NotFoundError, ValidationError } from '@/lib/errors';

import { aggregateFeesByAccountAndAssetType } from './expenses.fee-rollup';
import type { CandidatePositionRow, FeeRollupRow, RealisedPositionRow } from './expenses.query';
import {
  applyYearEndSpotConversion,
  classifyUSHoldPeriod,
  findSuperficialLossFlags,
  findWashSaleFlags,
} from './expenses.tax';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let counter = 0;
function uniqueEmail(): string {
  return `expsvc-${Date.now()}-${++counter}@example.com`;
}

async function seedUser(): Promise<{ id: string }> {
  const [user] = await db
    .insert(users)
    .values({
      email: uniqueEmail(),
      passwordHash: 'x'.repeat(60),
      displayCurrency: 'USD',
    })
    .returning();
  return { id: user!.id };
}

function isoDateOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// CRUD invariants (Tasks 11/13)
// ---------------------------------------------------------------------------

describe('createExpense — minor-unit validation (Req 1.5)', () => {
  it('USD amount with 3 fractional digits → ValidationError with details.amount', async () => {
    const user = await seedUser();
    const err = await createExpense(user.id, {
      currency: 'USD',
      amount: '100.123',
      occurredAt: '2026-05-20',
      category: 'data_subscription',
      description: 'x',
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).details).toEqual(
      expect.objectContaining({ amount: expect.any(String) }),
    );
  });
});

describe('createExpense — future-dating validation (Req 1.7)', () => {
  it('occurredAt = today + 400 days → ValidationError with details.occurredAt', async () => {
    const user = await seedUser();
    const err = await createExpense(user.id, {
      currency: 'USD',
      amount: '10.00',
      occurredAt: isoDateOffset(400),
      category: 'data_subscription',
      description: 'x',
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).details).toEqual(
      expect.objectContaining({ occurredAt: expect.any(String) }),
    );
  });
});

describe('updateExpense — currency mutation re-runs minor-unit check', () => {
  async function seedJpyExpense(amount: string): Promise<{
    userId: string;
    expenseId: string;
  }> {
    const user = await seedUser();
    const row = await createExpense(user.id, {
      currency: 'JPY',
      amount,
      occurredAt: '2026-05-20',
      category: 'data_subscription',
      description: 'x',
    });
    return { userId: user.id, expenseId: row.id };
  }

  it('patch { currency: USD, amount: 100.12 } accepted (USD allows 2 fractional)', async () => {
    const { userId, expenseId } = await seedJpyExpense('100');
    const updated = await updateExpense(userId, expenseId, {
      currency: 'USD',
      amount: '100.12',
    });
    expect(updated.currency).toBe('USD');
    expect(new Decimal(updated.amount).toString()).toBe('100.12');
  });

  it('patch { currency: USD, amount: 100.12345 } rejected (too many fractional digits)', async () => {
    const { userId, expenseId } = await seedJpyExpense('100');
    await expect(
      updateExpense(userId, expenseId, {
        currency: 'USD',
        amount: '100.12345',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('patch { currency: USD } only — existing JPY amount "100" fits USD → accepted', async () => {
    const { userId, expenseId } = await seedJpyExpense('100');
    const updated = await updateExpense(userId, expenseId, { currency: 'USD' });
    expect(updated.currency).toBe('USD');
    expect(new Decimal(updated.amount).toString()).toBe('100');
  });

  it('patch { currency: JPY } only — existing USD amount "100.12" does NOT fit JPY → rejected', async () => {
    const user = await seedUser();
    const row = await createExpense(user.id, {
      currency: 'USD',
      amount: '100.12',
      occurredAt: '2026-05-20',
      category: 'data_subscription',
      description: 'x',
    });
    await expect(updateExpense(user.id, row.id, { currency: 'JPY' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('removeExpense — cross-user isolation', () => {
  it("removing another user's row throws NotFoundError('Expense', id)", async () => {
    const owner = await seedUser();
    const intruder = await seedUser();
    const row = await createExpense(owner.id, {
      currency: 'USD',
      amount: '10.00',
      occurredAt: '2026-05-20',
      category: 'data_subscription',
      description: 'x',
    });
    await expect(removeExpense(intruder.id, row.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(removeExpense(intruder.id, row.id)).rejects.toMatchObject({
      message: `Expense ${row.id} not found`,
    });
  });
});

describe('getTaxJurisdiction — NULL materialization', () => {
  it("returns 'other' when the user's column is NULL (Req 4.2)", async () => {
    const user = await seedUser();
    // Default insert leaves tax_jurisdiction NULL.
    const result = await getTaxJurisdiction(user.id);
    expect(result).toBe('other');
  });
});

// ---------------------------------------------------------------------------
// Pure helper unit tests (Task 9) — no DB
// ---------------------------------------------------------------------------

function realisedRow(overrides: Partial<RealisedPositionRow>): RealisedPositionRow {
  return {
    positionId: overrides.positionId ?? 'pos-x',
    realisedPnl: overrides.realisedPnl ?? '-100',
    openedAt: overrides.openedAt ?? new Date('2026-01-01T00:00:00Z'),
    // `in` rather than `??`: a case that deliberately passes `closedAt: null`
    // (a loss realized on a still-open position) must keep the null, and `??`
    // would silently swap the default back in.
    closedAt: 'closedAt' in overrides ? overrides.closedAt! : new Date('2026-06-15T00:00:00Z'),
    // Defaults to closedAt: for a position exited in one go the realization IS
    // the close, so every pre-existing case keeps its exact semantics. Cases
    // that exercise staged exits set it explicitly.
    realisedAt: overrides.realisedAt ?? overrides.closedAt ?? new Date('2026-06-15T00:00:00Z'),
    symbol: overrides.symbol ?? 'AAPL',
    assetType: overrides.assetType ?? 'stock',
    side: overrides.side ?? 'long',
    accountId: overrides.accountId ?? 'acct-a',
    currency: overrides.currency ?? 'USD',
  };
}

function candidateRow(overrides: Partial<CandidatePositionRow>): CandidatePositionRow {
  return {
    positionId: overrides.positionId ?? 'cand-x',
    openedAt: overrides.openedAt ?? new Date('2026-06-20T00:00:00Z'),
    closedAt: overrides.closedAt ?? null,
    symbol: overrides.symbol ?? 'AAPL',
    assetType: overrides.assetType ?? 'stock',
    side: overrides.side ?? 'long',
    accountId: overrides.accountId ?? 'acct-a',
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('classifyUSHoldPeriod — boundary (Req 4.4)', () => {
  it('364 days held → shortTerm bucket', () => {
    const opened = new Date('2026-01-01T00:00:00Z');
    const closed = new Date(opened.getTime() + 364 * DAY_MS);
    const { shortTerm, longTerm } = classifyUSHoldPeriod([
      realisedRow({ openedAt: opened, closedAt: closed, realisedPnl: '50' }),
    ]);
    expect(shortTerm.get('USD')?.toString()).toBe('50');
    expect(longTerm.size).toBe(0);
  });

  it('366 days held → longTerm bucket', () => {
    const opened = new Date('2026-01-01T00:00:00Z');
    const closed = new Date(opened.getTime() + 366 * DAY_MS);
    const { shortTerm, longTerm } = classifyUSHoldPeriod([
      realisedRow({ openedAt: opened, closedAt: closed, realisedPnl: '50' }),
    ]);
    expect(longTerm.get('USD')?.toString()).toBe('50');
    expect(shortTerm.size).toBe(0);
  });

  it('exactly 365 days → shortTerm (inclusive boundary)', () => {
    const opened = new Date('2026-01-01T00:00:00Z');
    const closed = new Date(opened.getTime() + 365 * DAY_MS);
    const { shortTerm, longTerm } = classifyUSHoldPeriod([
      realisedRow({ openedAt: opened, closedAt: closed, realisedPnl: '50' }),
    ]);
    expect(shortTerm.get('USD')?.toString()).toBe('50');
    expect(longTerm.size).toBe(0);
  });
});

describe('applyYearEndSpotConversion', () => {
  it('all currencies have rates → aggregate sums all converted', () => {
    const totals = new Map<string, Decimal>([
      ['USD', new Decimal('100')],
      ['EUR', new Decimal('200')],
    ]);
    const rates = new Map<string, Decimal>([['EUR->USD', new Decimal('1.10')]]);
    const result = applyYearEndSpotConversion(totals, 'USD', rates);
    expect(result.aggregate?.toString()).toBe('320');
    expect(result.excludedCurrencies).toEqual([]);
    expect(result.missingPairs).toEqual([]);
    expect(result.convertedCurrencies).toEqual(['EUR']);
  });

  it('one missing rate → currency excluded, aggregate omits its contribution, totals still populated', () => {
    const totals = new Map<string, Decimal>([
      ['USD', new Decimal('100')],
      ['EUR', new Decimal('200')],
      ['GBP', new Decimal('50')],
    ]);
    const rates = new Map<string, Decimal>([
      ['EUR->USD', new Decimal('1.10')],
      // GBP rate missing
    ]);
    const result = applyYearEndSpotConversion(totals, 'USD', rates);
    expect(result.aggregate?.toString()).toBe('320');
    expect(result.excludedCurrencies).toEqual(['GBP']);
    expect(result.missingPairs).toEqual([{ base: 'GBP', quote: 'USD' }]);
    expect(totals.get('GBP')?.toString()).toBe('50'); // per-currency unchanged
  });
});

describe('findWashSaleFlags', () => {
  const log = { warn: vi.fn() };

  it('stock match: candidate AAPL opened 5d after AAPL loss → flagged repurchase_within_30_days', () => {
    log.warn.mockClear();
    const loss = realisedRow({
      positionId: 'loss-1',
      symbol: 'AAPL',
      assetType: 'stock',
      side: 'long',
      closedAt: new Date('2026-06-15T00:00:00Z'),
      realisedPnl: '-100',
    });
    const candidate = candidateRow({
      positionId: 'cand-1',
      symbol: 'AAPL',
      assetType: 'stock',
      side: 'long',
      openedAt: new Date('2026-06-20T00:00:00Z'),
    });
    const flags = findWashSaleFlags([loss], [candidate], parseOccUnderlying, log);
    expect(flags).toHaveLength(1);
    expect(flags[0].reason).toBe('repurchase_within_30_days');
    expect(flags[0].counterpartyPositionIds).toEqual(['cand-1']);
  });

  it('same-day re-open: candidate opened on loss.closedAt day → NOT flagged', () => {
    log.warn.mockClear();
    const loss = realisedRow({
      positionId: 'loss-1',
      symbol: 'AAPL',
      closedAt: new Date('2026-06-15T12:00:00Z'),
      realisedPnl: '-100',
    });
    const candidate = candidateRow({
      positionId: 'cand-1',
      symbol: 'AAPL',
      openedAt: new Date('2026-06-15T18:00:00Z'),
    });
    const flags = findWashSaleFlags([loss], [candidate], parseOccUnderlying, log);
    expect(flags).toHaveLength(0);
  });

  it('direction mismatch: long loss + short candidate within 30d → NOT flagged', () => {
    log.warn.mockClear();
    const loss = realisedRow({
      positionId: 'loss-1',
      symbol: 'AAPL',
      side: 'long',
      closedAt: new Date('2026-06-15T00:00:00Z'),
      realisedPnl: '-100',
    });
    const candidate = candidateRow({
      positionId: 'cand-1',
      symbol: 'AAPL',
      side: 'short',
      openedAt: new Date('2026-06-20T00:00:00Z'),
    });
    const flags = findWashSaleFlags([loss], [candidate], parseOccUnderlying, log);
    expect(flags).toHaveLength(0);
  });

  it('cross-account: loss in acct A, candidate in acct B → flagged (taxpayer-wide)', () => {
    log.warn.mockClear();
    const loss = realisedRow({
      positionId: 'loss-1',
      symbol: 'AAPL',
      accountId: 'acct-a',
      closedAt: new Date('2026-06-15T00:00:00Z'),
      realisedPnl: '-100',
    });
    const candidate = candidateRow({
      positionId: 'cand-1',
      symbol: 'AAPL',
      accountId: 'acct-b',
      openedAt: new Date('2026-06-20T00:00:00Z'),
    });
    const flags = findWashSaleFlags([loss], [candidate], parseOccUnderlying, log);
    expect(flags).toHaveLength(1);
    expect(flags[0].counterpartyPositionIds).toEqual(['cand-1']);
  });

  it('held-open window: candidate opened 2026-05-01 never closed, loss closed 2026-06-15 → held_open_in_30d_window', () => {
    log.warn.mockClear();
    const loss = realisedRow({
      positionId: 'loss-1',
      symbol: 'AAPL',
      closedAt: new Date('2026-06-15T00:00:00Z'),
      realisedPnl: '-100',
    });
    const candidate = candidateRow({
      positionId: 'cand-1',
      symbol: 'AAPL',
      openedAt: new Date('2026-05-01T00:00:00Z'),
      closedAt: null,
    });
    const flags = findWashSaleFlags([loss], [candidate], parseOccUnderlying, log);
    expect(flags).toHaveLength(1);
    expect(flags[0].reason).toBe('held_open_in_30d_window');
  });

  it('mixed candidate: A held-open + B repurchase → repurchase_within_30_days + both counterparties', () => {
    log.warn.mockClear();
    const loss = realisedRow({
      positionId: 'loss-1',
      symbol: 'AAPL',
      closedAt: new Date('2026-06-15T00:00:00Z'),
      realisedPnl: '-100',
    });
    const candA = candidateRow({
      positionId: 'cand-A',
      symbol: 'AAPL',
      openedAt: new Date('2026-05-01T00:00:00Z'),
      closedAt: null,
    });
    const candB = candidateRow({
      positionId: 'cand-B',
      symbol: 'AAPL',
      openedAt: new Date('2026-06-20T00:00:00Z'),
      closedAt: null,
    });
    const flags = findWashSaleFlags([loss], [candA, candB], parseOccUnderlying, log);
    expect(flags).toHaveLength(1);
    expect(flags[0].reason).toBe('repurchase_within_30_days');
    expect([...flags[0].counterpartyPositionIds].sort()).toEqual(['cand-A', 'cand-B'].sort());
  });

  it('option underlying match: AAPL 250320C150 loss + AAPL 250417C200 candidate → flagged', () => {
    log.warn.mockClear();
    const loss = realisedRow({
      positionId: 'loss-1',
      symbol: 'AAPL 250320C150',
      assetType: 'option',
      closedAt: new Date('2026-06-15T00:00:00Z'),
      realisedPnl: '-100',
    });
    const candidate = candidateRow({
      positionId: 'cand-1',
      symbol: 'AAPL 250417C200',
      assetType: 'option',
      openedAt: new Date('2026-06-20T00:00:00Z'),
    });
    const flags = findWashSaleFlags([loss], [candidate], parseOccUnderlying, log);
    expect(flags).toHaveLength(1);
    expect(flags[0].underlying).toBe('AAPL');
  });

  it('option parser returns null: candidate symbol "1234" → skipped + log emitted', () => {
    log.warn.mockClear();
    const loss = realisedRow({
      positionId: 'loss-1',
      symbol: 'AAPL 250320C150',
      assetType: 'option',
      closedAt: new Date('2026-06-15T00:00:00Z'),
      realisedPnl: '-100',
    });
    const candidate = candidateRow({
      positionId: 'cand-bad',
      symbol: '1234',
      assetType: 'option',
      openedAt: new Date('2026-06-20T00:00:00Z'),
    });
    const flags = findWashSaleFlags([loss], [candidate], parseOccUnderlying, log);
    expect(flags).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith({
      positionId: 'cand-bad',
      reason: 'occ_parse_failure',
    });
  });

  it('asset-type partition: stock AAPL loss + option AAPL candidate → NOT flagged', () => {
    log.warn.mockClear();
    const loss = realisedRow({
      positionId: 'loss-1',
      symbol: 'AAPL',
      assetType: 'stock',
      closedAt: new Date('2026-06-15T00:00:00Z'),
      realisedPnl: '-100',
    });
    const candidate = candidateRow({
      positionId: 'cand-1',
      symbol: 'AAPL 250417C200',
      assetType: 'option',
      openedAt: new Date('2026-06-20T00:00:00Z'),
    });
    const flags = findWashSaleFlags([loss], [candidate], parseOccUnderlying, log);
    expect(flags).toHaveLength(0);
  });

  // --- Partial realization (ledger-balances Req 9) ---
  //
  // A position realizes P&L per fill, so it can hold a realized loss while
  // STILL OPEN. Wash-sale detection used to bail on `closedAt === null`, which
  // made those losses invisible, and otherwise anchored its window on the close
  // date rather than on when the loss was actually realized.

  it('flags a loss realized on a still-OPEN position (closedAt null)', () => {
    log.warn.mockClear();
    const loss = realisedRow({
      positionId: 'loss-open',
      symbol: 'AAPL',
      assetType: 'stock',
      side: 'long',
      // Partial exit realized the loss; the position has not gone flat.
      closedAt: null,
      realisedAt: new Date('2026-06-15T00:00:00Z'),
      realisedPnl: '-100',
    });
    const candidate = candidateRow({
      positionId: 'cand-open',
      symbol: 'AAPL',
      assetType: 'stock',
      side: 'long',
      openedAt: new Date('2026-06-20T00:00:00Z'),
    });
    const flags = findWashSaleFlags([loss], [candidate], parseOccUnderlying, log);
    // Previously zero — the loss was skipped entirely for having no closedAt.
    expect(flags).toHaveLength(1);
    expect(flags[0].reason).toBe('repurchase_within_30_days');
    expect(flags[0].closedAt).toBeNull();
    expect(flags[0].realisedAt).toEqual(new Date('2026-06-15T00:00:00Z'));
  });

  it('anchors the 30d window on the realization date, not the close date', () => {
    log.warn.mockClear();
    // Loss realized 1 March by a partial exit; the position did not go flat
    // until 20 April. A repurchase on 10 March is 9 days after the REALIZATION
    // (inside the window) but 41 days before the CLOSE (outside it).
    const loss = realisedRow({
      positionId: 'loss-staged',
      symbol: 'AAPL',
      assetType: 'stock',
      side: 'long',
      realisedAt: new Date('2026-03-01T00:00:00Z'),
      closedAt: new Date('2026-04-20T00:00:00Z'),
      realisedPnl: '-100',
    });
    const candidate = candidateRow({
      positionId: 'cand-staged',
      symbol: 'AAPL',
      assetType: 'stock',
      side: 'long',
      openedAt: new Date('2026-03-10T00:00:00Z'),
    });
    const flags = findWashSaleFlags([loss], [candidate], parseOccUnderlying, log);
    expect(flags).toHaveLength(1);
    expect(flags[0].reason).toBe('repurchase_within_30_days');
  });

  it('does NOT flag a repurchase that is only inside the stale close-date window', () => {
    log.warn.mockClear();
    // Mirror of the above: 15 May is inside +/-30d of the 20 April close but 75
    // days after the 1 March realization. Anchoring on the close date would
    // raise a false flag here.
    const loss = realisedRow({
      positionId: 'loss-stale',
      symbol: 'AAPL',
      assetType: 'stock',
      side: 'long',
      realisedAt: new Date('2026-03-01T00:00:00Z'),
      closedAt: new Date('2026-04-20T00:00:00Z'),
      realisedPnl: '-100',
    });
    const candidate = candidateRow({
      positionId: 'cand-stale',
      symbol: 'AAPL',
      assetType: 'stock',
      side: 'long',
      openedAt: new Date('2026-05-15T00:00:00Z'),
      closedAt: new Date('2026-05-20T00:00:00Z'),
    });
    const flags = findWashSaleFlags([loss], [candidate], parseOccUnderlying, log);
    expect(flags).toHaveLength(0);
  });
});

describe('findSuperficialLossFlags', () => {
  const log = { warn: vi.fn() };

  it('candidate acquired within 30d AND still open at +30d → flagged', () => {
    log.warn.mockClear();
    const loss = realisedRow({
      positionId: 'loss-1',
      symbol: 'AAPL',
      closedAt: new Date('2026-06-15T00:00:00Z'),
      realisedPnl: '-100',
    });
    const candidate = candidateRow({
      positionId: 'cand-1',
      symbol: 'AAPL',
      openedAt: new Date('2026-06-20T00:00:00Z'),
      closedAt: null,
    });
    const flags = findSuperficialLossFlags([loss], [candidate], parseOccUnderlying, log);
    expect(flags).toHaveLength(1);
  });

  it('candidate acquired within 30d but closed BEFORE +30d → NOT flagged', () => {
    log.warn.mockClear();
    const loss = realisedRow({
      positionId: 'loss-1',
      symbol: 'AAPL',
      closedAt: new Date('2026-06-15T00:00:00Z'),
      realisedPnl: '-100',
    });
    const candidate = candidateRow({
      positionId: 'cand-1',
      symbol: 'AAPL',
      openedAt: new Date('2026-06-20T00:00:00Z'),
      closedAt: new Date('2026-07-01T00:00:00Z'),
    });
    const flags = findSuperficialLossFlags([loss], [candidate], parseOccUnderlying, log);
    expect(flags).toHaveLength(0);
  });
});

describe('aggregateFeesByAccountAndAssetType', () => {
  function feeRow(o: Partial<FeeRollupRow>): FeeRollupRow {
    return {
      accountId: o.accountId ?? 'acct-a',
      accountName: o.accountName ?? 'Account A',
      assetType: o.assetType ?? 'stock',
      currency: o.currency ?? 'USD',
      totalFees: o.totalFees ?? '0',
    };
  }

  it('stocks-only account → optionsFees === "0"', () => {
    const rows: FeeRollupRow[] = [feeRow({ assetType: 'stock', totalFees: '12.50' })];
    const agg = aggregateFeesByAccountAndAssetType(rows);
    expect(agg).toHaveLength(1);
    expect(agg[0].stockFees.toString()).toBe('12.5');
    expect(agg[0].optionsFees.toString()).toBe('0');
    expect(agg[0].totalFees.toString()).toBe('12.5');
  });

  it('mixed account → both stockFees and optionsFees populated', () => {
    const rows: FeeRollupRow[] = [
      feeRow({ assetType: 'stock', totalFees: '12.50' }),
      feeRow({ assetType: 'option', totalFees: '7.25' }),
    ];
    const agg = aggregateFeesByAccountAndAssetType(rows);
    expect(agg).toHaveLength(1);
    expect(agg[0].stockFees.toString()).toBe('12.5');
    expect(agg[0].optionsFees.toString()).toBe('7.25');
    expect(agg[0].totalFees.toString()).toBe('19.75');
  });
});

// ---------------------------------------------------------------------------
// Deferred-spec tripwire (post-review fix #4)
// ---------------------------------------------------------------------------

describe('deferred-spec tripwires', () => {
  it.todo(
    'revisit when d-536e8750 lands: realised-P&L query filter and SUM logic must handle position_pnl_reversal rows',
  );
});

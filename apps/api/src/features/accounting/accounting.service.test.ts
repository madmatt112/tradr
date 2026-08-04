import fs from 'node:fs';
import path from 'node:path';

import Decimal from 'decimal.js';
import { and, eq, inArray } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';

import { bootstrap } from '@/app';
import { db } from '@/db';
import {
  accounts,
  exchangeRates,
  ledgerEntries,
  positions as positionsTbl,
  users,
} from '@/db/schema';
import {
  aggregateBalancesForAccounts,
  findSpotRate,
  reverseCloseForPosition,
} from '@/features/accounting/accounting.query';
import {
  computeDashboardTotal,
  convertAmountForUser,
  createExchangeRate,
  previewRateChangeImpact,
} from '@/features/accounting/accounting.service';
import { insertPositionCloseLedgerEntries } from '@/features/accounting/ledger-hook';
import {
  assertLedgerHooksCoRegistered,
  replaceCloseHook,
  replaceFillHook,
  replaceReverseHook,
  unregisterCloseHook,
  unregisterFillHook,
  unregisterReverseHook,
} from '@/features/positions/positions.service';
import { InvariantViolationError, MissingRateError } from '@/lib/errors';

// ---------------------------------------------------------------------------
// Bootstrap opt-in
// ---------------------------------------------------------------------------
//
// This file opts into `bootstrap()` in `beforeAll` because two things in
// scope require it:
//   1. The pinned global Decimal config (HALF_UP, precision 20).
//   2. The 'ledger' close-hook registration the hook tests need to drive
//      `insertPositionCloseLedgerEntries` directly. (We invoke the hook
//      directly via its export — bootstrap is required for the Decimal pin,
//      and we unregister it again in afterAll for cross-file hygiene per
//      Task 18.)

beforeAll(() => {
  // .catch swallows the async advisor-startup tail's rejection: in tests `@/db`
  // is mocked to `undefined` outside the per-test tx window, so the
  // fire-and-forget decrypt-canary would otherwise leak an unhandled rejection
  // and fail `pnpm test`. The synchronous prelude (Decimal pin + ledger hook) —
  // all this file needs — has already run by the time .catch attaches.
  bootstrap().catch(() => {});
});

afterAll(() => {
  // Belt-and-suspenders cleanup — Task 18 adds a global afterAll registry
  // wipe in test-setup.ts, but per-file cleanup here is still required.
  // `bootstrap()` now registers a 'ledger' REVERSE hook too (Req 7.5/7.8); the
  // global wipe only clears close hooks, so unregister the reverse hook here.
  unregisterCloseHook('ledger');
  unregisterReverseHook('ledger');
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let counter = 0;
function uniqueEmail() {
  return `acct-svc-${Date.now()}-${++counter}@example.com`;
}

async function seedUserAccountPosition(opts?: { currency?: string }) {
  const currency = opts?.currency ?? 'USD';
  const [user] = await db
    .insert(users)
    .values({ email: uniqueEmail(), passwordHash: 'x'.repeat(60), displayCurrency: currency })
    .returning();
  const [account] = await db
    .insert(accounts)
    .values({ userId: user!.id, name: 'Test Account', currency })
    .returning();
  const [position] = await db
    .insert(positionsTbl)
    .values({
      userId: user!.id,
      accountId: account!.id,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
      status: 'closed',
      openedAt: new Date('2026-01-01T00:00:00Z'),
      closedAt: new Date('2026-01-02T00:00:00Z'),
    })
    .returning();
  return {
    userId: user!.id,
    accountId: account!.id,
    positionId: position!.id,
    user,
    account,
    position,
  };
}

async function seedUser(opts?: { displayCurrency?: string | null }) {
  const [user] = await db
    .insert(users)
    .values({
      email: uniqueEmail(),
      passwordHash: 'x'.repeat(60),
      // Preserve an explicitly-passed null (the `?? 'USD'` form would coerce
      // null → 'USD', defeating the display_currency=null short-circuit tests).
      displayCurrency: opts && 'displayCurrency' in opts ? opts.displayCurrency : 'USD',
    })
    .returning();
  return user!;
}

// ---------------------------------------------------------------------------
// (1) Decimal.js global pin assertion (Req 4.13, design §NFR Reliability)
// ---------------------------------------------------------------------------
//
// `bootstrap()` calls `Decimal.set({ rounding: ROUND_HALF_UP, precision: 20 })`.
// decimal.js v10 reads config per-arithmetic-call, so this Decimal instance
// — created AFTER bootstrap — must round HALF_UP. This test fails loudly if
// `bootstrap()` is removed or the pin regresses to the default ROUND_HALF_EVEN.

describe('Decimal.js pin (bootstrap)', () => {
  it('Decimal rounds HALF_UP after bootstrap() — 100.005 → 100.01', () => {
    expect(new Decimal('100.005').toFixed(2)).toBe('100.01');
  });
});

// ---------------------------------------------------------------------------
// (2) Source-module tripwire — ledger-hook.ts MUST NOT import from '@/db'.
// The authoritative guard is the ESLint no-restricted-imports rule (Task 10);
// this regex check is belt-and-suspenders so a tooling regression cannot let
// a stray `from '@/db'` slip past CI.
// ---------------------------------------------------------------------------

describe('ledger-hook.ts source — no @/db import (tripwire)', () => {
  it('does not import from @/db (the global handle leaks would corrupt transactional rollback)', () => {
    const hookPath = path.join(__dirname, 'ledger-hook.ts');
    const source = fs.readFileSync(hookPath, 'utf-8');
    // Match real import lines only — line-anchored to dodge comments that
    // mention the path in prose. Both `from '@/db'` and `from "@/db"` are
    // checked. The hook MAY import a `Database`/`Transaction` *type* via
    // `import type` — those resolve through the same path though, so we ban
    // the literal token altogether to keep the tripwire dead-simple.
    const importLines = source.split('\n').filter((l) => /^\s*import\b/.test(l));
    const offending = importLines.filter((l) => /from\s+['"]@\/db['"]/.test(l));
    expect(
      offending,
      `ledger-hook.ts must not import from '@/db' (found: ${offending.join(' | ')})`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (3) Hook: insertPositionCloseLedgerEntries — profit/loss/zero + invariant
// + groupId freshness. We invoke the hook directly with a real tx via
// `withTransaction`, building the ctx by hand. This decouples the hook from
// the broader closePosition path tested in positions.service.test.ts.
// ---------------------------------------------------------------------------

async function runHook(ctx: {
  position: {
    id: string;
    userId: string;
    symbol: string;
    closedAt: Date | null;
  };
  account: { id: string; currency: string };
  netPnl: string;
}) {
  // Run inside a top-level transaction so the hook's tx-only insert path
  // works against the savepoint-wrapped test isolation harness.
  await db.transaction(async (tx) => {
    await insertPositionCloseLedgerEntries(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tx as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx as any,
    );
  });
}

describe('insertPositionCloseLedgerEntries (close hook)', () => {
  it('profit → one credit position_pnl row with correct magnitude and a fresh groupId', async () => {
    const { userId, accountId, positionId } = await seedUserAccountPosition();
    await runHook({
      position: {
        id: positionId,
        userId,
        symbol: 'AAPL',
        closedAt: new Date('2026-01-02T00:00:00Z'),
      },
      account: { id: accountId, currency: 'USD' },
      netPnl: '50.0000',
    });

    const rows = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.positionId, positionId));
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.entryType).toBe('position_pnl');
    expect(row.direction).toBe('credit');
    expect(new Decimal(row.amount).toFixed(4)).toBe('50.0000');
    expect(row.currency).toBe('USD');
    expect(row.symbol).toBe('AAPL');
    expect(row.groupId).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.reversesGroupId).toBeNull();
  });

  it('loss → one debit position_pnl row with positive magnitude', async () => {
    const { userId, accountId, positionId } = await seedUserAccountPosition();
    await runHook({
      position: {
        id: positionId,
        userId,
        symbol: 'AAPL',
        closedAt: new Date('2026-01-02T00:00:00Z'),
      },
      account: { id: accountId, currency: 'USD' },
      netPnl: '-25.5000',
    });

    const rows = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.positionId, positionId));
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe('debit');
    // Stored magnitude is positive — ledger_amount_nonneg_chk enforces this.
    expect(new Decimal(rows[0].amount).toFixed(4)).toBe('25.5000');
  });

  it('exact zero P&L → one credit row with amount "0.0000"', async () => {
    const { userId, accountId, positionId } = await seedUserAccountPosition();
    await runHook({
      position: {
        id: positionId,
        userId,
        symbol: 'AAPL',
        closedAt: new Date('2026-01-02T00:00:00Z'),
      },
      account: { id: accountId, currency: 'USD' },
      netPnl: '0.0000',
    });
    const rows = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.positionId, positionId));
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe('credit');
    // Use Decimal equality, not float == — `numeric` round-trips as a string
    // and a Decimal comparison pins the trailing-zero precision contract.
    expect(new Decimal(rows[0].amount).toFixed(4)).toBe('0.0000');
  });

  it('precision violation (netPnl has more dp than currency minor units) → InvariantViolationError', async () => {
    const { userId, accountId, positionId } = await seedUserAccountPosition({ currency: 'JPY' });
    // JPY has 0 minor units — netPnl '1.5' has 1 dp and must throw.
    await expect(
      runHook({
        position: {
          id: positionId,
          userId,
          symbol: 'AAPL',
          closedAt: new Date('2026-01-02T00:00:00Z'),
        },
        account: { id: accountId, currency: 'JPY' },
        netPnl: '1.5',
      }),
    ).rejects.toBeInstanceOf(InvariantViolationError);

    // No partial row persisted (the rollback wraps both the hook and the
    // savepoint cleanly).
    const rows = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.positionId, positionId));
    expect(rows).toHaveLength(0);
  });

  it('two consecutive closes produce two distinct groupIds', async () => {
    // Two SEPARATE positions so groupId freshness across hook invocations is
    // exercised with one position_pnl row per position. (The former
    // ledger_position_pnl_unique_idx one-row-per-position guard was dropped by
    // task 26 / d-536e8750; separate positions is just this test's setup now,
    // no longer a DB constraint.)
    const first = await seedUserAccountPosition();
    await runHook({
      position: {
        id: first.positionId,
        userId: first.userId,
        symbol: 'AAPL',
        closedAt: new Date('2026-01-02T00:00:00Z'),
      },
      account: { id: first.accountId, currency: 'USD' },
      netPnl: '10.0000',
    });
    const second = await seedUserAccountPosition();
    await runHook({
      position: {
        id: second.positionId,
        userId: second.userId,
        symbol: 'AAPL',
        closedAt: new Date('2026-01-03T00:00:00Z'),
      },
      account: { id: second.accountId, currency: 'USD' },
      netPnl: '20.0000',
    });

    const rows = await db
      .select()
      .from(ledgerEntries)
      .where(inArray(ledgerEntries.positionId, [first.positionId, second.positionId]));
    expect(rows).toHaveLength(2);
    expect(rows[0].groupId).not.toBe(rows[1].groupId);
  });
});

// ---------------------------------------------------------------------------
// (3b) reverseCloseForPosition (ledger reversal, design C9 / Req 7.1-7.9) +
// the close/reverse co-registration invariant (Req 7.8). Reversal is
// append-only: it INSERTs a flipped-direction position_pnl_reversal per
// un-reversed position_pnl; it never DELETEs/UPDATEs a ledger row.
// ---------------------------------------------------------------------------

// Drive reverseCloseForPosition inside a real (savepoint-wrapped) transaction —
// same harness shape as `runHook`. Returns the inserted reversal rows.
async function runReverse(params: { userId: string; positionId: string; occurredAt?: Date }) {
  let inserted: Awaited<ReturnType<typeof reverseCloseForPosition>> = [];
  await db.transaction(async (tx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inserted = await reverseCloseForPosition(tx as any, params);
  });
  return inserted;
}

// Derived account balance (starting_balance + SUM over position_pnl(+reversal))
// as the 2dp API string — proves reversals net a close back out.
async function balanceOf(userId: string, accountId: string) {
  const balances = await aggregateBalancesForAccounts(db, userId, [accountId]);
  return balances.get(accountId);
}

describe('reverseCloseForPosition (ledger reversal)', () => {
  it('profit close → one debit reversal linked via reversesGroupId; balance nets to 0', async () => {
    const { userId, accountId, positionId } = await seedUserAccountPosition();
    await runHook({
      position: {
        id: positionId,
        userId,
        symbol: 'AAPL',
        closedAt: new Date('2026-01-02T00:00:00Z'),
      },
      account: { id: accountId, currency: 'USD' },
      netPnl: '50.0000',
    });
    const [original] = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.positionId, positionId));
    expect(original.direction).toBe('credit');

    const inserted = await runReverse({ userId, positionId });
    expect(inserted).toHaveLength(1);
    const [rev] = inserted;
    expect(rev.entryType).toBe('position_pnl_reversal');
    expect(rev.direction).toBe('debit'); // flipped from credit
    expect(new Decimal(rev.amount).toFixed(4)).toBe('50.0000'); // same magnitude
    expect(rev.currency).toBe('USD');
    expect(rev.symbol).toBe('AAPL');
    expect(rev.positionId).toBe(positionId);
    expect(rev.reversesGroupId).toBe(original.groupId);
    expect(rev.groupId).not.toBe(original.groupId); // fresh groupId

    expect(await balanceOf(userId, accountId)).toBe('0.00');
  });

  it('loss close → one credit reversal; balance nets to 0', async () => {
    const { userId, accountId, positionId } = await seedUserAccountPosition();
    await runHook({
      position: {
        id: positionId,
        userId,
        symbol: 'AAPL',
        closedAt: new Date('2026-01-02T00:00:00Z'),
      },
      account: { id: accountId, currency: 'USD' },
      netPnl: '-25.5000',
    });
    const inserted = await runReverse({ userId, positionId });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].direction).toBe('credit'); // flipped from debit
    expect(new Decimal(inserted[0].amount).toFixed(4)).toBe('25.5000');
    expect(await balanceOf(userId, accountId)).toBe('0.00');
  });

  it('zero-P&L close → one flipped (debit) reversal of amount 0', async () => {
    const { userId, accountId, positionId } = await seedUserAccountPosition();
    // The close hook writes a zero-P&L row as a `credit` of amount 0.
    await runHook({
      position: {
        id: positionId,
        userId,
        symbol: 'AAPL',
        closedAt: new Date('2026-01-02T00:00:00Z'),
      },
      account: { id: accountId, currency: 'USD' },
      netPnl: '0.0000',
    });
    const inserted = await runReverse({ userId, positionId });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].direction).toBe('debit'); // credit → debit
    expect(new Decimal(inserted[0].amount).toFixed(4)).toBe('0.0000');
    expect(await balanceOf(userId, accountId)).toBe('0.00');
  });

  it('idempotent: a second reverse on an already-reversed position inserts nothing', async () => {
    const { userId, accountId, positionId } = await seedUserAccountPosition();
    await runHook({
      position: {
        id: positionId,
        userId,
        symbol: 'AAPL',
        closedAt: new Date('2026-01-02T00:00:00Z'),
      },
      account: { id: accountId, currency: 'USD' },
      netPnl: '50.0000',
    });
    const first = await runReverse({ userId, positionId });
    expect(first).toHaveLength(1);

    const second = await runReverse({ userId, positionId });
    expect(second).toEqual([]); // no double-reversal

    // Exactly two rows remain: the original + one reversal.
    const rows = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.positionId, positionId));
    expect(rows).toHaveLength(2);
    expect(await balanceOf(userId, accountId)).toBe('0.00');
  });

  it('never-closed position → inserts nothing (no position_pnl rows)', async () => {
    const { userId, positionId } = await seedUserAccountPosition();
    // No position_pnl was ever written for this position.
    const inserted = await runReverse({ userId, positionId });
    expect(inserted).toEqual([]);
  });

  it('two-cycle (close → reverse → re-close → reverse) reverses only the un-reversed row each time', async () => {
    const { userId, accountId, positionId } = await seedUserAccountPosition();

    // A reopen→re-close legitimately writes a SECOND position_pnl for the same
    // position (design worked-proof; Req 7.4). Task 26 (d-536e8750) DROPped the
    // former `ledger_position_pnl_unique_idx` in the schema + migration 0020, so
    // multiple position_pnl rows per position are now legal — no local index
    // drop is needed here.

    // Cycle 1: position_pnl A (credit 50) → reverse → revA (debit 50).
    const [rowA] = await db
      .insert(ledgerEntries)
      .values({
        userId,
        accountId,
        positionId,
        entryType: 'position_pnl',
        direction: 'credit',
        amount: '50.0000',
        currency: 'USD',
        occurredAt: new Date('2026-01-02T00:00:00Z'),
        groupId: crypto.randomUUID(),
        reversesGroupId: null,
      })
      .returning();
    const cycle1 = await runReverse({ userId, positionId });
    expect(cycle1).toHaveLength(1);
    expect(cycle1[0].reversesGroupId).toBe(rowA.groupId);
    expect(cycle1[0].direction).toBe('debit');

    // Cycle 2: re-close writes a NEW position_pnl B (credit 80). Reverse must
    // pick ONLY B (A is already reversed) → exactly one new reversal, of B.
    const [rowB] = await db
      .insert(ledgerEntries)
      .values({
        userId,
        accountId,
        positionId,
        entryType: 'position_pnl',
        direction: 'credit',
        amount: '80.0000',
        currency: 'USD',
        occurredAt: new Date('2026-01-04T00:00:00Z'),
        groupId: crypto.randomUUID(),
        reversesGroupId: null,
      })
      .returning();
    const cycle2 = await runReverse({ userId, positionId });
    expect(cycle2).toHaveLength(1);
    expect(cycle2[0].reversesGroupId).toBe(rowB.groupId);
    expect(cycle2[0].direction).toBe('debit');

    // Four rows total (A, revA, B, revB); balance 50 − 50 + 80 − 80 = 0.
    const rows = await db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.userId, userId), eq(ledgerEntries.positionId, positionId)));
    expect(rows).toHaveLength(4);
    expect(await balanceOf(userId, accountId)).toBe('0.00');
  });
});

describe('ledger hook co-registration invariant (Req 7.8, extended by Req 9.13)', () => {
  it('passes when close + reverse + fill hooks are co-registered (bootstrap state)', () => {
    // beforeAll ran bootstrap() → 'ledger' close, reverse AND fill are all
    // registered, so the invariant holds.
    expect(() => assertLedgerHooksCoRegistered()).not.toThrow();
  });

  it('throws when a close hook is registered without its same-named reverse hook', () => {
    // Register an orphan close hook (no matching reverse/fill hook) → fails.
    replaceCloseHook('orphan-close', async () => {});
    try {
      expect(() => assertLedgerHooksCoRegistered()).toThrow(InvariantViolationError);
    } finally {
      unregisterCloseHook('orphan-close');
    }
    // Cleanup restores the co-registered state.
    expect(() => assertLedgerHooksCoRegistered()).not.toThrow();
  });

  it('throws when a close hook has a reverse hook but no same-named fill hook (Req 9.13)', () => {
    // Partial P&L posted by a fill hook must be reversible on reopen, so a close
    // hook whose fill counterpart is missing is the same class of bug as a
    // missing reverse hook. Register close + reverse but NOT fill.
    replaceCloseHook('half-wired', async () => {});
    replaceReverseHook('half-wired', async () => {});
    try {
      expect(() => assertLedgerHooksCoRegistered()).toThrow(InvariantViolationError);
      // Adding the missing fill hook satisfies the invariant.
      replaceFillHook('half-wired', async () => {});
      expect(() => assertLedgerHooksCoRegistered()).not.toThrow();
    } finally {
      unregisterCloseHook('half-wired');
      unregisterReverseHook('half-wired');
      unregisterFillHook('half-wired');
    }
    expect(() => assertLedgerHooksCoRegistered()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// (4) findSpotRate — direct / inverse / missing + the Req 4.3 pinned ordering
// ---------------------------------------------------------------------------

describe('findSpotRate', () => {
  it('returns source="direct" with the latest direct rate ≤ asOf', async () => {
    const user = await seedUser();
    await db.insert(exchangeRates).values([
      {
        userId: user.id,
        baseCurrency: 'USD',
        quoteCurrency: 'EUR',
        rate: '0.900000000000',
        effectiveDate: '2026-01-01',
      },
      {
        userId: user.id,
        baseCurrency: 'USD',
        quoteCurrency: 'EUR',
        rate: '0.920000000000',
        effectiveDate: '2026-03-01',
      },
    ]);
    const spot = await findSpotRate(db, user.id, 'USD', 'EUR', new Date('2026-04-01'));
    expect(spot.source).toBe('direct');
    expect(spot.rate.toString()).toBe('0.92');
  });

  it('returns source="inverse" when no direct exists — rate is 1/inverse at pinned precision', async () => {
    const user = await seedUser();
    await db.insert(exchangeRates).values({
      userId: user.id,
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      rate: '1.250000000000',
      effectiveDate: '2026-01-01',
    });
    const spot = await findSpotRate(db, user.id, 'USD', 'EUR', new Date('2026-04-01'));
    expect(spot.source).toBe('inverse');
    // 1 / 1.25 = 0.8 exactly.
    expect(spot.rate.toFixed(2)).toBe('0.80');
  });

  it('returns source=null when no direct or inverse rate exists', async () => {
    const user = await seedUser();
    const spot = await findSpotRate(db, user.id, 'USD', 'EUR', new Date('2026-04-01'));
    expect(spot.source).toBeNull();
  });

  it('pinned ordering (Req 4.3): a stale direct rate wins over a fresher inverse rate', async () => {
    // Req 4.3 / Req 4.15 / design.md §Component 6: direct beats inverse
    // *regardless* of which has the fresher effectiveDate. A future
    // "fresher of direct-or-inverse wins" change would be a deliberate
    // requirements amendment, not a tweak — this test pins the current
    // contract so it cannot regress accidentally. See accounting.query.ts
    // findSpotRate doc-comment for the rationale.
    const user = await seedUser();
    await db.insert(exchangeRates).values([
      {
        userId: user.id,
        baseCurrency: 'USD',
        quoteCurrency: 'GBP',
        rate: '0.800000000000',
        effectiveDate: '2026-01-01', // STALE direct
      },
      {
        userId: user.id,
        baseCurrency: 'GBP',
        quoteCurrency: 'USD',
        rate: '1.300000000000',
        effectiveDate: '2026-05-01', // FRESHER inverse
      },
    ]);
    const spot = await findSpotRate(db, user.id, 'USD', 'GBP', new Date('2026-05-10'));
    expect(spot.source).toBe('direct');
    // Stale January direct rate wins — 0.80, NOT 1/1.30.
    expect(spot.rate.toString()).toBe('0.8');
  });

  // upperBound option (expenses-tax spec §Component 5 / Open Q1 resolution):
  // tax-summary / fee-rollup pass an `upperBound` of `${year}-12-31` so a past
  // year is pinned to its year-end while in-progress years still pick today.
  it('upperBound strictly past asOf is a no-op — behaves as if no upperBound was supplied', async () => {
    const user = await seedUser();
    await db.insert(exchangeRates).values([
      {
        userId: user.id,
        baseCurrency: 'USD',
        quoteCurrency: 'EUR',
        rate: '0.900000000000',
        effectiveDate: '2026-01-01',
      },
      {
        userId: user.id,
        baseCurrency: 'USD',
        quoteCurrency: 'EUR',
        rate: '0.920000000000',
        effectiveDate: '2026-03-01',
      },
    ]);
    const spot = await findSpotRate(db, user.id, 'USD', 'EUR', new Date('2026-04-01'), {
      upperBound: new Date('2026-12-31T23:59:59.999Z'),
    });
    // Effective asOf = min(2026-04-01, 2026-12-31) = 2026-04-01 → picks the
    // March rate, exactly as if no upperBound were passed.
    expect(spot.source).toBe('direct');
    expect(spot.rate.toString()).toBe('0.92');
    // Per-rate effectiveDate (Req 4.5.6): the source row's actual date, not
    // the upper-bound asOf.
    expect(spot.effectiveDate).toBe('2026-03-01');
  });

  it('upperBound strictly before asOf clamps the effective asOf', async () => {
    const user = await seedUser();
    await db.insert(exchangeRates).values([
      {
        userId: user.id,
        baseCurrency: 'USD',
        quoteCurrency: 'EUR',
        rate: '0.900000000000',
        effectiveDate: '2026-01-01',
      },
      {
        userId: user.id,
        baseCurrency: 'USD',
        quoteCurrency: 'EUR',
        rate: '0.920000000000',
        effectiveDate: '2026-03-01',
      },
    ]);
    // asOf is in April but upperBound clamps to mid-February → only the
    // January rate is ≤ effectiveDate.
    const spot = await findSpotRate(db, user.id, 'USD', 'EUR', new Date('2026-04-01'), {
      upperBound: new Date('2026-02-15T00:00:00.000Z'),
    });
    expect(spot.source).toBe('direct');
    expect(spot.rate.toString()).toBe('0.9');
    // Clamped row's actual effectiveDate, not the upperBound.
    expect(spot.effectiveDate).toBe('2026-01-01');
  });

  it('upperBound before any existing rate returns source=null', async () => {
    const user = await seedUser();
    await db.insert(exchangeRates).values({
      userId: user.id,
      baseCurrency: 'USD',
      quoteCurrency: 'EUR',
      rate: '0.900000000000',
      effectiveDate: '2026-01-01',
    });
    const spot = await findSpotRate(db, user.id, 'USD', 'EUR', new Date('2026-04-01'), {
      upperBound: new Date('2025-06-01T00:00:00.000Z'),
    });
    expect(spot.source).toBeNull();
    expect(spot.effectiveDate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (5) previewRateChangeImpact — threshold cases, baseline null/zero,
// discriminated upsert/delete, symmetric displayability flips.
// ---------------------------------------------------------------------------

describe('previewRateChangeImpact', () => {
  it('upsert: >5% move → exceedsThreshold true', async () => {
    const user = await seedUser({ displayCurrency: 'USD' });
    const [eurAccount] = await db
      .insert(accounts)
      .values({ userId: user.id, name: 'EUR', currency: 'EUR' })
      .returning();
    // Seed an EUR balance via a manual position_pnl credit ledger row.
    const [pos] = await db
      .insert(positionsTbl)
      .values({
        userId: user.id,
        accountId: eurAccount!.id,
        symbol: 'X',
        side: 'long',
        assetType: 'stock',
        status: 'closed',
        openedAt: new Date('2026-01-01'),
        closedAt: new Date('2026-01-02'),
      })
      .returning();
    await db.insert(ledgerEntries).values({
      userId: user.id,
      accountId: eurAccount!.id,
      positionId: pos!.id,
      entryType: 'position_pnl',
      direction: 'credit',
      amount: '100.0000',
      currency: 'EUR',
      occurredAt: new Date('2026-01-02'),
      groupId: crypto.randomUUID(),
      reversesGroupId: null,
    });
    await db.insert(exchangeRates).values({
      userId: user.id,
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      rate: '1.000000000000',
      effectiveDate: '2026-01-01',
    });

    // 10% move on the EUR→USD rate.
    const result = await previewRateChangeImpact(db, user.id, {
      intent: 'upsert',
      rate: {
        baseCurrency: 'EUR',
        quoteCurrency: 'USD',
        rate: '1.10',
        effectiveDate: '2026-01-01',
      },
    });
    expect(result.exceedsThreshold).toBe(true);
    expect(result.beforeTotal).not.toBeNull();
    expect(result.afterTotal).not.toBeNull();
  });

  it('upsert: <5% move → exceedsThreshold false', async () => {
    const user = await seedUser({ displayCurrency: 'USD' });
    const [eurAccount] = await db
      .insert(accounts)
      .values({ userId: user.id, name: 'EUR', currency: 'EUR' })
      .returning();
    const [pos] = await db
      .insert(positionsTbl)
      .values({
        userId: user.id,
        accountId: eurAccount!.id,
        symbol: 'X',
        side: 'long',
        assetType: 'stock',
        status: 'closed',
        openedAt: new Date('2026-01-01'),
        closedAt: new Date('2026-01-02'),
      })
      .returning();
    await db.insert(ledgerEntries).values({
      userId: user.id,
      accountId: eurAccount!.id,
      positionId: pos!.id,
      entryType: 'position_pnl',
      direction: 'credit',
      amount: '100.0000',
      currency: 'EUR',
      occurredAt: new Date('2026-01-02'),
      groupId: crypto.randomUUID(),
      reversesGroupId: null,
    });
    await db.insert(exchangeRates).values({
      userId: user.id,
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      rate: '1.000000000000',
      effectiveDate: '2026-01-01',
    });

    const result = await previewRateChangeImpact(db, user.id, {
      intent: 'upsert',
      rate: {
        baseCurrency: 'EUR',
        quoteCurrency: 'USD',
        rate: '1.01', // 1% move
        effectiveDate: '2026-01-01',
      },
    });
    expect(result.exceedsThreshold).toBe(false);
  });

  it('baseline null (before:null → after:non-null) → exceedsThreshold true (displayability flip)', async () => {
    // No EUR→USD rate at start → before total is null. The upsert adds the
    // rate → after total is non-null. Symmetric flip per design.
    const user = await seedUser({ displayCurrency: 'USD' });
    const [eurAccount] = await db
      .insert(accounts)
      .values({ userId: user.id, name: 'EUR', currency: 'EUR' })
      .returning();
    const [pos] = await db
      .insert(positionsTbl)
      .values({
        userId: user.id,
        accountId: eurAccount!.id,
        symbol: 'X',
        side: 'long',
        assetType: 'stock',
        status: 'closed',
        openedAt: new Date('2026-01-01'),
        closedAt: new Date('2026-01-02'),
      })
      .returning();
    await db.insert(ledgerEntries).values({
      userId: user.id,
      accountId: eurAccount!.id,
      positionId: pos!.id,
      entryType: 'position_pnl',
      direction: 'credit',
      amount: '100.0000',
      currency: 'EUR',
      occurredAt: new Date('2026-01-02'),
      groupId: crypto.randomUUID(),
      reversesGroupId: null,
    });

    const result = await previewRateChangeImpact(db, user.id, {
      intent: 'upsert',
      rate: {
        baseCurrency: 'EUR',
        quoteCurrency: 'USD',
        rate: '1.00',
        effectiveDate: '2026-01-01',
      },
    });
    expect(result.beforeTotal).toBeNull();
    expect(result.afterTotal).not.toBeNull();
    expect(result.exceedsThreshold).toBe(true);
  });

  it('symmetric flip (before:non-null → after:null via delete) → exceedsThreshold true', async () => {
    // The only EUR→USD rate is the one we'll delete — preview must report
    // the post-delete aggregate as undisplayable AND flip the threshold.
    const user = await seedUser({ displayCurrency: 'USD' });
    const [eurAccount] = await db
      .insert(accounts)
      .values({ userId: user.id, name: 'EUR', currency: 'EUR' })
      .returning();
    const [pos] = await db
      .insert(positionsTbl)
      .values({
        userId: user.id,
        accountId: eurAccount!.id,
        symbol: 'X',
        side: 'long',
        assetType: 'stock',
        status: 'closed',
        openedAt: new Date('2026-01-01'),
        closedAt: new Date('2026-01-02'),
      })
      .returning();
    await db.insert(ledgerEntries).values({
      userId: user.id,
      accountId: eurAccount!.id,
      positionId: pos!.id,
      entryType: 'position_pnl',
      direction: 'credit',
      amount: '100.0000',
      currency: 'EUR',
      occurredAt: new Date('2026-01-02'),
      groupId: crypto.randomUUID(),
      reversesGroupId: null,
    });
    const [rate] = await db
      .insert(exchangeRates)
      .values({
        userId: user.id,
        baseCurrency: 'EUR',
        quoteCurrency: 'USD',
        rate: '1.000000000000',
        effectiveDate: '2026-01-01',
      })
      .returning();

    const result = await previewRateChangeImpact(db, user.id, {
      intent: 'delete',
      rateId: rate!.id,
    });
    expect(result.beforeTotal).not.toBeNull();
    expect(result.afterTotal).toBeNull();
    expect(result.exceedsThreshold).toBe(true);
  });

  it('baseline zero (offsetting balances sum to 0) → exceedsThreshold false', async () => {
    // Edge case: aggregate is exactly 0 — relative-move is undefined and
    // the threshold logic must return false (NOT throw, NOT return true).
    // Build a user with a single account holding a credit-then-debit of
    // equal magnitude in the display currency.
    const user = await seedUser({ displayCurrency: 'USD' });
    const [account] = await db
      .insert(accounts)
      .values({ userId: user.id, name: 'USD', currency: 'USD' })
      .returning();
    // Two positions so the offsetting credit/debit live on separate positions
    // while still summing to a zero account balance. (The former
    // ledger_position_pnl_unique_idx one-row-per-position guard was dropped by
    // task 26 / d-536e8750; separate positions is just this test's setup now.)
    const [posCredit] = await db
      .insert(positionsTbl)
      .values({
        userId: user.id,
        accountId: account!.id,
        symbol: 'X',
        side: 'long',
        assetType: 'stock',
        status: 'closed',
        openedAt: new Date('2026-01-01'),
        closedAt: new Date('2026-01-02'),
      })
      .returning();
    const [posDebit] = await db
      .insert(positionsTbl)
      .values({
        userId: user.id,
        accountId: account!.id,
        symbol: 'X',
        side: 'long',
        assetType: 'stock',
        status: 'closed',
        openedAt: new Date('2026-01-01'),
        closedAt: new Date('2026-01-02'),
      })
      .returning();
    const ts = new Date('2026-01-02');
    await db.insert(ledgerEntries).values([
      {
        userId: user.id,
        accountId: account!.id,
        positionId: posCredit!.id,
        entryType: 'position_pnl',
        direction: 'credit',
        amount: '50.0000',
        currency: 'USD',
        occurredAt: ts,
        groupId: crypto.randomUUID(),
        reversesGroupId: null,
      },
      {
        userId: user.id,
        accountId: account!.id,
        positionId: posDebit!.id,
        entryType: 'position_pnl',
        direction: 'debit',
        amount: '50.0000',
        currency: 'USD',
        occurredAt: ts,
        groupId: crypto.randomUUID(),
        reversesGroupId: null,
      },
    ]);
    // Add an EUR→USD rate to upsert — the baseline aggregate is still 0
    // because the only account is USD-native.
    await db.insert(exchangeRates).values({
      userId: user.id,
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      rate: '1.000000000000',
      effectiveDate: '2026-01-01',
    });

    const result = await previewRateChangeImpact(db, user.id, {
      intent: 'upsert',
      rate: {
        baseCurrency: 'EUR',
        quoteCurrency: 'USD',
        rate: '99.0',
        effectiveDate: '2026-01-01',
      },
    });
    // Both totals are "0.0000" — baseline-zero short-circuit returns false.
    expect(result.beforeTotal).toBe('0.0000');
    expect(result.afterTotal).toBe('0.0000');
    expect(result.exceedsThreshold).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (6) convertAmountForUser — identity short-circuit + HALF_UP 4dp rounding.
// ---------------------------------------------------------------------------

describe('convertAmountForUser', () => {
  it('identity (from === to) returns input amount unrounded', async () => {
    const user = await seedUser();
    const amount = new Decimal('123.456789'); // 6dp — must NOT be rounded.
    const result = await convertAmountForUser(db, user.id, amount, 'USD', 'USD');
    expect(result.toString()).toBe('123.456789');
  });

  it('cross-currency conversion rounds HALF_UP to 4dp', async () => {
    const user = await seedUser();
    await db.insert(exchangeRates).values({
      userId: user.id,
      baseCurrency: 'USD',
      quoteCurrency: 'EUR',
      rate: '0.123456789012',
      effectiveDate: '2026-01-01',
    });
    // 100 * 0.123456789012 = 12.3456789012; HALF_UP to 4dp = 12.3457.
    const result = await convertAmountForUser(db, user.id, new Decimal('100'), 'USD', 'EUR');
    expect(result.toFixed(4)).toBe('12.3457');
  });

  it('missing rate → MissingRateError', async () => {
    const user = await seedUser();
    await expect(
      convertAmountForUser(db, user.id, new Decimal('100'), 'USD', 'EUR'),
    ).rejects.toBeInstanceOf(MissingRateError);
  });
});

// ---------------------------------------------------------------------------
// (7) Trivial smoke tests on createExchangeRate / computeDashboardTotal so
// regressions in the public service surface are caught alongside the
// targeted unit tests above (kept narrow — full route coverage is Task 17).
// ---------------------------------------------------------------------------

describe('service surface smoke', () => {
  afterEach(async () => {
    // No global cleanup needed — savepoint rollback handles it.
  });

  it('createExchangeRate persists a row', async () => {
    const user = await seedUser();
    const row = await createExchangeRate(db, user.id, {
      baseCurrency: 'USD',
      quoteCurrency: 'EUR',
      rate: '0.9',
      effectiveDate: '2026-01-01',
    });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.rate).toBe('0.900000000000');
  });

  it('computeDashboardTotal short-circuits when display_currency is null', async () => {
    const user = await seedUser({ displayCurrency: null });
    const out = await computeDashboardTotal(db, user.id);
    expect(out).toEqual({ displayCurrency: null, total: null, missingPairs: [] });
  });
});

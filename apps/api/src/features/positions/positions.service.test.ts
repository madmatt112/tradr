import { eq, sql as drizzleSql } from 'drizzle-orm';
import { describe, it, expect, afterEach, vi } from 'vitest';

import { db } from '@/db';
import { accounts, fills, ledgerEntries, positions, users } from '@/db/schema';
import * as accountsQuery from '@/features/accounts/accounts.query';
import * as positionsQuery from '@/features/positions/positions.query';
import {
  addFillTx,
  buildCloseHookContext,
  closePosition,
  closePositionTx,
  createPosition,
  createPositionTx,
  editPosition,
  listCloseHooks,
  openPosition,
  openPositionTx,
  registerCloseHook,
  replaceCloseHook,
  unregisterCloseHook,
  type CloseHook,
} from '@/features/positions/positions.service';
import {
  ConflictError,
  HookAlreadyRegisteredError,
  InvariantViolationError,
  ValidationError,
} from '@/lib/errors';
import * as posthog from '@/lib/posthog';
import { withTransaction } from '@/lib/transaction';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let counter = 0;
function uniqueEmail() {
  return `pos-svc-${Date.now()}-${++counter}@example.com`;
}

async function seedClosablePosition(opts?: { currency?: string }) {
  const currency = opts?.currency ?? 'USD';
  const [user] = await db
    .insert(users)
    .values({ email: uniqueEmail(), passwordHash: 'x'.repeat(60) })
    .returning();
  const [account] = await db
    .insert(accounts)
    .values({ userId: user!.id, name: 'Test Account', currency })
    .returning();
  const position = await createPosition(
    db,
    user!.id,
    { accountId: account!.id, symbol: 'AAPL', side: 'long', assetType: 'stock' },
    { isAdmin: false },
  );
  // Matched entry/exit fills with a $50 profit on 10 shares.
  await db.insert(fills).values([
    {
      positionId: position!.id,
      type: 'entry',
      price: '100',
      quantity: '10',
      fees: '0',
      filledAt: new Date('2026-01-01T00:00:00Z'),
    },
    {
      positionId: position!.id,
      type: 'exit',
      price: '105',
      quantity: '10',
      fees: '0',
      filledAt: new Date('2026-01-02T00:00:00Z'),
    },
  ]);
  await openPosition(db, position!.id, user!.id, '2026-01-01T00:00:00Z');
  return { userId: user!.id, accountId: account!.id, positionId: position!.id };
}

// ---------------------------------------------------------------------------
// Registry lifecycle
// ---------------------------------------------------------------------------

describe('close-hook registry — lifecycle', () => {
  afterEach(() => {
    // Belt-and-braces: clear any residual names this file installs.
    for (const name of listCloseHooks()) unregisterCloseHook(name);
  });

  it('starts empty (no bootstrap() called in this file)', () => {
    expect(listCloseHooks()).toEqual([]);
  });

  it('registerCloseHook adds, unregisterCloseHook removes', () => {
    const hook: CloseHook = vi.fn(async () => {});
    registerCloseHook('h1', hook);
    expect(listCloseHooks()).toEqual(['h1']);
    unregisterCloseHook('h1');
    expect(listCloseHooks()).toEqual([]);
  });

  it('registerCloseHook throws HookAlreadyRegisteredError on duplicate', () => {
    const hook: CloseHook = vi.fn(async () => {});
    registerCloseHook('dup', hook);
    expect(() => registerCloseHook('dup', hook)).toThrow(HookAlreadyRegisteredError);
  });

  it('replaceCloseHook inserts when missing and overwrites without throwing', () => {
    const a: CloseHook = vi.fn(async () => {});
    const b: CloseHook = vi.fn(async () => {});
    replaceCloseHook('rep', a); // insert
    expect(listCloseHooks()).toEqual(['rep']);
    expect(() => replaceCloseHook('rep', b)).not.toThrow(); // overwrite
    expect(listCloseHooks()).toEqual(['rep']);
  });

  it('listCloseHooks reflects registration order', () => {
    const noop: CloseHook = vi.fn(async () => {});
    registerCloseHook('first', noop);
    registerCloseHook('second', noop);
    registerCloseHook('third', noop);
    expect(listCloseHooks()).toEqual(['first', 'second', 'third']);
  });
});

// ---------------------------------------------------------------------------
// closePosition with NO hooks registered — the default state.
//
// REVISED by the flat-latch change. The original contract was "no hooks ⇒ ZERO
// extra reads", which existed so an instance without the accounting module paid
// nothing for it. Closing now always writes the latched flat snapshot
// (`last_flat_at` / `last_flat_net_pnl`), which the completed-trade statistics
// depend on and which has nothing to do with accounting — so the fills and
// account reads it needs are core close-flow cost, not hook cost.
//
// The guarantee that still holds, and is what this asserts: those reads happen
// exactly ONCE whether or not hooks are registered. Registering the ledger hook
// must not multiply them.
// ---------------------------------------------------------------------------

describe('closePosition — no hooks registered (default state)', () => {
  it('reads fills and account exactly once for the flat latch, with an empty registry', async () => {
    // Sanity: the registry must be empty at this point (bootstrap() not called).
    expect(listCloseHooks()).toEqual([]);

    const { userId, positionId } = await seedClosablePosition();

    // Install the spies AFTER seeding: seedClosablePosition()'s createPosition
    // legitimately calls findAccountById once (the ownership check). The
    // assertion below targets closePosition's behavior with an empty registry,
    // so only its calls — not the seed's — must be counted.
    const accountSpy = vi.spyOn(accountsQuery, 'findAccountById');
    const fillsSpy = vi.spyOn(positionsQuery, 'findFillsByPosition');

    const closed = await closePosition(db, positionId, userId);
    expect(closed.status).toBe('closed');

    // Once each, for the latch — not zero (pre-latch), and not twice (which
    // would mean the hook path re-read what the latch already fetched).
    expect(accountSpy).toHaveBeenCalledTimes(1);
    expect(fillsSpy).toHaveBeenCalledTimes(1);

    accountSpy.mockRestore();
    fillsSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// closePosition with one hook
// ---------------------------------------------------------------------------

describe('closePosition — single hook invocation', () => {
  afterEach(() => {
    for (const name of listCloseHooks()) unregisterCloseHook(name);
  });

  it('invokes the hook with a correctly-shaped ctx', async () => {
    const calls: Array<{ ctx: unknown }> = [];
    const hook: CloseHook = async (_tx, ctx) => {
      calls.push({ ctx });
    };
    registerCloseHook('one', hook);

    const { userId, accountId, positionId } = await seedClosablePosition();
    await closePosition(db, positionId, userId);

    expect(calls).toHaveLength(1);
    const ctx = calls[0].ctx as {
      position: { id: string; status: string; userId: string };
      account: { id: string; currency: string; brokerageName: string | null };
      netPnl: string;
    };
    expect(ctx.position.id).toBe(positionId);
    expect(ctx.position.status).toBe('closed');
    expect(ctx.position.userId).toBe(userId);
    expect(ctx.account.id).toBe(accountId);
    expect(ctx.account.currency).toBe('USD');
    // Joined brokerageName field exists on the account row (null when no brokerage).
    expect(ctx.account).toHaveProperty('brokerageName');
    // 10 shares × ($105 - $100) = $50.00 net of zero fees, formatted to 4dp.
    expect(ctx.netPnl).toBe('50.0000');
  });
});

// ---------------------------------------------------------------------------
// closePosition with multiple hooks — order + snapshot freeze
// ---------------------------------------------------------------------------

describe('closePosition — multi-hook order + snapshot freeze', () => {
  afterEach(() => {
    for (const name of listCloseHooks()) unregisterCloseHook(name);
  });

  it('invokes hooks in registration order', async () => {
    const calls: string[] = [];
    registerCloseHook('alpha', async () => {
      calls.push('alpha');
    });
    registerCloseHook('beta', async () => {
      calls.push('beta');
    });
    registerCloseHook('gamma', async () => {
      calls.push('gamma');
    });

    const { userId, positionId } = await seedClosablePosition();
    await closePosition(db, positionId, userId);

    expect(calls).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('mid-loop replaceCloseHook does NOT affect the in-flight close (Array.from snapshot)', async () => {
    const calls: string[] = [];
    // alpha mutates the registry mid-iteration: replace beta + add late.
    registerCloseHook('alpha', async () => {
      calls.push('alpha');
      replaceCloseHook('beta', async () => {
        calls.push('beta-REPLACED');
      });
      replaceCloseHook('late', async () => {
        calls.push('late');
      });
    });
    registerCloseHook('beta', async () => {
      calls.push('beta-ORIGINAL');
    });

    const { userId, positionId } = await seedClosablePosition();
    await closePosition(db, positionId, userId);

    // The snapshot was taken before the loop — the original beta runs, and
    // the freshly-added "late" hook is NOT invoked in this close.
    expect(calls).toEqual(['alpha', 'beta-ORIGINAL']);
  });
});

// ---------------------------------------------------------------------------
// Rollback: hook throws → ledger inserts + position update both rolled back
// ---------------------------------------------------------------------------

describe('closePosition — rollback on hook throw', () => {
  afterEach(() => {
    for (const name of listCloseHooks()) unregisterCloseHook(name);
  });

  it('single hook throws after partial insert → ledger rows and status revert', async () => {
    const groupId = crypto.randomUUID();
    registerCloseHook('writes-then-throws', async (tx, ctx) => {
      await tx.insert(ledgerEntries).values({
        userId: ctx.position.userId,
        accountId: ctx.account.id,
        positionId: ctx.position.id,
        entryType: 'position_pnl',
        direction: 'credit',
        amount: '1.0000',
        currency: ctx.account.currency,
        symbol: ctx.position.symbol,
        occurredAt: new Date('2026-01-02T00:00:00Z'),
        groupId,
        reversesGroupId: null,
      });
      throw new Error('intentional hook failure');
    });

    const { userId, positionId } = await seedClosablePosition();

    await expect(closePosition(db, positionId, userId)).rejects.toThrow('intentional hook failure');

    // Position status untouched.
    const reread = await db.select().from(positions).where(eq(positions.id, positionId));
    expect(reread[0]?.status).toBe('open');

    // No ledger rows persisted for this position.
    const rows = await db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.positionId, positionId));
    expect(rows[0]?.count).toBe(0);
  });

  it('second hook throws → first hooks writes also rolled back', async () => {
    const firstGroupId = crypto.randomUUID();
    registerCloseHook('first-writes', async (tx, ctx) => {
      await tx.insert(ledgerEntries).values({
        userId: ctx.position.userId,
        accountId: ctx.account.id,
        positionId: ctx.position.id,
        entryType: 'position_pnl',
        direction: 'credit',
        amount: '2.0000',
        currency: ctx.account.currency,
        symbol: ctx.position.symbol,
        occurredAt: new Date('2026-01-02T00:00:00Z'),
        groupId: firstGroupId,
        reversesGroupId: null,
      });
    });
    registerCloseHook('second-throws', async () => {
      throw new Error('second hook bomb');
    });

    const { userId, positionId } = await seedClosablePosition();

    await expect(closePosition(db, positionId, userId)).rejects.toThrow('second hook bomb');

    const reread = await db.select().from(positions).where(eq(positions.id, positionId));
    expect(reread[0]?.status).toBe('open');

    const rows = await db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.positionId, positionId));
    expect(rows[0]?.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildCloseHookContext unit tests — invariant branches mocked
// ---------------------------------------------------------------------------

describe('buildCloseHookContext — invariant branches (mocked queries)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws InvariantViolationError when findAccountById returns []', async () => {
    vi.spyOn(accountsQuery, 'findAccountById').mockResolvedValueOnce(
      [] as unknown as Awaited<ReturnType<typeof accountsQuery.findAccountById>>,
    );

    const fakePosition = {
      id: '00000000-0000-0000-0000-000000000001',
      userId: '00000000-0000-0000-0000-000000000002',
      accountId: '00000000-0000-0000-0000-000000000003',
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
      status: 'closed',
      notes: null,
      openedAt: new Date('2026-01-01T00:00:00Z'),
      closedAt: new Date('2026-01-02T00:00:00Z'),
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    } as Awaited<ReturnType<typeof positionsQuery.updatePosition>>[number];

    await expect(
      buildCloseHookContext(
        db as unknown as Parameters<typeof buildCloseHookContext>[0],
        fakePosition,
        fakePosition.userId,
      ),
    ).rejects.toBeInstanceOf(InvariantViolationError);
  });

  it('throws InvariantViolationError when realizedPnl is null (no exit fills)', async () => {
    // Stub findAccountById → one row; findFillsByPosition → no fills so
    // computePnlFromTotals returns realizedPnl=null.
    vi.spyOn(accountsQuery, 'findAccountById').mockResolvedValueOnce([
      {
        id: '00000000-0000-0000-0000-000000000003',
        userId: '00000000-0000-0000-0000-000000000002',
        name: 'Fake',
        currency: 'USD',
        brokerageId: null,
        brokerageName: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        balance: null,
      },
    ] as unknown as Awaited<ReturnType<typeof accountsQuery.findAccountById>>);
    vi.spyOn(positionsQuery, 'findFillsByPosition').mockResolvedValueOnce(
      [] as unknown as Awaited<ReturnType<typeof positionsQuery.findFillsByPosition>>,
    );

    const fakePosition = {
      id: '00000000-0000-0000-0000-000000000001',
      userId: '00000000-0000-0000-0000-000000000002',
      accountId: '00000000-0000-0000-0000-000000000003',
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
      status: 'closed',
      notes: null,
      openedAt: new Date('2026-01-01T00:00:00Z'),
      closedAt: new Date('2026-01-02T00:00:00Z'),
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    } as Awaited<ReturnType<typeof positionsQuery.updatePosition>>[number];

    await expect(
      buildCloseHookContext(
        db as unknown as Parameters<typeof buildCloseHookContext>[0],
        fakePosition,
        fakePosition.userId,
      ),
    ).rejects.toBeInstanceOf(InvariantViolationError);
  });

  it('happy path: netPnl is toFixed(4) and account carries brokerageName', async () => {
    // Use the real DB path — a fully-seeded closable position. This is the
    // canonical "ctx shape" check; the invariant branches above use mocks.
    const { userId, accountId, positionId } = await seedClosablePosition();

    // Lookup the row we just updated to mimic a post-update position row.
    const positionRow = await db
      .select()
      .from(positions)
      .where(eq(positions.id, positionId))
      .limit(1);

    const ctx = await buildCloseHookContext(
      db as unknown as Parameters<typeof buildCloseHookContext>[0],
      positionRow[0] as Awaited<ReturnType<typeof positionsQuery.updatePosition>>[number],
      userId,
    );
    expect(ctx.account.id).toBe(accountId);
    expect(ctx.account).toHaveProperty('brokerageName');
    // 10 × $5 = $50; toFixed(4).
    expect(ctx.netPnl).toBe('50.0000');
  });
});

// ---------------------------------------------------------------------------
// Telemetry capture — position business events (Task 7, design Component 4).
// Spies the fire-and-forget captureServerEvent: the outer createPosition /
// closePosition emit exactly one event after commit with an opaque distinctId
// and identifiers/enums only; the *Tx bulk-import variants stay silent; a
// thrown capture never fails the committed operation.
// ---------------------------------------------------------------------------

async function seedUserAndAccount() {
  const [user] = await db
    .insert(users)
    .values({ email: uniqueEmail(), passwordHash: 'x'.repeat(60) })
    .returning();
  const [account] = await db
    .insert(accounts)
    .values({ userId: user!.id, name: 'Test Account', currency: 'USD' })
    .returning();
  return { userId: user!.id, accountId: account!.id };
}

describe('telemetry capture — position events', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('createPosition fires position_created once with opaque distinctId + assetType only, after commit', async () => {
    const { userId, accountId } = await seedUserAndAccount();
    const captureSpy = vi.spyOn(posthog, 'captureServerEvent').mockImplementation(() => {});

    const position = await createPosition(
      db,
      userId,
      { accountId, symbol: 'AAPL', side: 'long', assetType: 'stock' },
      { isAdmin: false },
    );

    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(captureSpy).toHaveBeenCalledWith('position_created', {
      distinctId: userId,
      properties: { assetType: 'stock' },
    });
    // Properties carry identifiers/enums only — no financial fields.
    expect(Object.keys(captureSpy.mock.calls[0]![1].properties!)).toEqual(['assetType']);

    // After-commit: the position is persisted and queryable.
    const rows = await db.select().from(positions).where(eq(positions.id, position.id));
    expect(rows).toHaveLength(1);
  });

  it('closePosition fires position_closed once with assetType from the returned row, after commit', async () => {
    const { userId, positionId } = await seedClosablePosition();
    const captureSpy = vi.spyOn(posthog, 'captureServerEvent').mockImplementation(() => {});

    const closed = await closePosition(db, positionId, userId);
    expect(closed.status).toBe('closed');

    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(captureSpy).toHaveBeenCalledWith('position_closed', {
      distinctId: userId,
      properties: { assetType: 'stock' },
    });
    expect(Object.keys(captureSpy.mock.calls[0]![1].properties!)).toEqual(['assetType']);
  });

  it('the *Tx bulk-import variants do NOT capture', async () => {
    const { userId, accountId } = await seedUserAndAccount();
    const captureSpy = vi.spyOn(posthog, 'captureServerEvent').mockImplementation(() => {});

    await withTransaction(db, async (tx) => {
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
        filledAt: '2026-01-01T00:00:00Z',
      });
      await openPositionTx(tx, pos!.id, userId, '2026-01-01T00:00:00Z');
      await addFillTx(tx, pos!.id, userId, {
        type: 'exit',
        price: '105',
        quantity: '10',
        fees: '0',
        filledAt: '2026-01-02T00:00:00Z',
      });
      await closePositionTx(tx, pos!.id, userId, '2026-01-02T00:00:00Z');
    });

    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('a thrown capture does not fail createPosition (fire-and-forget)', async () => {
    const { userId, accountId } = await seedUserAndAccount();
    vi.spyOn(posthog, 'captureServerEvent').mockImplementation(() => {
      throw new Error('posthog boom');
    });

    const position = await createPosition(
      db,
      userId,
      { accountId, symbol: 'AAPL', side: 'long', assetType: 'stock' },
      { isAdmin: false },
    );
    expect(position.id).toBeDefined();

    // The business op committed despite the capture throwing.
    const rows = await db.select().from(positions).where(eq(positions.id, position.id));
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// editPosition service backstop (design Component 3, REQ-5.2/5.3/5.5).
// The authoritative server-side update gate: rejects asset-type changes (409)
// and re-validates a CHANGED option symbol (400). createPosition is used to
// seed rows because it bypasses route Zod — letting us plant a legacy non-OCC
// option row the same way a seed/CSV write would.
// ---------------------------------------------------------------------------

async function seedDraftPosition(opts: { symbol: string; assetType: 'stock' | 'option' }) {
  const { userId, accountId } = await seedUserAndAccount();
  const position = await createPosition(
    db,
    userId,
    { accountId, symbol: opts.symbol, side: 'long', assetType: opts.assetType },
    { isAdmin: false },
  );
  return { userId, accountId, positionId: position!.id };
}

describe('editPosition — service backstop', () => {
  it('rejects an asset-type change with ConflictError (409)', async () => {
    const { userId, positionId } = await seedDraftPosition({
      symbol: 'AAPL',
      assetType: 'stock',
    });

    await expect(
      editPosition(db, positionId, userId, { assetType: 'option' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('rejects a changed option symbol to a non-OCC value with ValidationError (details.symbol)', async () => {
    // assetType omitted so only the backstop runs (no edge refine at this layer).
    const { userId, positionId } = await seedDraftPosition({
      symbol: 'AAPL260116C150',
      assetType: 'option',
    });

    const err = await editPosition(db, positionId, userId, { symbol: 'NOTANOPTION' }).catch(
      (e) => e as ValidationError,
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).details).toEqual({ symbol: expect.any(String) });
  });

  it('allows a notes-only edit of a legacy non-OCC option row when symbol is omitted', async () => {
    const { userId, positionId } = await seedDraftPosition({
      symbol: 'AAPL', // legacy non-OCC option symbol
      assetType: 'option',
    });

    const updated = await editPosition(db, positionId, userId, { notes: 'just a note' });
    expect(updated.notes).toBe('just a note');
    expect(updated.symbol).toBe('AAPL');
  });

  it('does not re-validate when the identical normalised symbol is re-sent', async () => {
    // Legacy non-OCC option row: re-sending the same value must NOT re-validate.
    const { userId, positionId } = await seedDraftPosition({
      symbol: 'AAPL',
      assetType: 'option',
    });

    const updated = await editPosition(db, positionId, userId, { symbol: 'AAPL' });
    expect(updated.symbol).toBe('AAPL');
  });

  it('treats a case/whitespace-only symbol difference as unchanged', async () => {
    const { userId, positionId } = await seedDraftPosition({
      symbol: 'AAPL',
      assetType: 'option',
    });

    const updated = await editPosition(db, positionId, userId, { symbol: '  aapl  ' });
    // normalise-only difference → unchanged → backstop skipped → succeeds.
    expect(updated.symbol).toBe('  aapl  ');
  });
});

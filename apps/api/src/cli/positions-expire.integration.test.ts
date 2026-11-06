/**
 * Operator CLI, `tradr positions expire` (design C11; task 17 of
 * option-lifecycle-events). Black-box over `runPositionsExpire(args, deps)` —
 * `deps.db` is the per-test transaction handle from `src/test-setup.ts`, the
 * "injectable database handle" the task prompt calls for, so every case here
 * runs against real Postgres through the same connection `option-settlement
 * .test.ts` uses. `args` is the argv AFTER the `positions expire` tokens,
 * matching the existing `runCreateUser(argv)` / `runUnlock(argv)` shape in
 * `tradr.ts`, which strips the subcommand name before dispatch.
 *
 * No hook is pre-registered anywhere in this file (unlike
 * `option-settlement.test.ts`, which registers the `'ledger'` hooks itself to
 * play the HTTP server's role). That is deliberate: AC 9.3's whole point is
 * that the CLI — run as its own process with no `bootstrap()` — registers
 * them itself via `initLedgerRuntime()`. If it does not, `runFillHooks`
 * returns at `positions.service.ts:238` and no ledger row is ever written.
 * `beforeEach`/`afterEach` strip the `'ledger'` hooks so no test's pass can be
 * explained by a previous test's leftover registration.
 *
 * Contract block — one entry per success criterion this task covers.
 * Pre-condition → call through the seam → observable result → source of the
 * expected value.
 *
 * A. `--user` lists only that user's flagged leg and writes nothing (AC 9.1
 *    first clause)
 *   Pre: user A has one open, past-expiry option leg (flagged) and one open,
 *     future-expiry leg (not flagged); user B has its own past-expiry leg.
 *   Call: `runPositionsExpire(['--user', A.email], { db })`.
 *   Result: exit code 0; printed output names A's flagged leg id and neither
 *     A's unflagged leg id nor B's leg id; A's flagged leg is unchanged
 *     (still one fill, still open) and has no ledger row.
 *   Source: AC 9.1 ("list that user's flagged legs and write nothing");
 *     `isPastExpiryUnsettled` (task 1) is the flag the list must honour.
 *
 * B. `--all-users` lists flagged legs across users (AC 9.1 second clause)
 *   Pre: user A and user B each have one open, past-expiry leg.
 *   Call: `runPositionsExpire(['--all-users'], { db })`.
 *   Result: exit code 0; printed output names both legs' ids.
 *   Source: AC 9.1 ("`--all-users` SHALL do the same across users").
 *
 * C. `--settle` settles through `settleLeg`, writing the same ledger row the
 *    POST would (AC 9.2, 9.3)
 *   Pre: user A, one open short leg, entry price 3, quantity 5, no fees, past
 *     expiry.
 *   Call: `runPositionsExpire(['--user', A.email, '--settle',
 *     '<legId>=worthless'], { db })`.
 *   Result: exit code 0; the leg closes with a new exit fill at price 0;
 *     exactly one `ledger_entries` row for the leg, `entryType:
 *     'position_pnl'`, `direction: 'credit'`, `amount: '1500.0000'`.
 *   Source: design C11 ("settles through settleLeg... writes the same ledger
 *     rows as the POST"); the amount is `pnl.ts computePnlFromTotals`'s own
 *     formula — `(0 − 3) × 5 × −1(short) × 100(option) = 1500` — through
 *     `ledger-hook.ts postRealizedDelta`, which posts the full cumulative
 *     amount as a credit the first time anything posts for the position.
 *
 * D. Bad arguments exit 2 with no write (AC 9.4 bad-argument clause;
 *    Restriction "exactly one of --user and --all-users"; AC 9.2 "no outcome
 *    SHALL be assumed") — three sub-cases folded onto one mechanism
 *   D1. Pre: no state needed. Call: `runPositionsExpire([], { db })`.
 *     Result: exit code 2 (neither `--user` nor `--all-users` given).
 *   D2. Pre: user A exists. Call: `runPositionsExpire(['--user', A.email,
 *     '--all-users'], { db })`. Result: exit code 2 (both given).
 *   D3. Pre: user A has one open, past-expiry leg. Call:
 *     `runPositionsExpire(['--user', A.email, '--settle', legId], { db })`
 *     (no `=outcome`). Result: exit code 2; the leg is untouched (still one
 *     fill, still open).
 *   Source: design C11 Restrictions ("exactly one of --user and --all-users,
 *     else exit 2"; "no outcome is assumed"); AC 9.4 ("bad arguments... [is]
 *     2").
 *
 * E. A leg of another user under `--user` fails; the run continues and exits
 *    1 (AC 9.4: ownership failure + continue-past-failure + exit 1)
 *   Pre: user A has an eligible, past-expiry short leg (legA); user B has its
 *     own eligible, past-expiry short leg (legB).
 *   Call: `runPositionsExpire(['--user', A.email, '--settle',
 *     '<legA>=worthless', '--settle', '<legB>=worthless'], { db })`.
 *   Result: exit code 1; legA closes with a new exit fill and a ledger row;
 *     legB is untouched (still one fill, still open, no ledger row); printed
 *     output names legB's id as the failed leg.
 *   Source: design C11 ("with --user, a leg of another user fails"); AC 9.4
 *     ("one failed leg prints its reason, the run continues... exit... 1").
 *
 * F. All given legs succeeding exits 0, for more than one leg (AC 9.4 "all
 *    succeeding is 0")
 *   Pre: user A has two eligible, past-expiry short legs (legC, legD).
 *   Call: `runPositionsExpire(['--user', A.email, '--settle',
 *     '<legC>=worthless', '--settle', '<legD>=worthless'], { db })`.
 *   Result: exit code 0; both legs close with a new exit fill each.
 *   Source: AC 9.4 ("all succeeding is 0").
 *
 * G. A database/connection failure exits 2 (AC 9.4 connection-failure clause)
 *   Pre: user A exists. `deps.db` is a stand-in whose every operation rejects
 *     — any query the list step issues fails exactly as a dead connection
 *     would.
 *   Call: `runPositionsExpire(['--user', A.email], { db: brokenDb })`.
 *   Result: exit code 2.
 *   Source: AC 9.4 ("a connection failure is 2"); design C11 ("as in
 *     apps/api/src/cli/tradr.ts:729-732").
 *
 * Folded/dropped criteria (recorded, not separately retested here):
 *   - AC 9.5 ("USAGE SHALL name the command"): no test seam in this task.
 *     The task names exactly one Test line — `runPositionsExpire(args,
 *     deps)` in this file. `USAGE` and `main()` in `tradr.ts` are private
 *     (unexported), and the task's own text says "`tradr.test.ts` pins no
 *     USAGE line, so no asserted value changes" — the existing test file has
 *     no hook onto USAGE content at all. This mirrors task 16's "No test
 *     seam... Implementer-only" pattern. Not retested here; the implementer
 *     adds the line per the prompt's exact text.
 *   - Requirement 11.2 ("No boot-time sweep or timer SHALL settle or flag
 *     anything"): RED-IMPOSSIBLE at base. `apps/api/src/no-scheduler.guard
 *     .test.ts` (task 16, already committed) walks every product file under
 *     `apps/api/src` with `ts.createSourceFile` and fails on any `setInterval`
 *     call expression outside its five-file allow-list — a check that
 *     necessarily re-scans `ledger-runtime.ts` and `positions-expire.ts` once
 *     they exist, because it has no file-list of its own to go stale against.
 *     Its "the scan passes on the tree" case already covers both branches
 *     this task could violate (a bare `setInterval` call in either new file;
 *     an import from the cron-library denylist in either new file) — no new
 *     assertion is needed, and none is added here. Named for the implementer
 *     brief: add no timer, no boot-time sweep, to either new file.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '@/db';
import { db } from '@/db';
import { accounts, fills, ledgerEntries, positions, users } from '@/db/schema';
import {
  addFillTx,
  createPositionTx,
  openPositionTx,
  unregisterCloseHook,
  unregisterFillHook,
  unregisterReverseHook,
} from '@/features/positions/positions.service';
import { withTransaction } from '@/lib/transaction';

import { runPositionsExpire } from './positions-expire';

// 2025-01-17 — safely past "today" (2026-11-05) under any DST/instant rule.
const PAST_SYMBOL_BASE = 'AAPL250117';
// 2031-12-31 — safely future, so this leg is never flagged.
const FUTURE_SYMBOL = 'AAPL311231C00150000';

function occSymbol(type: 'C' | 'P', strike: number): string {
  const strikeField = Math.round(strike * 1000)
    .toString()
    .padStart(8, '0');
  return `${PAST_SYMBOL_BASE}${type}${strikeField}`;
}

let counter = 0;
function uniqueEmail(): string {
  return `positions-expire-${Date.now()}-${++counter}@example.com`;
}

async function seedUserAndAccount() {
  const email = uniqueEmail();
  const [user] = await db.insert(users).values({ email, passwordHash: 'x'.repeat(60) }).returning();
  const [account] = await db
    .insert(accounts)
    .values({ userId: user!.id, name: 'Expire Account', currency: 'USD' })
    .returning();
  return { userId: user!.id, email, accountId: account!.id };
}

async function createOptionLeg(params: {
  accountId: string;
  userId: string;
  side: 'long' | 'short';
  symbol: string;
  entryPrice: string;
  entryQty: string;
  filledAt: string;
}) {
  return withTransaction(db, async (tx) => {
    const pos = await createPositionTx(tx, params.userId, {
      accountId: params.accountId,
      symbol: params.symbol,
      side: params.side,
      assetType: 'option',
    });
    await addFillTx(tx, pos!.id, params.userId, {
      type: 'entry',
      price: params.entryPrice,
      quantity: params.entryQty,
      fees: '0',
      filledAt: params.filledAt,
    });
    await openPositionTx(tx, pos!.id, params.userId, params.filledAt);
    return pos!.id as string;
  });
}

async function getPositionRow(id: string) {
  const rows = await db.select().from(positions).where(eq(positions.id, id));
  return rows[0]!;
}

async function getFillsForLeg(legId: string) {
  return db.select().from(fills).where(eq(fills.positionId, legId));
}

async function getLedgerRowsForPosition(positionId: string) {
  return db.select().from(ledgerEntries).where(eq(ledgerEntries.positionId, positionId));
}

/**
 * A stand-in `Database` whose every operation rejects — the generic shape of
 * a dead connection, regardless of which drizzle call the implementation
 * issues first. Any property read returns a function; calling that function,
 * or awaiting the proxy itself (`then` is intercepted), rejects with the same
 * error — so `db.select().from(x)`, `db.execute(sql\`...\`)` and
 * `db.transaction(fn)` all fail the same way a refused connection would,
 * without this test knowing the exact query the implementation runs.
 */
function makeBrokenDb(): Database {
  const err = new Error('connection refused');
  const target = () => {};
  const proxy: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') {
        return (_resolve: unknown, reject: (e: unknown) => void) => reject(err);
      }
      return () => proxy;
    },
    apply() {
      return proxy;
    },
  });
  return proxy as Database;
}

beforeEach(() => {
  unregisterCloseHook('ledger');
  unregisterReverseHook('ledger');
  unregisterFillHook('ledger');
});

afterEach(() => {
  unregisterCloseHook('ledger');
  unregisterReverseHook('ledger');
  unregisterFillHook('ledger');
});

/**
 * Captures every `console.log`/`console.error` line printed during a call,
 * the same `vi.spyOn(console, ...)` pattern `tradr.integration.test.ts` and
 * `performance.test.ts` already use — no injected `console` seam, since the
 * task only calls for an injectable database handle.
 */
function captureOutput() {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  const log = vi.spyOn(console, 'log').mockImplementation(record);
  const error = vi.spyOn(console, 'error').mockImplementation(record);
  return {
    text: () => lines.join('\n'),
    restore: () => {
      log.mockRestore();
      error.mockRestore();
    },
  };
}

describe('A. --user lists only that user\'s flagged leg and writes nothing (AC 9.1)', () => {
  it('names the flagged leg, excludes the unflagged and foreign legs, and writes nothing', async () => {
    const userA = await seedUserAndAccount();
    const userB = await seedUserAndAccount();

    const flaggedLeg = await createOptionLeg({
      accountId: userA.accountId,
      userId: userA.userId,
      side: 'short',
      symbol: occSymbol('C', 150),
      entryPrice: '3',
      entryQty: '5',
      filledAt: '2024-12-01T00:00:00.000Z',
    });
    const unflaggedLeg = await createOptionLeg({
      accountId: userA.accountId,
      userId: userA.userId,
      side: 'short',
      symbol: FUTURE_SYMBOL,
      entryPrice: '3',
      entryQty: '5',
      filledAt: '2024-12-01T00:00:00.000Z',
    });
    const foreignLeg = await createOptionLeg({
      accountId: userB.accountId,
      userId: userB.userId,
      side: 'short',
      symbol: occSymbol('P', 150),
      entryPrice: '2',
      entryQty: '4',
      filledAt: '2024-12-01T00:00:00.000Z',
    });

    const out = captureOutput();
    const exitCode = await runPositionsExpire(['--user', userA.email], { db });
    out.restore();

    expect(exitCode).toBe(0);
    expect(out.text()).toContain(flaggedLeg);
    expect(out.text()).not.toContain(unflaggedLeg);
    expect(out.text()).not.toContain(foreignLeg);

    const row = await getPositionRow(flaggedLeg);
    expect(row.status).toBe('open');
    expect((await getFillsForLeg(flaggedLeg)).length).toBe(1);
    expect((await getLedgerRowsForPosition(flaggedLeg)).length).toBe(0);
  });
});

describe('B. --all-users lists flagged legs across users (AC 9.1)', () => {
  it('names both users\' flagged legs', async () => {
    const userA = await seedUserAndAccount();
    const userB = await seedUserAndAccount();

    const legA = await createOptionLeg({
      accountId: userA.accountId,
      userId: userA.userId,
      side: 'short',
      symbol: occSymbol('C', 150),
      entryPrice: '3',
      entryQty: '5',
      filledAt: '2024-12-01T00:00:00.000Z',
    });
    const legB = await createOptionLeg({
      accountId: userB.accountId,
      userId: userB.userId,
      side: 'short',
      symbol: occSymbol('P', 160),
      entryPrice: '2',
      entryQty: '4',
      filledAt: '2024-12-01T00:00:00.000Z',
    });

    const out = captureOutput();
    const exitCode = await runPositionsExpire(['--all-users'], { db });
    out.restore();

    expect(exitCode).toBe(0);
    expect(out.text()).toContain(legA);
    expect(out.text()).toContain(legB);
  });
});

describe('C. --settle settles through settleLeg and writes the same ledger row the POST would (AC 9.2, 9.3)', () => {
  it('closes the leg with an exit fill at 0 and posts one credit position_pnl row of 1500.0000', async () => {
    const userA = await seedUserAndAccount();
    const legId = await createOptionLeg({
      accountId: userA.accountId,
      userId: userA.userId,
      side: 'short',
      symbol: occSymbol('C', 150),
      entryPrice: '3',
      entryQty: '5',
      filledAt: '2024-12-01T00:00:00.000Z',
    });

    const exitCode = await runPositionsExpire(
      ['--user', userA.email, '--settle', `${legId}=worthless`],
      { db },
    );

    expect(exitCode).toBe(0);

    const row = await getPositionRow(legId);
    expect(row.status).toBe('closed');

    const legFills = await getFillsForLeg(legId);
    const exit = legFills.find((f) => f.type === 'exit');
    expect(exit).toBeDefined();
    expect(Number(exit!.price)).toBe(0);

    const ledgerRows = await getLedgerRowsForPosition(legId);
    expect(ledgerRows.length).toBe(1);
    expect(ledgerRows[0]!.entryType).toBe('position_pnl');
    expect(ledgerRows[0]!.direction).toBe('credit');
    expect(ledgerRows[0]!.amount).toBe('1500.0000');
  });
});

describe('D. Bad arguments exit 2 with no write (AC 9.4; Restriction; AC 9.2)', () => {
  it('D1. neither --user nor --all-users given', async () => {
    const exitCode = await runPositionsExpire([], { db });
    expect(exitCode).toBe(2);
  });

  it('D2. both --user and --all-users given', async () => {
    const userA = await seedUserAndAccount();
    const exitCode = await runPositionsExpire(['--user', userA.email, '--all-users'], { db });
    expect(exitCode).toBe(2);
  });

  it('D3. --settle with no =outcome assumes nothing and leaves the leg untouched', async () => {
    const userA = await seedUserAndAccount();
    const legId = await createOptionLeg({
      accountId: userA.accountId,
      userId: userA.userId,
      side: 'short',
      symbol: occSymbol('C', 150),
      entryPrice: '3',
      entryQty: '5',
      filledAt: '2024-12-01T00:00:00.000Z',
    });

    const exitCode = await runPositionsExpire(['--user', userA.email, '--settle', legId], { db });

    expect(exitCode).toBe(2);
    const row = await getPositionRow(legId);
    expect(row.status).toBe('open');
    expect((await getFillsForLeg(legId)).length).toBe(1);
  });
});

describe('E. A leg of another user under --user fails; the run continues and exits 1 (AC 9.4)', () => {
  it('settles the owned leg, fails the foreign leg by name, continues, and exits 1', async () => {
    const userA = await seedUserAndAccount();
    const userB = await seedUserAndAccount();

    const legA = await createOptionLeg({
      accountId: userA.accountId,
      userId: userA.userId,
      side: 'short',
      symbol: occSymbol('C', 150),
      entryPrice: '3',
      entryQty: '5',
      filledAt: '2024-12-01T00:00:00.000Z',
    });
    const legB = await createOptionLeg({
      accountId: userB.accountId,
      userId: userB.userId,
      side: 'short',
      symbol: occSymbol('P', 160),
      entryPrice: '2',
      entryQty: '4',
      filledAt: '2024-12-01T00:00:00.000Z',
    });

    const out = captureOutput();
    const exitCode = await runPositionsExpire(
      [
        '--user',
        userA.email,
        '--settle',
        `${legA}=worthless`,
        '--settle',
        `${legB}=worthless`,
      ],
      { db },
    );
    out.restore();

    expect(exitCode).toBe(1);
    expect(out.text()).toContain(legB);

    const rowA = await getPositionRow(legA);
    expect(rowA.status).toBe('closed');
    expect((await getFillsForLeg(legA)).some((f) => f.type === 'exit')).toBe(true);

    const rowB = await getPositionRow(legB);
    expect(rowB.status).toBe('open');
    expect((await getFillsForLeg(legB)).length).toBe(1);
    expect((await getLedgerRowsForPosition(legB)).length).toBe(0);
  });
});

describe('F. All given legs succeeding exits 0, for more than one leg (AC 9.4)', () => {
  it('closes both legs and exits 0', async () => {
    const userA = await seedUserAndAccount();
    const legC = await createOptionLeg({
      accountId: userA.accountId,
      userId: userA.userId,
      side: 'short',
      symbol: occSymbol('C', 150),
      entryPrice: '3',
      entryQty: '5',
      filledAt: '2024-12-01T00:00:00.000Z',
    });
    const legD = await createOptionLeg({
      accountId: userA.accountId,
      userId: userA.userId,
      side: 'short',
      symbol: occSymbol('P', 160),
      entryPrice: '2',
      entryQty: '4',
      filledAt: '2024-12-01T00:00:00.000Z',
    });

    const exitCode = await runPositionsExpire(
      [
        '--user',
        userA.email,
        '--settle',
        `${legC}=worthless`,
        '--settle',
        `${legD}=worthless`,
      ],
      { db },
    );

    expect(exitCode).toBe(0);
    expect((await getPositionRow(legC)).status).toBe('closed');
    expect((await getPositionRow(legD)).status).toBe('closed');
  });
});

describe('G. A database/connection failure exits 2 (AC 9.4)', () => {
  it('exits 2 when every db operation rejects', async () => {
    const userA = await seedUserAndAccount();
    const exitCode = await runPositionsExpire(['--user', userA.email], { db: makeBrokenDb() });
    expect(exitCode).toBe(2);
  });
});


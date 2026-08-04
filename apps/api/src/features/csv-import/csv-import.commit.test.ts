import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, it, expect } from 'vitest';

import app from '@/app';
import { db } from '@/db';
import { fills, ledgerEntries, positions, subscriptions, users } from '@/db/schema';
import { csvImportCounters, csvImportStaging } from '@/db/schema/csv-import.schema';
import { insertPositionCloseLedgerEntries } from '@/features/accounting/ledger-hook';
import { getTierLimits } from '@/features/billing/tier-limits.constants';
import {
  type CloseHookContext,
  replaceCloseHook,
  unregisterCloseHook,
} from '@/features/positions/positions.service';
import { config } from '@/lib/config';

// Register the live ledger close-hook directly (NOT the full async `bootstrap()`,
// which also runs migrations / decrypt-canary against `db` — undefined at
// `beforeAll` time before the per-test transaction is installed). `replaceCloseHook`
// is idempotent, so re-registering across suites is safe.
function registerLedgerHook() {
  replaceCloseHook('ledger', insertPositionCloseLedgerEntries);
}

// ---------------------------------------------------------------------------
// Commit-path integration tests (design Testing Strategy → Integration, commit
// half; plus the Bulk-composition behaviors at the API level). Drives the full
// POST /api/csv-import/preview → POST /api/csv-import/commit handshake through
// Hono `app.request` against a real Postgres (no DB mocks; per-test
// transaction-rollback isolation from test-setup.ts). Mirrors the
// positions.test.ts / csv-import.preview.test.ts real-PG harness: register →
// session cookie → create account → authed multipart preview → JSON commit.
//
// The live `ledger` close-hook is registered directly so the close path fires
// it INSIDE the bulk tx (the close-hook-inside-bulk-tx contract). The Phase-B
// atomicity case temporarily swaps in a throwing hook to inject a mid-replay
// failure (a faithful constraint-equivalent: the same call-site the production
// close hook runs on, made to throw), then restores the real hook.
// ---------------------------------------------------------------------------

let testCounter = 0;
function uniqueEmail() {
  return `csv-commit-${Date.now()}-${++testCounter}@example.com`;
}

let ipCounter = 0;
function uniqueIp() {
  return `10.77.${Math.floor(++ipCounter / 256)}.${ipCounter % 256}`;
}

function getCookieValue(res: Response, name: string): string | undefined {
  for (const header of res.headers.getSetCookie()) {
    const match = header.match(new RegExp(`${name}=([^;]*)`));
    if (match) return match[1];
  }
  return undefined;
}

async function registerAndGetCookie(): Promise<string> {
  const res = await app.request('/api/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': uniqueIp(),
    },
    body: JSON.stringify({ email: uniqueEmail(), password: 'password123' }),
  });
  expect(res.status).toBe(201);
  const cookie = getCookieValue(res, 'session');
  expect(cookie).toBeDefined();
  return cookie!;
}

async function createAccount(
  cookie: string,
  currency = 'USD',
  name = 'Import Account',
): Promise<string> {
  const res = await app.request('/api/accounts', {
    method: 'POST',
    headers: {
      Cookie: `session=${cookie}`,
      'Content-Type': 'application/json',
      'X-Forwarded-For': uniqueIp(),
    },
    body: JSON.stringify({ name, currency }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  return body.id as string;
}

/** A minimal valid execution-shape preview request. */
function execRequest(accountId: string) {
  return {
    accountId,
    rowShape: 'execution',
    mapping: {
      rowShape: 'execution',
      columns: {
        symbol: 'Symbol',
        assetType: 'Type',
        action: 'Side',
        price: 'Price',
        quantity: 'Quantity',
        filledAt: 'Date',
        fees: 'Fees',
      },
    },
    timezone: 'UTC',
    dateFormat: 'iso',
    numberFormat: 'us',
  };
}

/** A manual round-trip mapping (no round-trip preset ships, deferral d-b394aea7). */
function roundTripRequest(accountId: string) {
  return {
    accountId,
    rowShape: 'round-trip',
    mapping: {
      rowShape: 'round-trip',
      columns: {
        symbol: 'Symbol',
        assetType: 'AssetType',
        side: 'Side',
        entryPrice: 'EntryPrice',
        entryQuantity: 'EntryQty',
        entryDate: 'EntryDate',
        exitPrice: 'ExitPrice',
        exitQuantity: 'ExitQty',
        exitDate: 'ExitDate',
      },
    },
    timezone: 'UTC',
    dateFormat: 'iso',
    numberFormat: 'us',
  };
}

/** POST a multipart preview (real FormData: file Blob + `request` JSON string). */
async function postPreview(cookie: string, csv: string, request: unknown): Promise<Response> {
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'trades.csv');
  form.append('request', JSON.stringify(request));
  return app.request('/api/csv-import/preview', {
    method: 'POST',
    headers: {
      Cookie: `session=${cookie}`,
      'X-Forwarded-For': uniqueIp(),
    },
    body: form,
  });
}

/** POST a JSON commit. */
async function postCommit(
  cookie: string,
  token: string,
  confirmDuplicates?: boolean,
): Promise<Response> {
  const body: Record<string, unknown> = { token };
  if (confirmDuplicates !== undefined) body.confirmDuplicates = confirmDuplicates;
  return app.request('/api/csv-import/commit', {
    method: 'POST',
    headers: {
      Cookie: `session=${cookie}`,
      'Content-Type': 'application/json',
      'X-Forwarded-For': uniqueIp(),
    },
    body: JSON.stringify(body),
  });
}

/** Preview a clean CSV and return its committable token. */
async function stageToken(cookie: string, csv: string, request: unknown): Promise<string> {
  const res = await postPreview(cookie, csv, request);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.committable).toBe(true);
  return body.token as string;
}

const CLEAN_CSV = [
  'Symbol,Type,Side,Price,Quantity,Date,Fees',
  'AAPL,STOCK,BUY,100,10,2026-01-01,1',
  'AAPL,STOCK,SELL,110,10,2026-01-02,1',
].join('\n');

// ===========================================================================
// Commit replay + lifecycle (end-to-end, real ledger hook inside the bulk tx)
// ===========================================================================

describe('POST /api/csv-import/commit — replay lifecycle', () => {
  beforeAll(registerLedgerHook);
  afterAll(() => unregisterCloseHook('ledger'));

  it('replays create→open→exit→close end-to-end with a ledger entry per closed position', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    const token = await stageToken(cookie, CLEAN_CSV, execRequest(accountId));

    const res = await postCommit(cookie, token);
    expect(res.status).toBe(200);
    const summary = await res.json();
    expect(summary.positionsCreated).toBe(1);
    expect(summary.fillsCreated).toBe(2);
    expect(summary.accountId).toBe(accountId);
    expect(summary.positionIds).toHaveLength(1);

    const posId = summary.positionIds[0] as string;
    const [pos] = await db.select().from(positions).where(eq(positions.id, posId));
    expect(pos!.status).toBe('closed');
    expect(pos!.side).toBe('long');

    const posFills = await db.select().from(fills).where(eq(fills.positionId, posId));
    expect(posFills).toHaveLength(2);

    // EXACTLY one, not merely non-zero. Realized P&L posts per fill now
    // (ledger-balances Req 9), so a bulk import could in principle write a row
    // per fill — but a whole trade realizes nothing on its entry and its full
    // P&L on the balancing exit, leaving the close with a zero delta. One row,
    // same as before per-fill posting. That equivalence is what keeps import
    // volume and its rollback semantics unchanged; a regression here would show
    // up as extra rows rather than as a failure elsewhere.
    const ledger = await db.select().from(ledgerEntries).where(eq(ledgerEntries.positionId, posId));
    expect(ledger).toHaveLength(1); // close hook fired inside the bulk tx
    expect(ledger[0]!.entryType).toBe('position_pnl');

    const staged = await db.select().from(csvImportStaging).where(eq(csvImportStaging.id, token));
    expect(staged[0]!.status).toBe('committed');
  });

  it('commits a short round-trip fixture (REQ-4.8): one closed short, entry+exit', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    // Manual round-trip shape, short side (opening sell → entry; covering buy → exit).
    const csv = [
      'Symbol,AssetType,Side,EntryPrice,EntryQty,EntryDate,ExitPrice,ExitQty,ExitDate',
      'AAPL,STOCK,SHORT,110,10,2026-01-01,100,10,2026-01-02',
    ].join('\n');
    const token = await stageToken(cookie, csv, roundTripRequest(accountId));

    const res = await postCommit(cookie, token);
    expect(res.status).toBe(200);
    const summary = await res.json();
    expect(summary.positionsCreated).toBe(1);
    expect(summary.fillsCreated).toBe(2);

    const posId = summary.positionIds[0] as string;
    const [pos] = await db.select().from(positions).where(eq(positions.id, posId));
    expect(pos!.side).toBe('short');
    expect(pos!.status).toBe('closed');

    const posFills = await db.select().from(fills).where(eq(fills.positionId, posId));
    expect(posFills.filter((f) => f.type === 'entry')).toHaveLength(1);
    expect(posFills.filter((f) => f.type === 'exit')).toHaveLength(1);
  });

  it('commits an interleaved scale-in/scale-out execution file', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    // Scale in (two buys), then scale out (two sells) → one closed long, 4 fills.
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      'AAPL,STOCK,BUY,100,10,2026-01-01,0',
      'AAPL,STOCK,BUY,102,10,2026-01-02,0',
      'AAPL,STOCK,SELL,110,5,2026-01-03,0',
      'AAPL,STOCK,SELL,112,15,2026-01-04,0',
    ].join('\n');
    const token = await stageToken(cookie, csv, execRequest(accountId));

    const res = await postCommit(cookie, token);
    expect(res.status).toBe(200);
    const summary = await res.json();
    expect(summary.positionsCreated).toBe(1);
    expect(summary.fillsCreated).toBe(4);

    const posId = summary.positionIds[0] as string;
    const [pos] = await db.select().from(positions).where(eq(positions.id, posId));
    expect(pos!.status).toBe('closed');
    const posFills = await db.select().from(fills).where(eq(fills.positionId, posId));
    expect(posFills).toHaveLength(4);
  });

  it('commits an entry-only residual segment to an OPEN (non-draft) position', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      'AAPL,STOCK,BUY,100,10,2026-01-01,0',
    ].join('\n');
    const res = await postPreview(cookie, csv, execRequest(accountId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.committable).toBe(true);
    expect(body.positions[0].closes).toBe(false);

    const commit = await postCommit(cookie, body.token);
    expect(commit.status).toBe(200);
    const summary = await commit.json();
    const posId = summary.positionIds[0] as string;
    const [pos] = await db.select().from(positions).where(eq(positions.id, posId));
    expect(pos!.status).toBe('open');
  });
});

// ===========================================================================
// Idempotency (sequential retry after success → original summary, REQ-8.6)
// ===========================================================================

describe('POST /api/csv-import/commit — idempotency (REQ-8.6)', () => {
  beforeAll(registerLedgerHook);
  afterAll(() => unregisterCloseHook('ledger'));

  it('a second commit of a committed token returns the original summary, no second import', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    const token = await stageToken(cookie, CLEAN_CSV, execRequest(accountId));

    const first = await postCommit(cookie, token);
    expect(first.status).toBe(200);
    const firstSummary = await first.json();

    const second = await postCommit(cookie, token);
    expect(second.status).toBe(200);
    const secondSummary = await second.json();
    expect(secondSummary).toEqual(firstSummary);

    // Exactly one position exists for this import — never two.
    const all = await db.select().from(positions).where(eq(positions.accountId, accountId));
    expect(all).toHaveLength(1);
  });
});

// ===========================================================================
// Non-blocking double-submit → loser 409 CSV_IMPORT_IN_PROGRESS (fast, MF-4)
// ===========================================================================

describe('POST /api/csv-import/commit — concurrency (REQ-8.2, MF-4)', () => {
  beforeAll(registerLedgerHook);
  afterAll(() => unregisterCloseHook('ledger'));

  it('a double-submit (in-flight commit) → 409 CSV_IMPORT_IN_PROGRESS, fast', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    const token = await stageToken(cookie, CLEAN_CSV, execRequest(accountId));

    // Single-connection test isolation serializes a literal in-process race, so
    // simulate the winner having durably claimed the row (status='committing',
    // claimed_at=now) — the loser's atomic claim then matches zero `staged` rows
    // and the route returns 409 in milliseconds (no lock-hold). This is the
    // faithful API-level equivalent of MF-4's non-blocking double-submit.
    await db
      .update(csvImportStaging)
      .set({ status: 'committing', claimedAt: new Date() })
      .where(eq(csvImportStaging.id, token));

    const started = Date.now();
    const res = await postCommit(cookie, token);
    const elapsed = Date.now() - started;
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CSV_IMPORT_IN_PROGRESS');
    expect(elapsed).toBeLessThan(5000); // fast — no blocking lock wait
  });
});

// ===========================================================================
// Phase-B atomicity — mid-replay failure → nothing persists, claim deleted
// ===========================================================================

describe('POST /api/csv-import/commit — Phase-B atomicity (REQ-8.4)', () => {
  // Install a throwing close hook for THIS suite so the close path fails inside
  // the bulk tx — a faithful mid-replay failure injection at the same call-site
  // the production ledger hook runs. Restore the real hook afterward.
  beforeAll(() => {
    replaceCloseHook('ledger', async () => {
      throw new Error('injected mid-replay close-hook failure');
    });
  });
  afterAll(() => {
    unregisterCloseHook('ledger');
    registerLedgerHook(); // restore the real ledger hook for any later file in this worker
  });

  it('rolls back ALL data and deletes the claimed row when Phase B fails mid-batch', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    // Two closing segments; the close-hook throws on the FIRST close → the whole
    // bulk tx (positions, fills, ledger) rolls back atomically.
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      'AAPL,STOCK,BUY,100,10,2026-01-01,0',
      'AAPL,STOCK,SELL,110,10,2026-01-02,0',
      'MSFT,STOCK,BUY,50,5,2026-01-03,0',
      'MSFT,STOCK,SELL,60,5,2026-01-04,0',
    ].join('\n');
    const token = await stageToken(cookie, csv, execRequest(accountId));

    const res = await postCommit(cookie, token);
    // The thrown hook surfaces as a 500 (no specific AppError), but the
    // atomicity guarantee is what matters: nothing persisted, claim deleted.
    expect(res.status).toBeGreaterThanOrEqual(500);

    // NOTHING persisted: no positions, no fills. (With zero positions there can
    // be no ledger entries either — the close hook that would have written them
    // is the very thing that threw and rolled the bulk tx back.)
    const pos = await db.select().from(positions).where(eq(positions.accountId, accountId));
    expect(pos).toHaveLength(0);
    // Scope the fills check to THIS import's account (join through positions).
    // A global `SELECT * FROM fills` filtered by price collides with pre-existing
    // committed residue at the same price in the shared test DB, so it flakes.
    // With the bulk tx rolled back, no fills reference this account's positions.
    const importFills = await db
      .select({ id: fills.id })
      .from(fills)
      .innerJoin(positions, eq(fills.positionId, positions.id))
      .where(eq(positions.accountId, accountId));
    expect(importFills).toHaveLength(0);

    // The claimed `committing` staging row was deleted (compensating delete) so
    // a retry must re-preview.
    const staged = await db.select().from(csvImportStaging).where(eq(csvImportStaging.id, token));
    expect(staged).toHaveLength(0);
  });
});

// ===========================================================================
// Orphaned-`committing` recovery + status-guarded finalize abort
// ===========================================================================

describe('POST /api/csv-import/commit — recovery (REQ-6.4)', () => {
  beforeAll(registerLedgerHook);
  afterAll(() => unregisterCloseHook('ledger'));

  it('orphaned-committing recovery: a stale Phase-A-then-crash row is deleted, re-preview succeeds', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    const token = await stageToken(cookie, CLEAN_CSV, execRequest(accountId));

    // Simulate Phase-A-then-crash: status='committing', committed_result NULL,
    // claimed_at older than the claim timeout → an orphan eligible for recovery.
    const stale = new Date(Date.now() - (config.CSV_IMPORT_CLAIM_TIMEOUT_SECONDS + 60) * 1000);
    await db
      .update(csvImportStaging)
      .set({ status: 'committing', committedResult: null, claimedAt: stale })
      .where(eq(csvImportStaging.id, token));

    // A re-preview lazily reaps the orphan, then stages a fresh row (the widened
    // one-active-per-user unique index would 409 if the orphan were NOT deleted
    // — so a clean 200 proves recovery deleted it).
    const re = await postPreview(cookie, CLEAN_CSV, execRequest(accountId));
    expect(re.status).toBe(200);
    const reBody = await re.json();
    expect(reBody.committable).toBe(true);
    expect(reBody.token).not.toBe(token);

    // The orphaned row is gone.
    const orphan = await db.select().from(csvImportStaging).where(eq(csvImportStaging.id, token));
    expect(orphan).toHaveLength(0);

    // The fresh preview commits cleanly.
    const commit = await postCommit(cookie, reBody.token);
    expect(commit.status).toBe(200);
  });

  it('status-guarded finalize aborts: a commit whose claim is recovery-deleted mid-flight writes nothing', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    const token = await stageToken(cookie, CLEAN_CSV, execRequest(accountId));

    // Drive the finalize-abort branch: install a close hook that, on the close,
    // DELETES the claimed `committing` row from inside the bulk tx (simulating a
    // concurrent recovery that removed the claim before finalize). The
    // status-guarded finalize (`AND status='committing'`) then matches zero rows
    // → the service raises CSV_IMPORT_IN_PROGRESS and rolls the whole tx back.
    replaceCloseHook('ledger', async (tx, ctx: CloseHookContext) => {
      await tx.delete(csvImportStaging).where(eq(csvImportStaging.id, token));
      // Still write the real ledger row so only the finalize-guard differs from
      // the happy path (it will roll back with everything else).
      void ctx;
    });
    try {
      const res = await postCommit(cookie, token);
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('CSV_IMPORT_IN_PROGRESS');
    } finally {
      unregisterCloseHook('ledger');
      registerLedgerHook();
    }

    // The whole bulk tx rolled back: no position persisted. (The staging row was
    // deleted by the injected hook AND by the compensating delete — either way
    // it is gone, and crucially no trade data was written.)
    const pos = await db.select().from(positions).where(eq(positions.accountId, accountId));
    expect(pos).toHaveLength(0);
  });
});

// ===========================================================================
// Refusals — superseded / expired / blocked / currency-changed
// ===========================================================================

describe('POST /api/csv-import/commit — refusals (REQ-8.5)', () => {
  beforeAll(registerLedgerHook);
  afterAll(() => unregisterCloseHook('ledger'));

  it('404s an unknown / unowned token', async () => {
    const cookie = await registerAndGetCookie();
    const res = await postCommit(cookie, '00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('409 CSV_IMPORT_SUPERSEDED when a newer preview replaced this one', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    const first = await stageToken(cookie, CLEAN_CSV, execRequest(accountId));
    // A second preview supersedes the first (one active staged per user).
    await stageToken(cookie, CLEAN_CSV, execRequest(accountId));

    const res = await postCommit(cookie, first);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CSV_IMPORT_SUPERSEDED');
  });

  it('409 CSV_IMPORT_EXPIRED when the preview TTL has elapsed', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    const token = await stageToken(cookie, CLEAN_CSV, execRequest(accountId));

    // Force the staged row past its TTL.
    await db
      .update(csvImportStaging)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(csvImportStaging.id, token));

    const res = await postCommit(cookie, token);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CSV_IMPORT_EXPIRED');
  });

  it('409 CSV_IMPORT_BLOCKED when the preview has blocking errors', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      'AAPL,STOCK,BUY,100,10,2026-01-01,0',
      'AAPL,STOCK,SELL,110,15,2026-01-02,0', // crossing flat → non-committable
    ].join('\n');
    const preview = await postPreview(cookie, csv, execRequest(accountId));
    expect(preview.status).toBe(200);
    const pbody = await preview.json();
    expect(pbody.committable).toBe(false);

    const res = await postCommit(cookie, pbody.token);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CSV_IMPORT_BLOCKED');
  });

  it('409 CSV_IMPORT_BLOCKED when the account no longer resolves for the user since preview', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    const token = await stageToken(cookie, CLEAN_CSV, execRequest(accountId));

    // The Phase-A re-check re-reads the account by id, scoped to this user; if it
    // no longer resolves the commit blocks (design Error Scenario 9, "account
    // changed since preview"). Re-assign the account to a different user — the
    // account row still exists (so the staging FK is intact, NOT cascade-deleted)
    // but `findAccountById(tx, accountId, userId)` returns empty for the original
    // user → 409 CSV_IMPORT_BLOCKED. This is the faithful re-check refusal: a hard
    // account delete would cascade-delete the staging row and surface as 404.
    const { accounts } = await import('@/db/schema');
    const [other] = await db
      .insert(users)
      .values({ email: uniqueEmail(), passwordHash: 'x'.repeat(60) })
      .returning();
    await db.update(accounts).set({ userId: other!.id }).where(eq(accounts.id, accountId));

    const res = await postCommit(cookie, token);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CSV_IMPORT_BLOCKED');
  });

  it('409 CSV_IMPORT_DUPLICATES_UNCONFIRMED, then succeeds with confirmDuplicates', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);

    // Commit a first identical import so a re-import overlaps ≥90% → affirmation.
    const firstToken = await stageToken(cookie, CLEAN_CSV, execRequest(accountId));
    const firstCommit = await postCommit(cookie, firstToken);
    expect(firstCommit.status).toBe(200);

    const dupPreview = await postPreview(cookie, CLEAN_CSV, execRequest(accountId));
    const dupBody = await dupPreview.json();
    expect(dupBody.requiresDuplicateAffirmation).toBe(true);

    const blocked = await postCommit(cookie, dupBody.token);
    expect(blocked.status).toBe(409);
    const blockedBody = await blocked.json();
    expect(blockedBody.error.code).toBe('CSV_IMPORT_DUPLICATES_UNCONFIRMED');

    const confirmed = await postCommit(cookie, dupBody.token, true);
    expect(confirmed.status).toBe(200);
  });
});

// ===========================================================================
// Plan-tiers tier enforcement (design C8/D9/D12; REQ-10, REQ-6.2): L6 lifetime
// allowance + L1 writability + L2 atomic batch refusal. Real PG; gating
// toggled via the mutable config (restored per test); per-test rollback
// isolation cleans counters / subscriptions / promotions. The headline
// contract under test: a Phase-A tier refusal leaves the staged import INTACT
// — the SAME token is committable after re-designation/upgrade, no re-upload.
// ===========================================================================

describe('POST /api/csv-import/commit — tier enforcement (plan-tiers L6/L1/L2)', () => {
  beforeAll(registerLedgerHook);
  afterAll(() => unregisterCloseHook('ledger'));

  const prevGating = config.FEATURE_GATING;
  afterEach(() => {
    config.FEATURE_GATING = prevGating;
  });

  const FREE_IMPORT_CAP = getTierLimits('free').csvImports!;

  async function getUserId(cookie: string): Promise<string> {
    const res = await app.request('/api/auth/me', {
      headers: { Cookie: `session=${cookie}`, 'X-Forwarded-For': uniqueIp() },
    });
    expect(res.status).toBe(200);
    const me = await res.json();
    return me.id as string;
  }

  async function getCommittedCount(userId: string): Promise<number> {
    const [row] = await db
      .select({ committedCount: csvImportCounters.committedCount })
      .from(csvImportCounters)
      .where(eq(csvImportCounters.userId, userId));
    return row?.committedCount ?? 0;
  }

  async function setCommittedCount(userId: string, count: number): Promise<void> {
    await db
      .insert(csvImportCounters)
      .values({ userId, committedCount: count })
      .onConflictDoUpdate({
        target: csvImportCounters.userId,
        set: { committedCount: count },
      });
  }

  /** Simulate an upgrade: a qualifying `active` mirror row makes the user Pro. */
  async function upgradeToPro(userId: string): Promise<void> {
    await db.insert(subscriptions).values({
      userId,
      stripeCustomerId: `cus_tier_${userId.slice(0, 8)}`,
      stripeSubscriptionId: `sub_tier_${userId}`,
      status: 'active',
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      stripeCreatedAt: new Date(),
      lastEventCreated: new Date(),
    });
  }

  /** Set the writable designation via the always-on D18 endpoint. */
  async function setWritable(cookie: string, accountId: string): Promise<void> {
    const res = await app.request('/api/accounts/writable', {
      method: 'PUT',
      headers: {
        Cookie: `session=${cookie}`,
        'Content-Type': 'application/json',
        'X-Forwarded-For': uniqueIp(),
      },
      body: JSON.stringify({ accountId }),
    });
    expect(res.status).toBe(200);
  }

  async function stagedStatus(token: string): Promise<string | undefined> {
    const [row] = await db
      .select({ status: csvImportStaging.status })
      .from(csvImportStaging)
      .where(eq(csvImportStaging.id, token));
    return row?.status;
  }

  // L6 counting (REQ-10.1/10.2): only successful commits consume the lifetime
  // allowance — previews, blocked commits, and expired staging never do.
  it('consumes L6 only on successful commit — previews, blocked and expired commits never count', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getUserId(cookie);
    const accountId = await createAccount(cookie);
    config.FEATURE_GATING = true;

    // A preview alone consumes nothing (no counter row yet).
    const token = await stageToken(cookie, CLEAN_CSV, execRequest(accountId));
    expect(await getCommittedCount(userId)).toBe(0);

    // A successful commit consumes exactly one.
    const committed = await postCommit(cookie, token);
    expect(committed.status).toBe(200);
    expect(await getCommittedCount(userId)).toBe(1);

    // A blocked (non-committable) preview's commit refusal consumes nothing.
    const blockedCsv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      'AAPL,STOCK,BUY,100,10,2026-01-01,0',
      'AAPL,STOCK,SELL,110,15,2026-01-02,0', // crossing flat → non-committable
    ].join('\n');
    const blockedPreview = await postPreview(cookie, blockedCsv, execRequest(accountId));
    expect(blockedPreview.status).toBe(200);
    const blockedBody = await blockedPreview.json();
    expect(blockedBody.committable).toBe(false);
    const blockedCommit = await postCommit(cookie, blockedBody.token);
    expect(blockedCommit.status).toBe(409);
    expect(await getCommittedCount(userId)).toBe(1);

    // An expired staging's commit refusal consumes nothing.
    const expiredToken = await stageToken(cookie, CLEAN_CSV, execRequest(accountId));
    await db
      .update(csvImportStaging)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(csvImportStaging.id, expiredToken));
    const expiredCommit = await postCommit(cookie, expiredToken);
    expect(expiredCommit.status).toBe(409);
    expect(await getCommittedCount(userId)).toBe(1);
  });

  // L6 refusal (REQ-10.1/10.3) + the C8 headline: staging survives the
  // refusal and the SAME token commits after upgrade — no re-upload.
  it('refuses at the L6 cap with 403 TIER_LIMIT_CSV_IMPORTS, leaves staging intact, and the SAME token commits after upgrade', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getUserId(cookie);
    const accountId = await createAccount(cookie);
    await setCommittedCount(userId, FREE_IMPORT_CAP);
    config.FEATURE_GATING = true;

    const token = await stageToken(cookie, CLEAN_CSV, execRequest(accountId));
    const refused = await postCommit(cookie, token);
    expect(refused.status).toBe(403);
    const refusedBody = await refused.json();
    expect(refusedBody.error.code).toBe('TIER_LIMIT_CSV_IMPORTS');
    expect(refused.headers.get('Retry-After')).toBeNull(); // terminal-for-state, never 429

    // The Phase-A refusal never claimed the row: the staged import is intact...
    expect(await stagedStatus(token)).toBe('staged');
    // ...and the refusal consumed nothing (REQ-10.4).
    expect(await getCommittedCount(userId)).toBe(FREE_IMPORT_CAP);

    // Upgrade (qualifying mirror row ⇒ pro, csvImports unlimited) → the SAME
    // token commits without re-uploading.
    await upgradeToPro(userId);
    const committed = await postCommit(cookie, token);
    expect(committed.status).toBe(200);
    // Counting is always-on (only the CHECK is gated): the commit still counts.
    expect(await getCommittedCount(userId)).toBe(FREE_IMPORT_CAP + 1);
  });

  // L2 batch (REQ-6.2 + REQ-10.4): atomic whole-batch refusal naming cap AND
  // batch size; never consumes L6; staging survives and commits after upgrade.
  it('refuses an over-cap batch atomically with 403 TIER_LIMIT_POSITIONS naming cap and batch size, without consuming L6', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getUserId(cookie);
    const accountId = await createAccount(cookie);

    // Seed cap−1 existing positions in one bulk insert; the staged batch of 2
    // then overflows the cap by exactly one.
    const cap = getTierLimits('free').positions!;
    const rows = Array.from({ length: cap - 1 }, (_, i) => ({
      userId,
      accountId,
      symbol: `SEED${i}`,
      side: 'long',
      assetType: 'equity',
      status: 'open',
    }));
    // performance-charts §8.2 audit: status='open' is CHECK-safe.
    // eslint-disable-next-line no-restricted-syntax
    await db.insert(positions).values(rows);

    const twoPositionCsv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      'AAPL,STOCK,BUY,100,10,2026-01-01,0',
      'AAPL,STOCK,SELL,110,10,2026-01-02,0',
      'MSFT,STOCK,BUY,50,5,2026-01-03,0',
      'MSFT,STOCK,SELL,60,5,2026-01-04,0',
    ].join('\n');
    const token = await stageToken(cookie, twoPositionCsv, execRequest(accountId));

    config.FEATURE_GATING = true;
    const refused = await postCommit(cookie, token);
    expect(refused.status).toBe(403);
    const body = await refused.json();
    expect(body.error.code).toBe('TIER_LIMIT_POSITIONS');
    // The message states the cap AND the batch size (REQ-6.2).
    expect(body.error.message).toContain(String(cap));
    expect(body.error.message).toContain('2 positions');

    // Atomic whole-batch refusal: NO partial import.
    const userPositions = await db
      .select({ id: positions.id })
      .from(positions)
      .where(eq(positions.userId, userId));
    expect(userPositions).toHaveLength(cap - 1);
    // A positions-cap-refused commit never consumes the L6 allowance
    // (REQ-10.4)...
    expect(await getCommittedCount(userId)).toBe(0);
    // ...and leaves the staged import intact.
    expect(await stagedStatus(token)).toBe('staged');

    // Upgrade → the SAME token commits whole, no re-upload.
    await upgradeToPro(userId);
    const committed = await postCommit(cookie, token);
    expect(committed.status).toBe(200);
    const summary = await committed.json();
    expect(summary.positionsCreated).toBe(2);
    expect(await getCommittedCount(userId)).toBe(1);
  });

  // L1 writability (D18): over-cap, only the designated account accepts the
  // import — and a re-designation makes the SAME token committable.
  it('refuses a commit into a non-writable account with 403 TIER_ACCOUNT_NOT_WRITABLE and honors re-designation on the SAME token', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getUserId(cookie);
    // Both accounts created while gating is off (the over-cap state).
    config.FEATURE_GATING = false;
    const accountA = await createAccount(cookie);
    const accountB = await createAccount(cookie, 'USD', 'Second Account');
    // Pin the effective designation to A explicitly (always-on endpoint) —
    // no reliance on the deterministic-default timestamp ordering.
    await setWritable(cookie, accountA);

    const token = await stageToken(cookie, CLEAN_CSV, execRequest(accountB));
    config.FEATURE_GATING = true;

    const refused = await postCommit(cookie, token);
    expect(refused.status).toBe(403);
    const body = await refused.json();
    expect(body.error.code).toBe('TIER_ACCOUNT_NOT_WRITABLE');
    expect(await stagedStatus(token)).toBe('staged');
    expect(await getCommittedCount(userId)).toBe(0);

    // Re-designate B as writable → the SAME token commits, no re-upload.
    await setWritable(cookie, accountB);
    const committed = await postCommit(cookie, token);
    expect(committed.status).toBe(200);
    const summary = await committed.json();
    expect(summary.accountId).toBe(accountB);
    expect(await getCommittedCount(userId)).toBe(1);
  });

  // REQ-10.5 / REQ-6.7: admin pass-through (counting stays always-on).
  it('admin passes through the L6 cap unchanged (and the commit still counts)', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getUserId(cookie);
    const accountId = await createAccount(cookie);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, userId));
    await setCommittedCount(userId, FREE_IMPORT_CAP);
    config.FEATURE_GATING = true;

    const token = await stageToken(cookie, CLEAN_CSV, execRequest(accountId));
    const res = await postCommit(cookie, token);
    expect(res.status).toBe(200);
    // Counting is always-on; only enforcement is gated.
    expect(await getCommittedCount(userId)).toBe(FREE_IMPORT_CAP + 1);
  });

  // REQ-10.5 / REQ-6.7: gating-off pass-through (self-host parity).
  it('gating off passes through the L6 cap unchanged', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getUserId(cookie);
    const accountId = await createAccount(cookie);
    await setCommittedCount(userId, FREE_IMPORT_CAP);
    config.FEATURE_GATING = false;

    const token = await stageToken(cookie, CLEAN_CSV, execRequest(accountId));
    const res = await postCommit(cookie, token);
    expect(res.status).toBe(200);
    expect(await getCommittedCount(userId)).toBe(FREE_IMPORT_CAP + 1);
  });

  // The idempotent short-circuit precedes the checks (C8): a re-commit of a
  // committed token neither re-checks the caps nor re-increments the counter.
  it('idempotent re-commit of a committed token neither re-checks nor re-increments', async () => {
    const cookie = await registerAndGetCookie();
    const userId = await getUserId(cookie);
    const accountId = await createAccount(cookie);
    config.FEATURE_GATING = true;

    const token = await stageToken(cookie, CLEAN_CSV, execRequest(accountId));
    const first = await postCommit(cookie, token);
    expect(first.status).toBe(200);
    const firstSummary = await first.json();
    expect(await getCommittedCount(userId)).toBe(1);

    // Put the user AT the cap: a re-check would now 403 — the idempotent
    // short-circuit must return the original summary instead, un-counted.
    await setCommittedCount(userId, FREE_IMPORT_CAP);
    const second = await postCommit(cookie, token);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstSummary);
    expect(await getCommittedCount(userId)).toBe(FREE_IMPORT_CAP);
  });
});

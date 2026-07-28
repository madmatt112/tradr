import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';

import app from '@/app';
import { db } from '@/db';
import { fills, ledgerEntries, positions } from '@/db/schema';
import { insertPositionCloseLedgerEntries } from '@/features/accounting/ledger-hook';
import {
  type CloseHookContext,
  replaceCloseHook,
  unregisterCloseHook,
} from '@/features/positions/positions.service';

// ---------------------------------------------------------------------------
// Cross-feature callback rollback matrix (design Testing Strategy → REQ-8.8;
// decomposition Cross-Feature Callback Rollback Testing). Proves the import
// correctly inherits and rolls back the globally-registered `ledger` close-hook
// within the bulk transaction:
//   (a) hook success → exactly ONE `position_pnl` ledger entry per closed
//       imported position;
//   (b) Phase-B failure AFTER some closes → no orphaned ledger entries;
//   (c) hook failure → the whole import rolls back (no positions, fills, or
//       ledger entries persist).
//
// Drives the REAL registered close-hook (`insertPositionCloseLedgerEntries`) —
// the ledger insert is never stubbed. Real Postgres, per-test
// transaction-rollback isolation (test-setup.ts). Harness mirrors Task 17's
// commit test exactly: register → session cookie → account → multipart preview
// → JSON commit.
// ---------------------------------------------------------------------------

// Register the live ledger close-hook directly (NOT the full async `bootstrap()`,
// which also runs migrations / decrypt-canary against `db` — undefined at
// `beforeAll` time before the per-test transaction is installed).
// `replaceCloseHook` is idempotent, so re-registering across suites is safe.
function registerLedgerHook() {
  replaceCloseHook('ledger', insertPositionCloseLedgerEntries);
}

let testCounter = 0;
function uniqueEmail() {
  return `csv-ledger-${Date.now()}-${++testCounter}@example.com`;
}

let ipCounter = 0;
function uniqueIp() {
  return `10.78.${Math.floor(++ipCounter / 256)}.${ipCounter % 256}`;
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

async function createAccount(cookie: string, currency = 'USD'): Promise<string> {
  const res = await app.request('/api/accounts', {
    method: 'POST',
    headers: {
      Cookie: `session=${cookie}`,
      'Content-Type': 'application/json',
      'X-Forwarded-For': uniqueIp(),
    },
    body: JSON.stringify({ name: 'Import Account', currency }),
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
async function postCommit(cookie: string, token: string): Promise<Response> {
  return app.request('/api/csv-import/commit', {
    method: 'POST',
    headers: {
      Cookie: `session=${cookie}`,
      'Content-Type': 'application/json',
      'X-Forwarded-For': uniqueIp(),
    },
    body: JSON.stringify({ token }),
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

/** Two independent symbols, each opened and fully closed → two closed positions. */
const TWO_CLOSES_CSV = [
  'Symbol,Type,Side,Price,Quantity,Date,Fees',
  'AAPL,STOCK,BUY,100,10,2026-01-01,0',
  'AAPL,STOCK,SELL,110,10,2026-01-02,0',
  'MSFT,STOCK,BUY,50,5,2026-01-03,0',
  'MSFT,STOCK,SELL,60,5,2026-01-04,0',
].join('\n');

// ===========================================================================
// (a) Hook success → exactly one position_pnl ledger entry per closed position
// ===========================================================================

describe('csv-import ledger rollback matrix — (a) hook success (REQ-8.8)', () => {
  beforeAll(registerLedgerHook);
  afterAll(() => unregisterCloseHook('ledger'));

  it('writes exactly one position_pnl ledger entry per closed imported position', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    const token = await stageToken(cookie, TWO_CLOSES_CSV, execRequest(accountId));

    const res = await postCommit(cookie, token);
    expect(res.status).toBe(200);
    const summary = await res.json();
    expect(summary.positionsCreated).toBe(2);
    expect(summary.positionIds).toHaveLength(2);

    // Both imported positions are closed.
    const posIds = summary.positionIds as string[];
    for (const posId of posIds) {
      const [pos] = await db.select().from(positions).where(eq(positions.id, posId));
      expect(pos!.status).toBe('closed');

      // Exactly one position_pnl ledger entry for this closed position.
      const ledger = await db
        .select()
        .from(ledgerEntries)
        .where(
          and(eq(ledgerEntries.positionId, posId), eq(ledgerEntries.entryType, 'position_pnl')),
        );
      expect(ledger).toHaveLength(1);
    }

    // No stray ledger entries beyond the one-per-closed-position.
    const allForAccount = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.accountId, accountId));
    expect(allForAccount).toHaveLength(2);
  });
});

// ===========================================================================
// (b) Phase-B failure AFTER some closes → no orphaned ledger entries
// ===========================================================================

describe('csv-import ledger rollback matrix — (b) Phase-B failure after some closes (REQ-8.8)', () => {
  // The REAL ledger hook runs for the FIRST close (writing a real ledger row),
  // then a Phase-B failure is injected on the SECOND close at the same close-hook
  // call-site. The whole bulk tx must roll back, leaving NO orphaned ledger entry
  // from the first (already-succeeded) close.
  let closeCount = 0;
  beforeAll(() => {
    closeCount = 0;
    replaceCloseHook('ledger', async (tx, ctx: CloseHookContext) => {
      closeCount += 1;
      if (closeCount >= 2) {
        throw new Error('injected Phase-B failure after first close');
      }
      // First close: drive the REAL ledger insert (do not stub it).
      await insertPositionCloseLedgerEntries(tx, ctx);
    });
  });
  afterAll(() => {
    unregisterCloseHook('ledger');
    registerLedgerHook(); // restore the real hook for later files in this worker
  });

  it('rolls back the first close’s ledger entry — no orphaned ledger rows persist', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    const token = await stageToken(cookie, TWO_CLOSES_CSV, execRequest(accountId));

    const res = await postCommit(cookie, token);
    // The thrown hook surfaces as a 500; the atomicity guarantee is what matters.
    expect(res.status).toBeGreaterThanOrEqual(500);

    // Two closes were imported; the hook fired on both (the first succeeded and
    // wrote a real ledger row, the second threw) — so this exercises a genuine
    // "failure after some closes" rather than a fail-on-first.
    expect(closeCount).toBe(2);

    // Nothing persisted: no positions, no fills.
    const pos = await db.select().from(positions).where(eq(positions.accountId, accountId));
    expect(pos).toHaveLength(0);
    const accFills = await db
      .select({ id: fills.id })
      .from(fills)
      .innerJoin(positions, eq(fills.positionId, positions.id))
      .where(eq(positions.accountId, accountId));
    expect(accFills).toHaveLength(0);

    // Crucially: NO orphaned ledger entries — the first close’s real ledger row
    // rolled back with the bulk tx.
    const ledger = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.accountId, accountId));
    expect(ledger).toHaveLength(0);
  });
});

// ===========================================================================
// (c) Hook failure → the whole import rolls back (no positions/fills/ledger)
// ===========================================================================

describe('csv-import ledger rollback matrix — (c) hook failure rolls back the import (REQ-8.8)', () => {
  // Throw on the VERY FIRST close at the production close-hook call-site. The
  // entire import must roll back — no positions, fills, or ledger entries.
  beforeAll(() => {
    replaceCloseHook('ledger', async () => {
      throw new Error('injected close-hook failure');
    });
  });
  afterAll(() => {
    unregisterCloseHook('ledger');
    registerLedgerHook(); // restore the real hook for later files in this worker
  });

  it('persists no positions, fills, or ledger entries when the close-hook throws', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    const token = await stageToken(cookie, TWO_CLOSES_CSV, execRequest(accountId));

    const res = await postCommit(cookie, token);
    expect(res.status).toBeGreaterThanOrEqual(500);

    const pos = await db.select().from(positions).where(eq(positions.accountId, accountId));
    expect(pos).toHaveLength(0);

    const accFills = await db
      .select({ id: fills.id })
      .from(fills)
      .innerJoin(positions, eq(fills.positionId, positions.id))
      .where(eq(positions.accountId, accountId));
    expect(accFills).toHaveLength(0);

    const ledger = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.accountId, accountId));
    expect(ledger).toHaveLength(0);
  });
});

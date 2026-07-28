import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';

import type { CsvPreviewRequest } from '@tradr/shared';

import { bootstrap } from '@/app';
import { db } from '@/db';
import { accounts, fills, ledgerEntries, positions, users } from '@/db/schema';
import { csvImportStaging } from '@/db/schema/csv-import.schema';
import {
  createPosition,
  openPosition,
  unregisterCloseHook,
} from '@/features/positions/positions.service';

import { commitImport, neutralizeCsvCell, previewImport } from './csv-import.service';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let counter = 0;
function uniqueEmail() {
  return `csv-svc-${Date.now()}-${++counter}@example.com`;
}

async function seedAccount(currency = 'USD') {
  const [user] = await db
    .insert(users)
    .values({ email: uniqueEmail(), passwordHash: 'x'.repeat(60) })
    .returning();
  const [account] = await db
    .insert(accounts)
    .values({ userId: user!.id, name: 'Test Account', currency })
    .returning();
  return { userId: user!.id, accountId: account!.id };
}

function bytes(csv: string): Uint8Array {
  return new TextEncoder().encode(csv);
}

/** A minimal execution-shape mapping using `action`. */
function execRequest(
  accountId: string,
  overrides: Partial<CsvPreviewRequest> = {},
): CsvPreviewRequest {
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
    ...overrides,
  };
}

const CLEAN_CSV = [
  'Symbol,Type,Side,Price,Quantity,Date,Fees',
  'AAPL,STOCK,BUY,100,10,2026-01-01,1',
  'AAPL,STOCK,SELL,110,10,2026-01-02,1',
].join('\n');

// ---------------------------------------------------------------------------
// Happy path + staging
// ---------------------------------------------------------------------------

describe('previewImport — staging + classification', () => {
  it('stages exactly one row, mints a token, and reports a committable clean preview', async () => {
    const { userId, accountId } = await seedAccount();
    const res = await previewImport(
      db,
      userId,
      accountId,
      bytes(CLEAN_CSV),
      execRequest(accountId),
    );

    expect(res.committable).toBe(true);
    expect(res.errors).toHaveLength(0);
    expect(res.summary.positions).toBe(1);
    expect(res.summary.fills).toBe(2);
    expect(res.positions[0].closes).toBe(true);
    expect(res.positions[0].proposedPnl).toBeCloseTo(98, 2); // (110-100)*10 - 2 fees

    const staged = await db
      .select()
      .from(csvImportStaging)
      .where(eq(csvImportStaging.userId, userId));
    expect(staged).toHaveLength(1);
    expect(staged[0].id).toBe(res.token);
    expect(staged[0].status).toBe('staged');
  });

  it('marks blocking errors non-committable (crossing flat)', async () => {
    const { userId, accountId } = await seedAccount();
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      'AAPL,STOCK,BUY,100,10,2026-01-01,0',
      'AAPL,STOCK,SELL,110,15,2026-01-02,0', // exit exceeds open → crossing flat
    ].join('\n');
    const res = await previewImport(db, userId, accountId, bytes(csv), execRequest(accountId));
    expect(res.committable).toBe(false);
    expect(res.errors.some((e) => e.code === 'SEGMENT_CROSSES_FLAT')).toBe(true);
  });

  it('supersedes the prior staged row on a new preview (one active per user)', async () => {
    const { userId, accountId } = await seedAccount();
    await previewImport(db, userId, accountId, bytes(CLEAN_CSV), execRequest(accountId));
    const res2 = await previewImport(
      db,
      userId,
      accountId,
      bytes(CLEAN_CSV),
      execRequest(accountId),
    );

    const rows = await db
      .select()
      .from(csvImportStaging)
      .where(eq(csvImportStaging.userId, userId));
    const staged = rows.filter((r) => r.status === 'staged');
    const superseded = rows.filter((r) => r.status === 'superseded');
    expect(staged).toHaveLength(1);
    expect(staged[0].id).toBe(res2.token);
    expect(superseded).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Options rejection (REQ-5.2)
// ---------------------------------------------------------------------------

describe('previewImport — options rejection', () => {
  it('rejects option rows with a blocking error per row', async () => {
    const { userId, accountId } = await seedAccount();
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      'AAPL,OPTION,BUY,1,1,2026-01-01,0',
      'AAPL,OPTION,SELL,2,1,2026-01-02,0',
    ].join('\n');
    const res = await previewImport(db, userId, accountId, bytes(csv), execRequest(accountId));
    expect(res.committable).toBe(false);
    const optErrors = res.errors.filter((e) => e.code === 'OPTIONS_NOT_SUPPORTED');
    expect(optErrors.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Error-cap truncation (REQ-11.4)
// ---------------------------------------------------------------------------

describe('previewImport — error cap', () => {
  it('caps the error list at 1000 with a +N more sentinel', async () => {
    const { userId, accountId } = await seedAccount();
    // 1200 rows each with an unparseable price → 1200 field errors.
    const lines = ['Symbol,Type,Side,Price,Quantity,Date,Fees'];
    for (let i = 0; i < 1200; i++) {
      lines.push(`AAPL,STOCK,BUY,notanumber,10,2026-01-01,0`);
    }
    const res = await previewImport(
      db,
      userId,
      accountId,
      bytes(lines.join('\n')),
      execRequest(accountId),
    );
    expect(res.errors).toHaveLength(1001); // 1000 + the truncation sentinel
    expect(res.errors[1000].code).toBe('TRUNCATED');
    expect(res.committable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// no_fees_column + currency_hint_mismatch warnings
// ---------------------------------------------------------------------------

describe('previewImport — warnings', () => {
  it('emits no_fees_column when no fees column is mapped', async () => {
    const { userId, accountId } = await seedAccount();
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date',
      'AAPL,STOCK,BUY,100,10,2026-01-01',
      'AAPL,STOCK,SELL,110,10,2026-01-02',
    ].join('\n');
    const req = execRequest(accountId, {
      mapping: {
        rowShape: 'execution',
        columns: {
          symbol: 'Symbol',
          assetType: 'Type',
          action: 'Side',
          price: 'Price',
          quantity: 'Quantity',
          filledAt: 'Date',
        },
      },
    });
    const res = await previewImport(db, userId, accountId, bytes(csv), req);
    expect(res.warnings.some((w) => w.kind === 'no_fees_column')).toBe(true);
  });

  it('emits currency_hint_mismatch when the CSV currency differs from the account', async () => {
    const { userId, accountId } = await seedAccount('USD');
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees,Currency',
      'AAPL,STOCK,BUY,100,10,2026-01-01,0,EUR',
      'AAPL,STOCK,SELL,110,10,2026-01-02,0,EUR',
    ].join('\n');
    const res = await previewImport(db, userId, accountId, bytes(csv), execRequest(accountId));
    expect(res.warnings.some((w) => w.kind === 'currency_hint_mismatch')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Duplicate classification (REQ-9.1)
// ---------------------------------------------------------------------------

describe('previewImport — duplicates', () => {
  it('blocks with requiresDuplicateAffirmation when overlap ≥ 0.90', async () => {
    const { userId, accountId } = await seedAccount();
    // Seed an existing position whose fills exactly match the incoming file.
    const position = await createPosition(
      db,
      userId,
      { accountId, symbol: 'AAPL', side: 'long', assetType: 'stock' },
      { isAdmin: false },
    );
    await db.insert(fills).values([
      {
        positionId: position!.id,
        type: 'entry',
        price: '100',
        quantity: '10',
        fees: '1',
        filledAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        positionId: position!.id,
        type: 'exit',
        price: '110',
        quantity: '10',
        fees: '1',
        filledAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ]);
    await openPosition(db, position!.id, userId, '2026-01-01T00:00:00.000Z');

    const res = await previewImport(
      db,
      userId,
      accountId,
      bytes(CLEAN_CSV),
      execRequest(accountId),
    );
    expect(res.requiresDuplicateAffirmation).toBe(true);
    expect(res.committable).toBe(true); // duplicates are an affirmation gate, not a hard block
  });

  it('warns per-fill on a within-file duplicate', async () => {
    const { userId, accountId } = await seedAccount();
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      'AAPL,STOCK,BUY,100,10,2026-01-01,0',
      'AAPL,STOCK,SELL,110,10,2026-01-02,0',
      'MSFT,STOCK,BUY,50,5,2026-01-03,0',
      'MSFT,STOCK,BUY,50,5,2026-01-03,0', // identical within-file
      'MSFT,STOCK,SELL,60,10,2026-01-04,0',
    ].join('\n');
    const res = await previewImport(db, userId, accountId, bytes(csv), execRequest(accountId));
    expect(res.warnings.some((w) => w.kind === 'within_file_duplicate')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// neutralizeCsvCell (design Security)
// ---------------------------------------------------------------------------

describe('neutralizeCsvCell', () => {
  it('prefixes a quote for formula-injection leading characters', () => {
    expect(neutralizeCsvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(neutralizeCsvCell('+1')).toBe("'+1");
    expect(neutralizeCsvCell('-1')).toBe("'-1");
    expect(neutralizeCsvCell('@cmd')).toBe("'@cmd");
    expect(neutralizeCsvCell('\tTAB')).toBe("'\tTAB");
    expect(neutralizeCsvCell('\rCR')).toBe("'\rCR");
  });

  it('leaves benign values untouched', () => {
    expect(neutralizeCsvCell('AAPL')).toBe('AAPL');
    expect(neutralizeCsvCell('100.50')).toBe('100.50');
    expect(neutralizeCsvCell('')).toBe('');
  });

  it('neutralizes a malicious symbol where it enters the response payload', async () => {
    const { userId, accountId } = await seedAccount();
    // A symbol starting with '=' (≤20 chars, uppercased by the schema is moot
    // here — the value enters the payload via the segment scope).
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      '=CMD,STOCK,BUY,100,10,2026-01-01,0',
      '=CMD,STOCK,SELL,110,10,2026-01-02,0',
    ].join('\n');
    const res = await previewImport(db, userId, accountId, bytes(csv), execRequest(accountId));
    expect(res.positions[0].scope.symbol.startsWith("'=")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// commitImport — two-phase commit (design Component 7 / 7a)
// ---------------------------------------------------------------------------

describe('commitImport — replay + lifecycle (Component 7/7a)', () => {
  // Register the live ledger close-hook so the close path fires it inside the
  // bulk tx (the close-hook-inside-bulk-tx contract).
  beforeAll(() => {
    // .catch swallows the async advisor-startup tail's rejection: in tests
    // `@/db` is mocked to `undefined` outside the per-test tx window, so the
    // fire-and-forget decrypt-canary would otherwise leak an unhandled
    // rejection and fail `pnpm test`. The synchronous prelude (ledger hook) —
    // all this block needs — has already run by the time .catch attaches.
    bootstrap().catch(() => {});
  });
  afterAll(() => {
    unregisterCloseHook('ledger');
  });

  it('commits a long round-trip: position closed, two fills, ledger entries written', async () => {
    const { userId, accountId } = await seedAccount();
    const preview = await previewImport(
      db,
      userId,
      accountId,
      bytes(CLEAN_CSV),
      execRequest(accountId),
    );
    expect(preview.committable).toBe(true);

    const summary = await commitImport(db, userId, preview.token, false, { isAdmin: false });
    expect(summary.positionsCreated).toBe(1);
    expect(summary.fillsCreated).toBe(2);
    expect(summary.accountId).toBe(accountId);
    expect(summary.positionIds).toHaveLength(1);

    const [pos] = await db
      .select()
      .from(positions)
      .where(eq(positions.id, summary.positionIds[0]!));
    expect(pos!.status).toBe('closed');
    expect(pos!.side).toBe('long');

    const posFills = await db
      .select()
      .from(fills)
      .where(eq(fills.positionId, summary.positionIds[0]!));
    expect(posFills).toHaveLength(2);
    expect(posFills.filter((f) => f.type === 'entry')).toHaveLength(1);
    expect(posFills.filter((f) => f.type === 'exit')).toHaveLength(1);

    const ledger = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.positionId, summary.positionIds[0]!));
    expect(ledger.length).toBeGreaterThan(0);

    const staged = await db
      .select()
      .from(csvImportStaging)
      .where(eq(csvImportStaging.id, preview.token));
    expect(staged[0]!.status).toBe('committed');
  });

  it('commits a short round-trip: opening SELL = entry, covering BUY = exit (REQ-4.8)', async () => {
    const { userId, accountId } = await seedAccount();
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      'AAPL,STOCK,SELL,110,10,2026-01-01,1', // open short
      'AAPL,STOCK,BUY,100,10,2026-01-02,1', // cover
    ].join('\n');
    const preview = await previewImport(db, userId, accountId, bytes(csv), execRequest(accountId));
    expect(preview.committable).toBe(true);
    expect(preview.positions[0].side).toBe('short');

    const summary = await commitImport(db, userId, preview.token, false, { isAdmin: false });
    const [pos] = await db
      .select()
      .from(positions)
      .where(eq(positions.id, summary.positionIds[0]!));
    expect(pos!.side).toBe('short');
    expect(pos!.status).toBe('closed');

    const posFills = await db
      .select()
      .from(fills)
      .where(eq(fills.positionId, summary.positionIds[0]!));
    expect(posFills.filter((f) => f.type === 'entry')).toHaveLength(1); // the SELL
    expect(posFills.filter((f) => f.type === 'exit')).toHaveLength(1); // the BUY
  });

  it('commits an entry-only residual segment to an open (non-draft) position', async () => {
    const { userId, accountId } = await seedAccount();
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      'AAPL,STOCK,BUY,100,10,2026-01-01,0',
    ].join('\n');
    const preview = await previewImport(db, userId, accountId, bytes(csv), execRequest(accountId));
    expect(preview.positions[0].closes).toBe(false);

    const summary = await commitImport(db, userId, preview.token, false, { isAdmin: false });
    const [pos] = await db
      .select()
      .from(positions)
      .where(eq(positions.id, summary.positionIds[0]!));
    expect(pos!.status).toBe('open');
  });

  it('is idempotent: a second commit returns the original summary, no second import', async () => {
    const { userId, accountId } = await seedAccount();
    const preview = await previewImport(
      db,
      userId,
      accountId,
      bytes(CLEAN_CSV),
      execRequest(accountId),
    );

    const first = await commitImport(db, userId, preview.token, false, { isAdmin: false });
    const second = await commitImport(db, userId, preview.token, false, { isAdmin: false });
    expect(second).toEqual(first);

    const posCount = await db.select().from(positions).where(eq(positions.userId, userId));
    expect(posCount).toHaveLength(1); // not two
  });
});

describe('commitImport — refusals & recovery (Component 7/8)', () => {
  beforeAll(() => {
    // .catch swallows the async advisor-startup tail's rejection: in tests
    // `@/db` is mocked to `undefined` outside the per-test tx window, so the
    // fire-and-forget decrypt-canary would otherwise leak an unhandled
    // rejection and fail `pnpm test`. The synchronous prelude (ledger hook) —
    // all this block needs — has already run by the time .catch attaches.
    bootstrap().catch(() => {});
  });
  afterAll(() => {
    unregisterCloseHook('ledger');
  });

  it('404s an unknown token', async () => {
    const { userId } = await seedAccount();
    await expect(
      commitImport(db, userId, '00000000-0000-0000-0000-000000000000', false, { isAdmin: false }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('409 CSV_IMPORT_SUPERSEDED when the preview was replaced', async () => {
    const { userId, accountId } = await seedAccount();
    const first = await previewImport(
      db,
      userId,
      accountId,
      bytes(CLEAN_CSV),
      execRequest(accountId),
    );
    await previewImport(db, userId, accountId, bytes(CLEAN_CSV), execRequest(accountId)); // supersedes

    await expect(
      commitImport(db, userId, first.token, false, { isAdmin: false }),
    ).rejects.toMatchObject({
      code: 'CSV_IMPORT_SUPERSEDED',
    });
  });

  it('409 CSV_IMPORT_BLOCKED when the preview has blocking errors', async () => {
    const { userId, accountId } = await seedAccount();
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      'AAPL,STOCK,BUY,100,10,2026-01-01,0',
      'AAPL,STOCK,SELL,110,15,2026-01-02,0', // crossing flat → non-committable
    ].join('\n');
    const preview = await previewImport(db, userId, accountId, bytes(csv), execRequest(accountId));
    expect(preview.committable).toBe(false);

    await expect(
      commitImport(db, userId, preview.token, false, { isAdmin: false }),
    ).rejects.toMatchObject({
      code: 'CSV_IMPORT_BLOCKED',
    });
  });

  it('409 CSV_IMPORT_DUPLICATES_UNCONFIRMED unless confirmDuplicates is set', async () => {
    const { userId, accountId } = await seedAccount();
    // Seed an exact-match existing position so overlap ≥ 0.90.
    const position = await createPosition(
      db,
      userId,
      { accountId, symbol: 'AAPL', side: 'long', assetType: 'stock' },
      { isAdmin: false },
    );
    await db.insert(fills).values([
      {
        positionId: position!.id,
        type: 'entry',
        price: '100',
        quantity: '10',
        fees: '1',
        filledAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        positionId: position!.id,
        type: 'exit',
        price: '110',
        quantity: '10',
        fees: '1',
        filledAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ]);
    await openPosition(db, position!.id, userId, '2026-01-01T00:00:00.000Z');

    const preview = await previewImport(
      db,
      userId,
      accountId,
      bytes(CLEAN_CSV),
      execRequest(accountId),
    );
    expect(preview.requiresDuplicateAffirmation).toBe(true);

    await expect(
      commitImport(db, userId, preview.token, false, { isAdmin: false }),
    ).rejects.toMatchObject({
      code: 'CSV_IMPORT_DUPLICATES_UNCONFIRMED',
    });

    // With confirmDuplicates it proceeds.
    const summary = await commitImport(db, userId, preview.token, true, { isAdmin: false });
    expect(summary.positionsCreated).toBe(1);
  });

  it('409 CSV_IMPORT_IN_PROGRESS when the row is already committing', async () => {
    const { userId, accountId } = await seedAccount();
    const preview = await previewImport(
      db,
      userId,
      accountId,
      bytes(CLEAN_CSV),
      execRequest(accountId),
    );
    // Simulate an in-flight Phase B by forcing the row to `committing`.
    await db
      .update(csvImportStaging)
      .set({ status: 'committing', claimedAt: new Date() })
      .where(eq(csvImportStaging.id, preview.token));

    await expect(
      commitImport(db, userId, preview.token, false, { isAdmin: false }),
    ).rejects.toMatchObject({
      code: 'CSV_IMPORT_IN_PROGRESS',
    });
  });
});

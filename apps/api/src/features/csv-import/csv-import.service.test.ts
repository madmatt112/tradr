import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';

import { encodeOccCompact, type CsvPreviewRequest, type LocatedError } from '@tradr/shared';
import { readCsvImportSample } from '@tradr/shared/node/csv-import-samples';

import { bootstrap } from '@/app';
import { db } from '@/db';
import { accounts, fills, ledgerEntries, positions, users } from '@/db/schema';
import { csvImportStaging } from '@/db/schema/csv-import.schema';
import { settleLeg } from '@/features/positions/option-settlement.service';
import {
  createPosition,
  openPosition,
  unregisterCloseHook,
} from '@/features/positions/positions.service';

import { commitImport, neutralizeCsvCell, previewImport } from './csv-import.service';

// ---------------------------------------------------------------------------
// Task 19 lifecycle-event fixtures — `ProposedEventSchema`/`nonBlocking` are
// not yet on the shared types (this task adds them), so previewImport's
// response is read through a local, forward-compatible shape rather than
// `as any`.
// ---------------------------------------------------------------------------

interface ExtendedLocatedError extends LocatedError {
  nonBlocking?: boolean;
}

interface ProposedEventTarget {
  kind: 'segment' | 'open_leg';
  segmentRef?: number;
  positionId?: string;
}

interface ProposedEventLike {
  rowNumber: number;
  outcome: 'assigned' | 'exercised';
  symbol: string;
  quantity: string;
  target?: ProposedEventTarget;
}

interface ExtendedPreviewResponse {
  errors: ExtendedLocatedError[];
  warnings: Array<{ rowNumber?: number; kind: string; message: string }>;
  positions: Array<{ scope: { symbol: string; assetType: string } }>;
  committable: boolean;
  events?: ProposedEventLike[];
}

function occ(underlying: string, expiration: string, type: 'call' | 'put', strike: string): string {
  const result = encodeOccCompact({ underlying, expiration, type, strike });
  if (!result.ok) {
    throw new Error(`fixture OCC symbol invalid: ${result.error.message}`);
  }
  return result.value;
}

/** A Trades-shaped execution mapping with an eventCode column (task 19). */
function lifecycleRequest(
  accountId: string,
  overrides: Partial<CsvPreviewRequest> = {},
): CsvPreviewRequest {
  return {
    accountId,
    rowShape: 'execution',
    mapping: {
      rowShape: 'execution',
      contractForm: 'occ-symbol',
      columns: {
        symbol: 'Symbol',
        assetType: 'AssetClass',
        action: 'Buy/Sell',
        quantity: 'Quantity',
        price: 'TradePrice',
        filledAt: 'DateTime',
        eventCode: 'Notes/Codes',
      },
    },
    timezone: 'UTC',
    dateFormat: 'iso',
    numberFormat: 'us',
    ...overrides,
  };
}

/** An open option leg seeded directly (no CSV), as a preview target (task 19). */
async function seedOpenOptionLeg(params: {
  userId: string;
  accountId: string;
  side: 'long' | 'short';
  symbol: string;
  quantity: string;
  filledAt: string;
}): Promise<string> {
  const position = await createPosition(
    db,
    params.userId,
    {
      accountId: params.accountId,
      symbol: params.symbol,
      side: params.side,
      assetType: 'option',
    },
    { isAdmin: false },
  );
  await db.insert(fills).values({
    positionId: position!.id,
    type: 'entry',
    price: '1.00',
    quantity: params.quantity,
    fees: '0',
    filledAt: new Date(params.filledAt),
  });
  await openPosition(db, position!.id, params.userId, params.filledAt);
  return position!.id;
}

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
// Option contracts (REQ-1.1)
// ---------------------------------------------------------------------------

describe('previewImport — option contracts', () => {
  it('an option row carrying a valid contract previews as a committable option position', async () => {
    const { userId, accountId } = await seedAccount();
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      'AAPL260320C250,OPTION,BUY,1.75,1,2026-01-05,0.65',
      'AAPL260320C250,OPTION,SELL,2.25,1,2026-01-06,0.65',
    ].join('\n');
    const res = await previewImport(
      db,
      userId,
      accountId,
      bytes(csv),
      execRequest(accountId, {
        mapping: {
          rowShape: 'execution',
          contractForm: 'occ-symbol',
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
      }),
    );
    expect(res.committable).toBe(true);
    expect(res.summary.positions).toBe(1);
    expect(res.positions).toHaveLength(1);
    expect(res.positions[0].scope.symbol).toBe('AAPL260320C250');
    expect(res.positions[0].scope.assetType).toBe('option');
    expect(res.positions[0].closes).toBe(true);
    // (2.25 − 1.75) × 1 × 100 − 0.65 − 0.65.
    expect(res.positions[0].proposedPnl).toBeCloseTo(48.7, 2);
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

// ---------------------------------------------------------------------------
// Option path — integration cases (design Testing Strategy → Integration,
// service half). Every assertion is on code/rowNumber/tradrField/csvColumn (and
// that a message names the row and value), never a byte-exact message string.
// ---------------------------------------------------------------------------

describe('previewImport — option contract errors (REQ-2.4–2.6, 3.5, 4.1–4.2)', () => {
  it('(b) locates each OCC encoder error on its row and field (composed form)', async () => {
    const { userId, accountId } = await seedAccount();
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees,Expiry,Strike,Right',
      'AAPL,OPTION,BUY,1.75,1,2026-01-05,0.65,2026-03-20,100000,C', // OCC_STRIKE_RANGE
      'AAPL,OPTION,BUY,1.75,1,2026-01-05,0.65,2026-03-20,0.0001,C', // OCC_STRIKE_PRECISION
      'AAPL,OPTION,BUY,1.75,1,2026-01-05,0.65,2026-03-20,1234.567,C', // OCC_STRIKE_NOT_REPRESENTABLE
      '1ABC,OPTION,BUY,1.75,1,2026-01-05,0.65,2026-03-20,250,C', // OCC_BAD_UNDERLYING
      'AAPL,OPTION,BUY,1.75,1,2026-01-05,0.65,2050-01-16,250,C', // OCC_DATE_RANGE
      'ABCDEF,OPTION,BUY,1.75,1,2026-01-05,0.65,2026-03-20,12345.678,C', // OCC_COMPACT_TOO_LONG
    ].join('\n');
    const res = await previewImport(
      db,
      userId,
      accountId,
      bytes(csv),
      execRequest(accountId, {
        mapping: {
          rowShape: 'execution',
          contractForm: 'composed',
          expiryFormat: 'iso',
          columns: {
            symbol: 'Symbol',
            assetType: 'Type',
            action: 'Side',
            price: 'Price',
            quantity: 'Quantity',
            filledAt: 'Date',
            fees: 'Fees',
            expiry: 'Expiry',
            strike: 'Strike',
            right: 'Right',
          },
        },
      }),
    );
    expect(res.committable).toBe(false);
    expect(res.errors).toContainEqual(
      expect.objectContaining({
        code: 'OCC_STRIKE_RANGE',
        rowNumber: 2,
        tradrField: 'strike',
        csvColumn: 'Strike',
      }),
    );
    expect(res.errors).toContainEqual(
      expect.objectContaining({
        code: 'OCC_STRIKE_PRECISION',
        rowNumber: 3,
        tradrField: 'strike',
        csvColumn: 'Strike',
      }),
    );
    expect(res.errors).toContainEqual(
      expect.objectContaining({
        code: 'OCC_STRIKE_NOT_REPRESENTABLE',
        rowNumber: 4,
        tradrField: 'strike',
        csvColumn: 'Strike',
      }),
    );
    expect(res.errors).toContainEqual(
      expect.objectContaining({
        code: 'OCC_BAD_UNDERLYING',
        rowNumber: 5,
        tradrField: 'symbol',
        csvColumn: 'Symbol',
      }),
    );
    expect(res.errors).toContainEqual(
      expect.objectContaining({
        code: 'OCC_DATE_RANGE',
        rowNumber: 6,
        tradrField: 'expiry',
        csvColumn: 'Expiry',
      }),
    );
    expect(res.errors).toContainEqual(
      expect.objectContaining({
        code: 'OCC_COMPACT_TOO_LONG',
        rowNumber: 7,
        tradrField: 'symbol',
        csvColumn: 'Symbol',
      }),
    );
    // A located message names the row and the offending value (illustrative text).
    const strikeRange = res.errors.find((e) => e.code === 'OCC_STRIKE_RANGE');
    expect(strikeRange?.message).toMatch(/row\s*2/i);
    expect(strikeRange?.message).toContain('100000');
    const tooLong = res.errors.find((e) => e.code === 'OCC_COMPACT_TOO_LONG');
    expect(tooLong?.message).toMatch(/row\s*7/i);
    expect(tooLong?.message).toContain('ABCDEF');
  });

  it('(b) locates missing composed cells and a contract field on a stock row', async () => {
    const { userId, accountId } = await seedAccount();
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees,Expiry,Strike,Right',
      'AAPL,OPTION,BUY,1.75,1,2026-01-05,0.65,,,', // 3x CONTRACT_FIELD_MISSING
      'AAPL,STOCK,BUY,100,10,2026-01-01,1,2026-03-20,,', // CONTRACT_FIELD_ON_STOCK
    ].join('\n');
    const res = await previewImport(
      db,
      userId,
      accountId,
      bytes(csv),
      execRequest(accountId, {
        mapping: {
          rowShape: 'execution',
          contractForm: 'composed',
          expiryFormat: 'iso',
          columns: {
            symbol: 'Symbol',
            assetType: 'Type',
            action: 'Side',
            price: 'Price',
            quantity: 'Quantity',
            filledAt: 'Date',
            fees: 'Fees',
            expiry: 'Expiry',
            strike: 'Strike',
            right: 'Right',
          },
        },
      }),
    );
    for (const field of ['expiry', 'strike', 'right']) {
      expect(res.errors).toContainEqual(
        expect.objectContaining({
          code: 'CONTRACT_FIELD_MISSING',
          rowNumber: 2,
          tradrField: field,
        }),
      );
    }
    expect(res.errors).toContainEqual(
      expect.objectContaining({
        code: 'CONTRACT_FIELD_ON_STOCK',
        rowNumber: 3,
        tradrField: 'expiry',
        csvColumn: 'Expiry',
      }),
    );
  });

  it('(b) locates an unmatched occ-symbol cell as OCC_NO_FORM_MATCH on symbol', async () => {
    const { userId, accountId } = await seedAccount();
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      'AAPL  260320C0025000,OPTION,BUY,1.75,1,2026-01-05,0.65',
    ].join('\n');
    const res = await previewImport(
      db,
      userId,
      accountId,
      bytes(csv),
      execRequest(accountId, {
        mapping: {
          rowShape: 'execution',
          contractForm: 'occ-symbol',
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
      }),
    );
    expect(res.errors).toContainEqual(
      expect.objectContaining({
        code: 'OCC_NO_FORM_MATCH',
        rowNumber: 2,
        tradrField: 'symbol',
        csvColumn: 'Symbol',
      }),
    );
  });

  it('(b) locates an unparseable descriptor as CONTRACT_DESCRIPTOR_UNPARSEABLE', async () => {
    const { userId, accountId } = await seedAccount();
    const csv = [
      'Symbol,Side,Quantity,Price,Date,Option',
      'AAPL,BUY,1,2.50,2026-01-05,JAN 12 CALL',
    ].join('\n');
    const res = await previewImport(
      db,
      userId,
      accountId,
      bytes(csv),
      execRequest(accountId, {
        mapping: {
          rowShape: 'execution',
          contractForm: 'descriptor',
          columns: {
            symbol: 'Symbol',
            action: 'Side',
            quantity: 'Quantity',
            price: 'Price',
            filledAt: 'Date',
            descriptor: 'Option',
          },
        },
      }),
    );
    expect(res.errors).toContainEqual(
      expect.objectContaining({
        code: 'CONTRACT_DESCRIPTOR_UNPARSEABLE',
        rowNumber: 2,
        tradrField: 'descriptor',
        csvColumn: 'Option',
      }),
    );
  });

  it('(c) refuses a multiplier of 10 on the multiplier field (REQ-4.1)', async () => {
    const { userId, accountId } = await seedAccount();
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Multiplier',
      'AAPL260320C250,OPTION,BUY,1.75,1,2026-01-05,10',
    ].join('\n');
    const res = await previewImport(
      db,
      userId,
      accountId,
      bytes(csv),
      execRequest(accountId, {
        mapping: {
          rowShape: 'execution',
          contractForm: 'occ-symbol',
          columns: {
            symbol: 'Symbol',
            assetType: 'Type',
            action: 'Side',
            price: 'Price',
            quantity: 'Quantity',
            filledAt: 'Date',
            multiplier: 'Multiplier',
          },
        },
      }),
    );
    const err = res.errors.find((e) => e.code === 'OPTION_MULTIPLIER_UNSUPPORTED');
    expect(res.errors).toContainEqual(
      expect.objectContaining({
        code: 'OPTION_MULTIPLIER_UNSUPPORTED',
        rowNumber: 2,
        tradrField: 'multiplier',
        csvColumn: 'Multiplier',
      }),
    );
    expect(err?.message).toContain('10');
  });

  it('(c) refuses a Tradervue mini descriptor on the descriptor field (REQ-4.1)', async () => {
    const { userId, accountId } = await seedAccount();
    const csv = [
      'Symbol,Side,Quantity,Price,Date,Option',
      'AAPL,BUY,1,2.50,2026-01-05,APR26 13 375 PUT M',
    ].join('\n');
    const res = await previewImport(
      db,
      userId,
      accountId,
      bytes(csv),
      execRequest(accountId, {
        mapping: {
          rowShape: 'execution',
          contractForm: 'descriptor',
          columns: {
            symbol: 'Symbol',
            action: 'Side',
            quantity: 'Quantity',
            price: 'Price',
            filledAt: 'Date',
            descriptor: 'Option',
          },
        },
      }),
    );
    expect(res.errors).toContainEqual(
      expect.objectContaining({
        code: 'OPTION_MULTIPLIER_UNSUPPORTED',
        rowNumber: 2,
        tradrField: 'descriptor',
        csvColumn: 'Option',
      }),
    );
  });

  it('(d) proposes a targetless assigned event for an OPT lifecycle code, and still imports the STK row carrying the same code with a premium-excluded warning (AC 10.3, 10.5)', async () => {
    const { userId, accountId } = await seedAccount();
    // Synthetic Trades-shaped rows — never a committed sample edited to carry a code.
    const csv = [
      'Symbol,AssetClass,Buy/Sell,Quantity,TradePrice,DateTime,Notes/Codes',
      'AAPL  120121C00400000,OPT,BUY,1,1.75,2012-01-05,A',
      'AAPL,STK,BUY,100,121.50,2012-01-05,A',
    ].join('\n');
    const res = (await previewImport(
      db,
      userId,
      accountId,
      bytes(csv),
      execRequest(accountId, {
        dateFormat: 'iso',
        mapping: {
          rowShape: 'execution',
          contractForm: 'occ-symbol',
          columns: {
            symbol: 'Symbol',
            assetType: 'AssetClass',
            action: 'Buy/Sell',
            quantity: 'Quantity',
            price: 'TradePrice',
            filledAt: 'DateTime',
            eventCode: 'Notes/Codes',
          },
        },
      }),
    )) as unknown as ExtendedPreviewResponse;

    // No target (fresh account, no same-file option segment): a located,
    // nonBlocking error — the row no longer refuses outright (AC 10.3).
    expect(res.errors).toContainEqual(
      expect.objectContaining({
        code: 'LIFECYCLE_TARGET_NOT_FOUND',
        rowNumber: 2,
        nonBlocking: true,
      }),
    );
    expect(res.events ?? []).toEqual([]);
    expect(res.committable).toBe(true);

    // The STK row's `A` matches no event (price 121.50 ≠ strike 400): it
    // imports as stock, as today, plus the premium-excluded warning (AC 10.5).
    expect(
      res.positions.some((p) => p.scope.assetType === 'stock' && p.scope.symbol === 'AAPL'),
    ).toBe(true);
    expect(res.warnings).toContainEqual(
      expect.objectContaining({ rowNumber: 3, kind: 'lifecycle_basis_excludes_premium' }),
    );
  });

  it('(e) emits one derived_expiry warning for a day-less monthly descriptor (REQ-3.5)', async () => {
    const { userId, accountId } = await seedAccount();
    const csv = [
      'Symbol,Side,Quantity,Price,Date,Option',
      'AAPL,BUY,1,2.50,2026-01-05,JAN 12 125 CALL',
    ].join('\n');
    const res = await previewImport(
      db,
      userId,
      accountId,
      bytes(csv),
      execRequest(accountId, {
        mapping: {
          rowShape: 'execution',
          contractForm: 'descriptor',
          columns: {
            symbol: 'Symbol',
            action: 'Side',
            quantity: 'Quantity',
            price: 'Price',
            filledAt: 'Date',
            descriptor: 'Option',
          },
        },
      }),
    );
    const derived = res.warnings.filter((w) => w.kind === 'derived_expiry');
    expect(derived).toHaveLength(1);
    expect(derived[0].rowNumber).toBe(2);
  });

  it('(g) refuses a fractional option quantity on its row', async () => {
    const { userId, accountId } = await seedAccount();
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      'AAPL260320C250,OPTION,BUY,1.75,0.5,2026-01-05,0.65',
    ].join('\n');
    const res = await previewImport(
      db,
      userId,
      accountId,
      bytes(csv),
      execRequest(accountId, {
        mapping: {
          rowShape: 'execution',
          contractForm: 'occ-symbol',
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
      }),
    );
    expect(res.committable).toBe(false);
    expect(res.errors).toContainEqual(
      expect.objectContaining({ code: 'OPTION_FRACTIONAL_QUANTITY', rowNumber: 2 }),
    );
  });

  it('(j) refuses a BUY row whose signed quantity contradicts the action', async () => {
    const { userId, accountId } = await seedAccount();
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      'AAPL,STOCK,BUY,100,-100,2026-01-01,1',
    ].join('\n');
    const res = await previewImport(
      db,
      userId,
      accountId,
      bytes(csv),
      execRequest(accountId, {
        mapping: {
          rowShape: 'execution',
          signedQuantity: true,
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
      }),
    );
    expect(res.errors).toContainEqual(
      expect.objectContaining({
        code: 'QUANTITY_SIGN_CONTRADICTION',
        rowNumber: 2,
        tradrField: 'quantity',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Lifecycle-event proposal in the import preview (task 19, design C12)
//
// Contract block — one row per success criterion this block covers (the
// targetless/stock-regression branch and the blocking-committable branch are
// covered by the updated test (d) above and by the pre-existing "(crossing
// flat)" test respectively — see the implementer report for both).
//
// | Criterion                                                          | Pre-condition                                                              | Call (seam)      | Observable result                                                        | Source |
// |----------------------------------------------------------------------|-------------------------------------------------------------------------------|-------------------|-----------------------------------------------------------------------------|---------|
// | AC 10.1/10.2/10.3 (open leg)/10.7 — A+EX events, named targets, EP stays unsupported | two open legs (short/long) in the account; a Flex-shaped file with A, EX, EP rows | previewImport()   | events[] holds the assigned+exercised events, each naming its open_leg target; EP row still errors OPTION_EVENT_NOT_SUPPORTED | design C12, task 19 _Prompt Success |
// | AC 10.2/10.3 (same-file segment) — segment target                    | one file opens an option segment, then tags an assigned row for the same contract | previewImport()   | the event's target is `{ kind: 'segment', segmentRef }` indexing the proposed position | design C12, TD8 |
// | AC 10.6 — re-import of a fully settled leg                           | a leg already settled (assigned) for the row's own date and quantity          | previewImport()   | a lifecycle_already_settled warning, no event proposed, committable stays true | design C12, TD9 |
// ---------------------------------------------------------------------------

describe('previewImport — lifecycle event proposals (design C12)', () => {
  it('previews an assigned and an exercised event against existing open legs, naming each target, and leaves an EP row unsupported with its reason (AC 10.1, 10.2, 10.3, 10.7)', async () => {
    const { userId, accountId } = await seedAccount();
    const assignedSymbol = occ('AAPL', '2026-04-17', 'call', '250');
    const exercisedSymbol = occ('MSFT', '2026-05-15', 'call', '260');
    const epSymbol = occ('TSLA', '2026-06-19', 'call', '300');

    const assignedLegId = await seedOpenOptionLeg({
      userId,
      accountId,
      side: 'short',
      symbol: assignedSymbol,
      quantity: '1',
      filledAt: '2026-04-01T00:00:00.000Z',
    });
    const exercisedLegId = await seedOpenOptionLeg({
      userId,
      accountId,
      side: 'long',
      symbol: exercisedSymbol,
      quantity: '1',
      filledAt: '2026-05-01T00:00:00.000Z',
    });

    const csv = [
      'Symbol,AssetClass,Buy/Sell,Quantity,TradePrice,DateTime,Notes/Codes',
      `${assignedSymbol},OPT,SELL,1,0,2026-04-20,A`,
      `${exercisedSymbol},OPT,BUY,1,0,2026-05-20,EX`,
      `${epSymbol},OPT,BUY,1,0,2026-06-20,EP`,
    ].join('\n');

    const res = (await previewImport(
      db,
      userId,
      accountId,
      bytes(csv),
      lifecycleRequest(accountId),
    )) as unknown as ExtendedPreviewResponse;

    const events = res.events ?? [];
    expect(events).toHaveLength(2);

    const assigned = events.find((e) => e.symbol === assignedSymbol);
    expect(assigned).toMatchObject({ rowNumber: 2, outcome: 'assigned', quantity: '1' });
    expect(assigned?.target).toMatchObject({ kind: 'open_leg', positionId: assignedLegId });

    const exercised = events.find((e) => e.symbol === exercisedSymbol);
    expect(exercised).toMatchObject({ rowNumber: 3, outcome: 'exercised', quantity: '1' });
    expect(exercised?.target).toMatchObject({ kind: 'open_leg', positionId: exercisedLegId });

    const epError = res.errors.find((e) => e.rowNumber === 4);
    expect(epError).toMatchObject({ code: 'OPTION_EVENT_NOT_SUPPORTED', tradrField: 'eventCode' });
    expect(epError?.message).toContain('expiration or assignment');

    // The EP row's refusal stays a blocking error: committable is false.
    expect(res.committable).toBe(false);
  });

  it("resolves an event's target to a same-file open segment when no DB leg exists (AC 10.2, 10.3)", async () => {
    const { userId, accountId } = await seedAccount();
    const symbol = occ('MSFT', '2026-07-17', 'put', '300');

    const csv = [
      'Symbol,AssetClass,Buy/Sell,Quantity,TradePrice,DateTime,Notes/Codes',
      `${symbol},OPT,SELL,2,3.00,2026-07-01,`,
      `${symbol},OPT,BUY,2,0,2026-07-10,A`,
    ].join('\n');

    const res = (await previewImport(
      db,
      userId,
      accountId,
      bytes(csv),
      lifecycleRequest(accountId),
    )) as unknown as ExtendedPreviewResponse;

    expect(res.positions).toHaveLength(1);
    expect(res.positions[0].scope.symbol).toBe(symbol);

    const events = res.events ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ rowNumber: 3, outcome: 'assigned', quantity: '2' });
    expect(events[0].target).toMatchObject({ kind: 'segment', segmentRef: 0 });
    expect(res.committable).toBe(true);
  });

  it('warns and proposes no event when a re-import matches an already-settled leg (AC 10.6)', async () => {
    const { userId, accountId } = await seedAccount();
    const symbol = occ('AAPL', '2026-12-18', 'call', '300');

    const legId = await seedOpenOptionLeg({
      userId,
      accountId,
      side: 'short',
      symbol,
      quantity: '1',
      filledAt: '2026-02-01T00:00:00.000Z',
    });
    await settleLeg(db, userId, legId, {
      outcome: 'assigned',
      settledAt: '2026-02-10T00:00:00.000Z',
      quantity: '1',
      fees: '0',
    });

    const csv = [
      'Symbol,AssetClass,Buy/Sell,Quantity,TradePrice,DateTime,Notes/Codes',
      `${symbol},OPT,SELL,1,0,2026-02-10,A`,
    ].join('\n');

    const res = (await previewImport(
      db,
      userId,
      accountId,
      bytes(csv),
      lifecycleRequest(accountId),
    )) as unknown as ExtendedPreviewResponse;

    expect(res.events ?? []).toEqual([]);
    expect(res.warnings).toContainEqual(
      expect.objectContaining({ rowNumber: 2, kind: 'lifecycle_already_settled' }),
    );
    expect(res.errors.some((e) => e.code === 'LIFECYCLE_TARGET_NOT_FOUND')).toBe(false);
    expect(res.committable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-form contract identity (REQ-1.3, 3.2 end to end)
// ---------------------------------------------------------------------------

describe('previewImport — cross-form contract identity', () => {
  it('(f) collapses padded OCC-21, Form 3 and Form 4 of one contract to a single scope', async () => {
    const { userId, accountId } = await seedAccount();
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      'AAPL  120121C00400000,OPTION,BUY,1.75,1,2012-01-05,0.65', // padded OCC-21
      'AAPL120121C00400000,OPTION,BUY,1.80,1,2012-01-05,0.65', // Form 3
      'AAPL120121C400,OPTION,SELL,2.25,2,2012-01-06,0.65', // Form 4
    ].join('\n');
    const res = await previewImport(
      db,
      userId,
      accountId,
      bytes(csv),
      execRequest(accountId, {
        mapping: {
          rowShape: 'execution',
          contractForm: 'occ-symbol',
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
      }),
    );
    expect(res.errors).toHaveLength(0);
    expect(res.positions).toHaveLength(1);
    expect(res.positions[0].scope.symbol).toBe('AAPL120121C400');
  });

  it('(f) re-maps the Interactive Brokers sample as composed to the identical compact symbol', async () => {
    const { userId, accountId } = await seedAccount();
    const res = await previewImport(
      db,
      userId,
      accountId,
      readCsvImportSample('interactive-brokers'),
      execRequest(accountId, {
        dateFormat: 'iso-datetime',
        mapping: {
          rowShape: 'execution',
          contractForm: 'composed',
          expiryFormat: 'yyyymmdd',
          signedQuantity: true,
          signedFees: true,
          columns: {
            symbol: 'Symbol',
            assetType: 'AssetClass',
            action: 'Buy/Sell',
            quantity: 'Quantity',
            price: 'TradePrice',
            filledAt: 'DateTime',
            fees: 'IBCommission',
            multiplier: 'Multiplier',
            underlying: 'UnderlyingSymbol',
            expiry: 'Expiry',
            strike: 'Strike',
            right: 'Put/Call',
          },
        },
      }),
    );
    expect(res.errors).toHaveLength(0);
    const option = res.positions.find((p) => p.scope.assetType === 'option');
    expect(option).toBeDefined();
    expect(option?.scope.symbol).toBe('AAPL120121C400');
  });
});

// ---------------------------------------------------------------------------
// Option re-import duplicate gate (REQ-6.1) — needs the live ledger close hook.
// ---------------------------------------------------------------------------

describe('previewImport — option duplicate gate on re-import (REQ-6.1)', () => {
  beforeAll(() => {
    bootstrap().catch(() => {});
  });
  afterAll(() => {
    unregisterCloseHook('ledger');
  });

  it('(h) re-importing a committed option file trips the duplicate affirmation gate', async () => {
    const { userId, accountId } = await seedAccount();
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      'AAPL260320C250,OPTION,BUY,1.75,1,2026-01-05,0.65',
      'AAPL260320C250,OPTION,SELL,2.25,1,2026-01-06,0.65',
    ].join('\n');
    const req = execRequest(accountId, {
      mapping: {
        rowShape: 'execution',
        contractForm: 'occ-symbol',
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
    });

    const first = await previewImport(db, userId, accountId, bytes(csv), req);
    expect(first.committable).toBe(true);
    expect(first.requiresDuplicateAffirmation).toBe(false);

    const summary = await commitImport(db, userId, first.token, false, { isAdmin: false });
    expect(summary.positionsCreated).toBe(1);

    const second = await previewImport(db, userId, accountId, bytes(csv), req);
    expect(second.requiresDuplicateAffirmation).toBe(true);
    expect(second.committable).toBe(true); // affirmation gate, not a hard block
  });
});

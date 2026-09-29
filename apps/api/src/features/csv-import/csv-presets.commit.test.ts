import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CSV_IMPORT_PRESETS } from '@tradr/shared';
import { readCsvImportSample } from '@tradr/shared/node/csv-import-samples';

import app from '@/app';
import { db } from '@/db';
import { fills, positions } from '@/db/schema';
import { insertPositionCloseLedgerEntries } from '@/features/accounting/ledger-hook';
import { replaceCloseHook, unregisterCloseHook } from '@/features/positions/positions.service';

// ---------------------------------------------------------------------------
// Named-preset commit + re-import integration (design Testing Strategy →
// Integration; REQ-3.3, REQ-3.4, REQ-4.2). Drives the full POST
// /api/csv-import/preview → POST /api/csv-import/commit handshake for each
// shipped preset's committed sample through Hono `app.request` against a real
// Postgres (no DB mocks; per-test transaction-rollback isolation from
// test-setup.ts). Mirrors the csv-import.commit.test.ts real-PG harness
// (ledger close-hook registration, register → session cookie → create account →
// authed multipart preview → JSON commit), reading each fixture through
// `readCsvImportSample` and its preset's own mapping/formats.
//
// The live `ledger` close-hook is registered so the close path fires it INSIDE
// the bulk tx, exactly as production does. The loop currently holds the single
// preset that skips and refuses rows (`tastytrade`); it grows as more such
// presets ship.
// ---------------------------------------------------------------------------

function registerLedgerHook() {
  replaceCloseHook('ledger', insertPositionCloseLedgerEntries);
}

let testCounter = 0;
function uniqueEmail() {
  return `csv-presets-commit-${Date.now()}-${++testCounter}@example.com`;
}

// Second octet 79 — 77 (csv-import.commit) and 78 (csv-import.ledger-rollback)
// are taken by the other real-PG csv-import suites.
let ipCounter = 0;
function uniqueIp() {
  return `10.79.${Math.floor(++ipCounter / 256)}.${ipCounter % 256}`;
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

async function createAccount(cookie: string): Promise<string> {
  const res = await app.request('/api/accounts', {
    method: 'POST',
    headers: {
      Cookie: `session=${cookie}`,
      'Content-Type': 'application/json',
      'X-Forwarded-For': uniqueIp(),
    },
    body: JSON.stringify({ name: 'Import Account', currency: 'USD' }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  return body.id as string;
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

/** The preview request a preset drives: its mapping, formats and id. */
function presetRequest(preset: (typeof CSV_IMPORT_PRESETS)[number], accountId: string) {
  return {
    accountId,
    rowShape: preset.rowShape,
    mapping: preset.mapping,
    presetId: preset.id,
    timezone: 'UTC',
    dateFormat: preset.dateFormat,
    numberFormat: preset.numberFormat,
  };
}

interface CommitExpectation {
  /** Parsed data-row count (header excluded). */
  rowsParsed: number;
  /** Distinct file rows carrying a blocking error. */
  rowsWithErrors: number;
  /** Rows the row filter skipped before mapping. */
  rowsSkipped: number;
  positionsCreated: number;
  fillsCreated: number;
  /** Every created fill's `[fees, filledAt ISO]`, compared order-independently. */
  fills: Array<[number, string]>;
}

// Only presets whose sample both skips and refuses rows belong here (the
// database-backed commit + re-import path the pure conformance test cannot
// exercise). tastytrade skips two Money Movement rows and refuses one Future
// Trade row; the remaining seven fills across four positions commit. All
// datetimes carry an explicit -0400 offset, so `filledAt` is deterministic
// regardless of the process timezone.
const EXPECTED: Record<string, CommitExpectation> = {
  tastytrade: {
    rowsParsed: 10,
    rowsWithErrors: 1,
    rowsSkipped: 2,
    positionsCreated: 4,
    fillsCreated: 7,
    fills: [
      // AAPL stock round trip (Commissions+Fees magnitudes summed).
      [1.14, '2018-05-21T15:55:20.000Z'],
      [0, '2018-05-22T14:30:00.000Z'],
      // AAPL 07/20/18 195 Call round trip.
      [1.14, '2018-06-11T13:31:00.000Z'],
      [0, '2018-06-12T19:50:00.000Z'],
      // SPY 09/21/18 250 Put same-instant short (SELL_TO_OPEN entry, BUY_TO_CLOSE exit).
      [0, '2018-07-16T14:00:00.000Z'],
      [1.1, '2018-07-16T14:00:00.000Z'],
      // MSFT open stock residual.
      [1.05, '2018-08-01T13:45:00.000Z'],
    ],
  },
};

const PRESET_IDS = ['tastytrade'];

describe('POST /api/csv-import — named preset commit + re-import (real Postgres)', () => {
  beforeAll(registerLedgerHook);
  afterAll(() => unregisterCloseHook('ledger'));

  for (const id of PRESET_IDS) {
    it(`${id}: blocks the refusing fixture, commits once the refused rows are removed, then gates the re-import on duplicates`, async () => {
      const preset = CSV_IMPORT_PRESETS.find((p) => p.id === id);
      expect(preset, `no preset for id "${id}"`).toBeDefined();
      if (!preset) return;
      const exp = EXPECTED[id];

      const cookie = await registerAndGetCookie();
      const accountId = await createAccount(cookie);
      const fixture = Buffer.from(readCsvImportSample(id)).toString('utf-8');

      // 1. Preview the whole fixture: non-committable, exactly one rows_skipped
      //    warning, and rowsValid = rowsParsed − rowsWithErrors − rowsSkipped
      //    (Decision D8, REQ-4.2).
      const preview = await postPreview(cookie, fixture, presetRequest(preset, accountId));
      expect(preview.status).toBe(200);
      const pbody = await preview.json();
      expect(pbody.committable).toBe(false);
      expect(pbody.summary.rowsParsed).toBe(exp.rowsParsed);
      expect(pbody.summary.rowsWithErrors).toBe(exp.rowsWithErrors);
      expect(pbody.summary.rowsValid).toBe(exp.rowsParsed - exp.rowsWithErrors - exp.rowsSkipped);
      const skipWarnings = pbody.warnings.filter(
        (w: { kind: string }) => w.kind === 'rows_skipped',
      );
      expect(skipWarnings).toHaveLength(1);
      expect(skipWarnings[0].message).toContain(`${exp.rowsSkipped} rows`);

      // 2. Committing the blocked preview refuses with 409 CSV_IMPORT_BLOCKED.
      const blocked = await postCommit(cookie, pbody.token);
      expect(blocked.status).toBe(409);
      expect((await blocked.json()).error.code).toBe('CSV_IMPORT_BLOCKED');

      // 3. Remove the refused rows (one line is one record in this fixture; the
      //    error's rowNumber is the 1-based file line) and re-import.
      const refused = new Set<number>(
        pbody.errors.map((e: { rowNumber: number }) => e.rowNumber).filter((n: number) => n > 0),
      );
      expect(refused.size).toBe(exp.rowsWithErrors);
      const cleaned = fixture
        .split('\n')
        .filter((_, i) => !refused.has(i + 1))
        .join('\n');

      const cleanPreview = await postPreview(cookie, cleaned, presetRequest(preset, accountId));
      expect(cleanPreview.status).toBe(200);
      const cbody = await cleanPreview.json();
      expect(cbody.committable).toBe(true);

      const committed = await postCommit(cookie, cbody.token);
      expect(committed.status).toBe(200);
      const summary = await committed.json();
      expect(summary.positionsCreated).toBe(exp.positionsCreated);
      expect(summary.fillsCreated).toBe(exp.fillsCreated);
      expect(summary.accountId).toBe(accountId);

      // Every created fill's fees and filledAt, straight out of Postgres.
      const createdFills = await db
        .select({ fees: fills.fees, filledAt: fills.filledAt })
        .from(fills)
        .innerJoin(positions, eq(fills.positionId, positions.id))
        .where(eq(positions.accountId, accountId));
      const sortKey = (t: [number, string]) => `${t[0]}|${t[1]}`;
      const actual: Array<[number, string]> = createdFills
        .map((f): [number, string] => [Number(f.fees), f.filledAt.toISOString()])
        .sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
      const wanted = [...exp.fills].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
      expect(actual).toEqual(wanted);

      // 4. Re-importing the same input requires duplicate affirmation, and a
      //    commit without confirmDuplicates is refused (409
      //    CSV_IMPORT_DUPLICATES_UNCONFIRMED).
      const reimport = await postPreview(cookie, cleaned, presetRequest(preset, accountId));
      expect(reimport.status).toBe(200);
      const rbody = await reimport.json();
      expect(rbody.requiresDuplicateAffirmation).toBe(true);

      const unconfirmed = await postCommit(cookie, rbody.token);
      expect(unconfirmed.status).toBe(409);
      expect((await unconfirmed.json()).error.code).toBe('CSV_IMPORT_DUPLICATES_UNCONFIRMED');
    });
  }
});

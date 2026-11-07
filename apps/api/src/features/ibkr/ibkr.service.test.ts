/**
 * ibkr.service.test.ts — `fetchAndPreview` (design C6; Req 2.2-2.9, 3.2, 3.5,
 * 3.6, 4.1, 4.2, 5.7, 6.5, 7.1, 7.3, NFR Security/Reliability). Drives the
 * service directly — `fetchAndPreview(db, userId, accountId, deps)` — against
 * real Postgres (test-setup.ts's per-test rolled-back transaction), the same
 * harness as ibkr.route.test.ts and csv-import.preview.test.ts. The outbound
 * IBKR call is replaced by the `FetchFlexDeps` seam (`fetchImpl`/`sleep`/`now`)
 * design C4 already exposes — never a module mock of a collaborator inside
 * `ibkr.service.ts` itself.
 *
 * No `fetchAndPreview` export exists yet in `ibkr.service.ts` (Red-first):
 * every call below currently throws `fetchAndPreview is not a function`.
 *
 * Contract (one row per success criterion):
 *
 * | # | Pre-condition | Observable result | Source |
 * |---|---|---|---|
 * | T1  | a connection, a 2-fill flex report | resolves to a `CsvPreviewResponse` with a token; `commitImport` of that token creates 1 position/2 fills; the connection records the fetch time and the report's trade-date span | Req 2.3, 3.1, 7.1 |
 * | T2  | no connection for the account | rejects 404 NOT_FOUND | Req 5.7 |
 * | T3  | the account's connection belongs to another user | rejects 404 NOT_FOUND | Req 5.7 |
 * | T4  | a connection row whose ciphertext cannot be decrypted | rejects 409 IBKR_CONNECTION_UNREADABLE | Req 4.1 |
 * | T5  | the report bytes are not valid UTF-8 | rejects 503 IBKR_FLEX_UNAVAILABLE | design C6 step 4 |
 * | T6  | the report has a header row and no data rows | rejects 422 IBKR_FLEX_NO_TRADES; the connection's span stays null but the fetch time is recorded | Req 2.7, 7.1 |
 * | T7  | the report has no account-identifier column | rejects 422 IBKR_FLEX_ACCOUNT_UNPROVEN; no row is staged | Req 2.8 |
 * | T8  | the report names two distinct account values | rejects 422 IBKR_FLEX_ACCOUNT_UNPROVEN; no row is staged | Req 2.8 |
 * | T9  | a connection with an existing fetch record; the outbound call is refused (token rejected) | rejects; the connection's record is unchanged; nothing is staged | Req 4.2, 7.3, NFR Reliability |
 * | T10 | the connection is replaced (new id) by a `sleep` side-effect mid-poll | resolves; the surviving (replaced) row's last-fetch fields stay null — the update by the old id is a no-op | design C1 |
 * | T11 | the report has no `Multiplier` column | the preview's row-0 error is `MAPPING_COLUMN_ABSENT`; `committable` is false | Req 2.9 _(invariant)_ |
 * | T12 | a row's `DateTime` cell is not in the preset's shape | the preview holds a `DATE_UNPARSEABLE` error | Req 2.10 _(invariant)_ |
 * | T13 | the same report is fetched and committed, then fetched again | the second preview sets `requiresDuplicateAffirmation`; an unaffirmed commit rejects CSV_IMPORT_DUPLICATES_UNCONFIRMED; an affirmed commit succeeds | Req 3.2 _(invariant)_ |
 * | T14 | a fresh account | the preview alone leaves the lifetime import counter at 0; a commit of its token raises it to 1 | Req 3.5 _(invariant)_ |
 * | T15 | the account is already at the Free lifetime import cap | the commit rejects 403 TIER_LIMIT_CSV_IMPORTS; after the cap is lifted, the SAME token commits | Req 3.6 _(invariant)_ |
 * | T16 | `CSV_IMPORT_MAX_FILE_BYTES` is lowered below the report's size | rejects 413 PAYLOAD_TOO_LARGE | Req 2.6 |
 * | T17 | a prior fetch's staged row is forced to `committing` | the next fetch's own preview insert rejects 409 CSV_IMPORT_IN_PROGRESS | design Error Handling row 12 |
 * | T18 | a report cell starts with `=` | the returned position's symbol is neutralized (`'=...`) | NFR Security _(invariant)_ |
 *
 * T11, T12, T13, T14, T15 and T18 exercise behaviour that already holds inside
 * `previewImport`/`commitImport`/`neutralizeCsvCell` (the task's own
 * "regression guards ... hold in the importer already" note) — here they
 * prove only that `fetchAndPreview`'s new orchestration does not break that
 * pass-through. Every test is genuinely red today because `fetchAndPreview`
 * itself does not exist.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { LocatedError } from '@tradr/shared';

import { db } from '@/db';
import { accounts, ibkrFlexConnections, users } from '@/db/schema';
import { csvImportCounters, csvImportStaging } from '@/db/schema/csv-import.schema';
import { getTierLimits } from '@/features/billing/tier-limits.constants';
import { commitImport } from '@/features/csv-import/csv-import.service';
import { config } from '@/lib/config';
import {
  ENCRYPTION_KEY_VERSION_CURRENT,
  encrypt,
  loadEncryptionKeyMaterial,
} from '@/lib/encryption';

import { recordFetch } from './ibkr.query';
import { fetchAndPreview, saveConnection } from './ibkr.service';

beforeAll(() => {
  loadEncryptionKeyMaterial();
});

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `ibkr-service-${testRunId}-${++testCounter}@example.com`;
}

async function seedAccount(currency = 'USD') {
  const [user] = await db
    .insert(users)
    .values({ email: uniqueEmail(), passwordHash: 'x'.repeat(60) })
    .returning();
  const [account] = await db
    .insert(accounts)
    .values({ userId: user!.id, name: 'Flex Fetch Account', currency })
    .returning();
  return { userId: user!.id, accountId: account!.id };
}

async function connectionRow(accountId: string) {
  const [row] = await db
    .select()
    .from(ibkrFlexConnections)
    .where(eq(ibkrFlexConnections.accountId, accountId));
  return row;
}

async function stagedCountForUser(userId: string): Promise<number> {
  const rows = await db
    .select({ id: csvImportStaging.id })
    .from(csvImportStaging)
    .where(eq(csvImportStaging.userId, userId));
  return rows.length;
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
    .onConflictDoUpdate({ target: csvImportCounters.userId, set: { committedCount: count } });
}

// --- IBKR Flex response-building helpers (flex.client.test.ts precedent) ---

const ENCODER = new TextEncoder();

function bytesOf(text: string): Uint8Array {
  return ENCODER.encode(text);
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function httpResponse(init: { status: number; ok?: boolean; bytes?: Uint8Array }): Response {
  return {
    ok: init.ok ?? (init.status >= 200 && init.status < 300),
    status: init.status,
    body: streamOf(init.bytes ?? bytesOf('')),
  } as unknown as Response;
}

function envelopeResponse(opts: { referenceCode?: string; errorCode?: number }): Response {
  const parts = ['<FlexStatementResponse timestamp="now">'];
  parts.push(`<Status>${opts.referenceCode ? 'Success' : 'Fail'}</Status>`);
  if (opts.referenceCode) parts.push(`<ReferenceCode>${opts.referenceCode}</ReferenceCode>`);
  if (opts.errorCode !== undefined) parts.push(`<ErrorCode>${opts.errorCode}</ErrorCode>`);
  parts.push('</FlexStatementResponse>');
  return httpResponse({ status: 200, bytes: bytesOf(parts.join('')) });
}

function reportResponse(content: string | Uint8Array): Response {
  return httpResponse({
    status: 200,
    bytes: typeof content === 'string' ? bytesOf(content) : content,
  });
}

function fetchImplOf(...responses: Response[]): ReturnType<typeof vi.fn> {
  const mock = vi.fn();
  for (const res of responses) mock.mockResolvedValueOnce(res);
  return mock;
}

function instantClock() {
  return { sleep: vi.fn(async () => {}), now: () => 0 };
}

function refusingFetchImpl(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    throw new Error('must not call IBKR on this path');
  });
}

function flexCsv(rows: string[]): string {
  return [
    'ClientAccountID,Symbol,AssetClass,Buy/Sell,Quantity,TradePrice,IBCommission,Multiplier,DateTime,Notes/Codes',
    ...rows,
  ].join('\n');
}

const HAPPY_ROWS = [
  'U1234567,AAPL,STK,BUY,100,121.50,-1.00,1,"2026-01-05;09:30:00",',
  'U1234567,AAPL,STK,SELL,-100,123.10,-1.00,1,"2026-01-05;15:55:00",',
];

describe('fetchAndPreview — happy path (T1, Req 2.3/3.1/7.1)', () => {
  it('returns a token the existing commit imports, and records the fetch time and trade-date span', async () => {
    const { userId, accountId } = await seedAccount();
    await saveConnection(db, userId, accountId, {
      token: 'happy-token-value',
      queryId: 'happy-query',
    });
    const fetchImpl = fetchImplOf(
      envelopeResponse({ referenceCode: 'REF-1' }),
      reportResponse(flexCsv(HAPPY_ROWS)),
    );

    const preview = await fetchAndPreview(db, userId, accountId, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...instantClock(),
    });
    expect(typeof preview.token).toBe('string');
    expect(preview.token.length).toBeGreaterThan(0);

    const committed = await commitImport(db, userId, preview.token, false, { isAdmin: false });
    expect(committed.positionsCreated).toBe(1);
    expect(committed.fillsCreated).toBe(2);

    const row = await connectionRow(accountId);
    expect(row!.lastFetchedAt).not.toBeNull();
    expect(row!.lastPeriodStart).toBe('2026-01-05');
    expect(row!.lastPeriodEnd).toBe('2026-01-05');
  });
});

describe("fetchAndPreview — no connection or another user's gives 404 (T2/T3, Req 5.7)", () => {
  it('rejects 404 NOT_FOUND when the account has no connection', async () => {
    const { userId, accountId } = await seedAccount();
    const fetchImpl = refusingFetchImpl();

    await expect(
      fetchAndPreview(db, userId, accountId, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it("rejects 404 NOT_FOUND for another user's connected account", async () => {
    const owner = await seedAccount();
    await saveConnection(db, owner.userId, owner.accountId, {
      token: 'owner-token-value',
      queryId: 'owner-query',
    });
    const attacker = await seedAccount();
    const fetchImpl = refusingFetchImpl();

    await expect(
      fetchAndPreview(db, attacker.userId, owner.accountId, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });
});

describe('fetchAndPreview — undecryptable connection (T4, Req 4.1)', () => {
  it('rejects 409 IBKR_CONNECTION_UNREADABLE', async () => {
    const { userId, accountId } = await seedAccount();
    await db.insert(ibkrFlexConnections).values({
      userId,
      accountId,
      encryptedToken: 'not-a-valid-envelope',
      encryptedQueryId: encrypt('some-query-id'),
      keyVersion: ENCRYPTION_KEY_VERSION_CURRENT,
      tokenHintTail: 'xxxx',
    });
    const fetchImpl = refusingFetchImpl();

    await expect(
      fetchAndPreview(db, userId, accountId, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'IBKR_CONNECTION_UNREADABLE' });
  });
});

describe('fetchAndPreview — a parse failure gives IBKR_FLEX_UNAVAILABLE (T5)', () => {
  it('rejects 503 IBKR_FLEX_UNAVAILABLE when the report bytes are not valid UTF-8', async () => {
    const { userId, accountId } = await seedAccount();
    await saveConnection(db, userId, accountId, {
      token: 'bad-utf8-token',
      queryId: 'bad-utf8-query',
    });
    const fetchImpl = fetchImplOf(
      envelopeResponse({ referenceCode: 'REF-1' }),
      reportResponse(new Uint8Array([0xff, 0xfe, 0xfd, 0xfc])),
    );

    await expect(
      fetchAndPreview(db, userId, accountId, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ...instantClock(),
      }),
    ).rejects.toMatchObject({ statusCode: 503, code: 'IBKR_FLEX_UNAVAILABLE' });
  });
});

describe('fetchAndPreview — zero rows (T6, Req 2.7/7.1)', () => {
  it('rejects 422 IBKR_FLEX_NO_TRADES, records the fetch time with a null span', async () => {
    const { userId, accountId } = await seedAccount();
    await saveConnection(db, userId, accountId, {
      token: 'no-trades-token',
      queryId: 'no-trades-query',
    });
    const fetchImpl = fetchImplOf(
      envelopeResponse({ referenceCode: 'REF-1' }),
      reportResponse(flexCsv([])),
    );

    await expect(
      fetchAndPreview(db, userId, accountId, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ...instantClock(),
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'IBKR_FLEX_NO_TRADES' });

    const row = await connectionRow(accountId);
    expect(row!.lastFetchedAt).not.toBeNull();
    expect(row!.lastPeriodStart).toBeNull();
    expect(row!.lastPeriodEnd).toBeNull();
  });
});

describe('fetchAndPreview — account refusals stage nothing (T7/T8, Req 2.8)', () => {
  it('rejects 422 IBKR_FLEX_ACCOUNT_UNPROVEN and stages nothing when the account column is absent', async () => {
    const { userId, accountId } = await seedAccount();
    await saveConnection(db, userId, accountId, { token: 'no-col-token', queryId: 'no-col-query' });
    const csv = [
      'Symbol,AssetClass,Buy/Sell,Quantity,TradePrice,IBCommission,Multiplier,DateTime,Notes/Codes',
      'AAPL,STK,BUY,100,121.50,-1.00,1,"2026-01-05;09:30:00",',
      'AAPL,STK,SELL,-100,123.10,-1.00,1,"2026-01-05;15:55:00",',
    ].join('\n');
    const fetchImpl = fetchImplOf(
      envelopeResponse({ referenceCode: 'REF-1' }),
      reportResponse(csv),
    );

    await expect(
      fetchAndPreview(db, userId, accountId, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ...instantClock(),
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'IBKR_FLEX_ACCOUNT_UNPROVEN' });

    expect(await stagedCountForUser(userId)).toBe(0);
  });

  it('rejects 422 IBKR_FLEX_ACCOUNT_UNPROVEN and stages nothing when the report names two accounts', async () => {
    const { userId, accountId } = await seedAccount();
    await saveConnection(db, userId, accountId, {
      token: 'two-acct-token',
      queryId: 'two-acct-query',
    });
    const csv = flexCsv([
      'U1111111,AAPL,STK,BUY,100,121.50,-1.00,1,"2026-01-05;09:30:00",',
      'U2222222,AAPL,STK,SELL,-100,123.10,-1.00,1,"2026-01-05;15:55:00",',
    ]);
    const fetchImpl = fetchImplOf(
      envelopeResponse({ referenceCode: 'REF-1' }),
      reportResponse(csv),
    );

    await expect(
      fetchAndPreview(db, userId, accountId, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ...instantClock(),
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'IBKR_FLEX_ACCOUNT_UNPROVEN' });

    expect(await stagedCountForUser(userId)).toBe(0);
  });
});

describe('fetchAndPreview — a failed fetch leaves the record alone (T9, Req 4.2/7.3, NFR Reliability)', () => {
  it('rejects, leaves the prior fetch record unchanged, and stages nothing', async () => {
    const { userId, accountId } = await seedAccount();
    await saveConnection(db, userId, accountId, {
      token: 'will-fail-token',
      queryId: 'will-fail-query',
    });
    const existing = await connectionRow(accountId);
    const priorRecord = {
      fetchedAt: new Date('2025-06-01T00:00:00.000Z'),
      periodStart: '2025-05-01',
      periodEnd: '2025-05-02',
    };
    await recordFetch(db, existing!.id, priorRecord);

    const fetchImpl = fetchImplOf(envelopeResponse({ errorCode: 1011 })); // token rejected, terminal

    await expect(
      fetchAndPreview(db, userId, accountId, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ...instantClock(),
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'IBKR_FLEX_TOKEN_REJECTED' });

    const row = await connectionRow(accountId);
    expect(row!.lastFetchedAt!.toISOString()).toBe(priorRecord.fetchedAt.toISOString());
    expect(row!.lastPeriodStart).toBe(priorRecord.periodStart);
    expect(row!.lastPeriodEnd).toBe(priorRecord.periodEnd);
    expect(await stagedCountForUser(userId)).toBe(0);
  });
});

describe('fetchAndPreview — recordFetch after a mid-fetch replace is a no-op (T10, design C1)', () => {
  it("leaves the replaced connection's last-fetch fields null", async () => {
    const { userId, accountId } = await seedAccount();
    await saveConnection(db, userId, accountId, {
      token: 'orig-token-value',
      queryId: 'orig-query',
    });
    const before = await connectionRow(accountId);
    const oldId = before!.id;

    let replaced = false;
    const sleep = vi.fn(async () => {
      if (!replaced) {
        replaced = true;
        await saveConnection(db, userId, accountId, {
          token: 'replaced-token-value',
          queryId: 'replaced-query',
        });
      }
    });
    const fetchImpl = fetchImplOf(
      envelopeResponse({ referenceCode: 'REF-1' }),
      reportResponse(flexCsv(HAPPY_ROWS)),
    );

    const preview = await fetchAndPreview(db, userId, accountId, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      now: () => 0,
    });
    expect(typeof preview.token).toBe('string');

    const after = await connectionRow(accountId);
    expect(after!.id).not.toBe(oldId);
    expect(after!.lastFetchedAt).toBeNull();
    expect(after!.lastPeriodStart).toBeNull();
  });
});

describe('fetchAndPreview — a report missing Multiplier (T11, Req 2.9, invariant)', () => {
  it('shows row-0 MAPPING_COLUMN_ABSENT and is not committable', async () => {
    const { userId, accountId } = await seedAccount();
    await saveConnection(db, userId, accountId, {
      token: 'no-mult-token',
      queryId: 'no-mult-query',
    });
    const csv = [
      'ClientAccountID,Symbol,AssetClass,Buy/Sell,Quantity,TradePrice,IBCommission,DateTime,Notes/Codes',
      'U1234567,AAPL,STK,BUY,100,121.50,-1.00,"2026-01-05;09:30:00",',
      'U1234567,AAPL,STK,SELL,-100,123.10,-1.00,"2026-01-05;15:55:00",',
    ].join('\n');
    const fetchImpl = fetchImplOf(
      envelopeResponse({ referenceCode: 'REF-1' }),
      reportResponse(csv),
    );

    const preview = await fetchAndPreview(db, userId, accountId, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...instantClock(),
    });

    expect(preview.committable).toBe(false);
    const err = preview.errors.find((e: LocatedError) => e.code === 'MAPPING_COLUMN_ABSENT');
    expect(err).toBeDefined();
    expect(err?.rowNumber).toBe(0);
  });
});

describe('fetchAndPreview — a bad date row (T12, Req 2.10, invariant)', () => {
  it('shows DATE_UNPARSEABLE', async () => {
    const { userId, accountId } = await seedAccount();
    await saveConnection(db, userId, accountId, {
      token: 'bad-date-token',
      queryId: 'bad-date-query',
    });
    const csv = flexCsv([
      'U1234567,AAPL,STK,BUY,100,121.50,-1.00,1,"2026-01-05;09:30:00",',
      'U1234567,AAPL,STK,SELL,-100,123.10,-1.00,1,"20260105;155500",',
    ]);
    const fetchImpl = fetchImplOf(
      envelopeResponse({ referenceCode: 'REF-1' }),
      reportResponse(csv),
    );

    const preview = await fetchAndPreview(db, userId, accountId, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...instantClock(),
    });

    const err = preview.errors.find((e: LocatedError) => e.code === 'DATE_UNPARSEABLE');
    expect(err).toBeDefined();
  });
});

describe('fetchAndPreview — a repeat fetch of one period (T13, Req 3.2, invariant)', () => {
  it('sets the affirmation; the commit refuses until affirmed', async () => {
    const { userId, accountId } = await seedAccount();
    await saveConnection(db, userId, accountId, { token: 'repeat-token', queryId: 'repeat-query' });

    const firstPreview = await fetchAndPreview(db, userId, accountId, {
      fetchImpl: fetchImplOf(
        envelopeResponse({ referenceCode: 'REF-1' }),
        reportResponse(flexCsv(HAPPY_ROWS)),
      ) as unknown as typeof fetch,
      ...instantClock(),
    });
    await commitImport(db, userId, firstPreview.token, false, { isAdmin: false });

    const secondPreview = await fetchAndPreview(db, userId, accountId, {
      fetchImpl: fetchImplOf(
        envelopeResponse({ referenceCode: 'REF-2' }),
        reportResponse(flexCsv(HAPPY_ROWS)),
      ) as unknown as typeof fetch,
      ...instantClock(),
    });
    expect(secondPreview.requiresDuplicateAffirmation).toBe(true);

    await expect(
      commitImport(db, userId, secondPreview.token, false, { isAdmin: false }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CSV_IMPORT_DUPLICATES_UNCONFIRMED' });

    const affirmed = await commitImport(db, userId, secondPreview.token, true, { isAdmin: false });
    expect(affirmed.positionsCreated).toBe(1);
  });
});

describe('fetchAndPreview — allowance accounting (T14, Req 3.5, invariant)', () => {
  it('a preview draws none; the commit draws one', async () => {
    const { userId, accountId } = await seedAccount();
    await saveConnection(db, userId, accountId, {
      token: 'allowance-token',
      queryId: 'allowance-query',
    });

    const preview = await fetchAndPreview(db, userId, accountId, {
      fetchImpl: fetchImplOf(
        envelopeResponse({ referenceCode: 'REF-1' }),
        reportResponse(flexCsv(HAPPY_ROWS)),
      ) as unknown as typeof fetch,
      ...instantClock(),
    });
    expect(await getCommittedCount(userId)).toBe(0);

    await commitImport(db, userId, preview.token, false, { isAdmin: false });
    expect(await getCommittedCount(userId)).toBe(1);
  });
});

describe('fetchAndPreview — a plan refusal leaves the preview re-committable (T15, Req 3.6, invariant)', () => {
  const prevGating = config.FEATURE_GATING;
  afterEach(() => {
    config.FEATURE_GATING = prevGating;
  });

  it('refuses the commit at the Free cap, then the SAME token commits once the cap is lifted', async () => {
    const { userId, accountId } = await seedAccount();
    await saveConnection(db, userId, accountId, {
      token: 'plan-refusal-token',
      queryId: 'plan-refusal-query',
    });
    const freeCap = getTierLimits('free').csvImports!;
    await setCommittedCount(userId, freeCap);
    config.FEATURE_GATING = true;

    const preview = await fetchAndPreview(db, userId, accountId, {
      fetchImpl: fetchImplOf(
        envelopeResponse({ referenceCode: 'REF-1' }),
        reportResponse(flexCsv(HAPPY_ROWS)),
      ) as unknown as typeof fetch,
      ...instantClock(),
    });

    await expect(
      commitImport(db, userId, preview.token, false, { isAdmin: false }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'TIER_LIMIT_CSV_IMPORTS' });

    await setCommittedCount(userId, 0);
    const committed = await commitImport(db, userId, preview.token, false, { isAdmin: false });
    expect(committed.positionsCreated).toBe(1);
  });
});

describe('fetchAndPreview — an over-cap report (T16, Req 2.6)', () => {
  it('rejects 413 PAYLOAD_TOO_LARGE', async () => {
    const { userId, accountId } = await seedAccount();
    await saveConnection(db, userId, accountId, {
      token: 'over-cap-token',
      queryId: 'over-cap-query',
    });
    const prevCap = config.CSV_IMPORT_MAX_FILE_BYTES;
    config.CSV_IMPORT_MAX_FILE_BYTES = 10;
    try {
      const fetchImpl = fetchImplOf(
        envelopeResponse({ referenceCode: 'REF-1' }),
        reportResponse('x'.repeat(50)),
      );

      await expect(
        fetchAndPreview(db, userId, accountId, {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          ...instantClock(),
        }),
      ).rejects.toMatchObject({ statusCode: 413, code: 'PAYLOAD_TOO_LARGE' });
    } finally {
      config.CSV_IMPORT_MAX_FILE_BYTES = prevCap;
    }
  });
});

describe('fetchAndPreview — a live commit holds the staging slot (T17)', () => {
  it('rejects 409 CSV_IMPORT_IN_PROGRESS', async () => {
    const { userId, accountId } = await seedAccount();
    await saveConnection(db, userId, accountId, {
      token: 'in-progress-token',
      queryId: 'in-progress-query',
    });

    const firstPreview = await fetchAndPreview(db, userId, accountId, {
      fetchImpl: fetchImplOf(
        envelopeResponse({ referenceCode: 'REF-1' }),
        reportResponse(flexCsv(HAPPY_ROWS)),
      ) as unknown as typeof fetch,
      ...instantClock(),
    });
    await db
      .update(csvImportStaging)
      .set({ status: 'committing', claimedAt: new Date() })
      .where(eq(csvImportStaging.id, firstPreview.token));

    await expect(
      fetchAndPreview(db, userId, accountId, {
        fetchImpl: fetchImplOf(
          envelopeResponse({ referenceCode: 'REF-2' }),
          reportResponse(flexCsv(HAPPY_ROWS)),
        ) as unknown as typeof fetch,
        ...instantClock(),
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CSV_IMPORT_IN_PROGRESS' });
  });
});

describe('fetchAndPreview — formula-prefixed cells are neutralized (T18, NFR Security, invariant)', () => {
  it("neutralizes a symbol cell starting with '='", async () => {
    const { userId, accountId } = await seedAccount();
    await saveConnection(db, userId, accountId, {
      token: 'neutralize-token',
      queryId: 'neutralize-query',
    });
    const csv = flexCsv([
      'U1234567,=CMD,STK,BUY,100,121.50,-1.00,1,"2026-01-05;09:30:00",',
      'U1234567,=CMD,STK,SELL,-100,123.10,-1.00,1,"2026-01-05;15:55:00",',
    ]);
    const fetchImpl = fetchImplOf(
      envelopeResponse({ referenceCode: 'REF-1' }),
      reportResponse(csv),
    );

    const preview = await fetchAndPreview(db, userId, accountId, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...instantClock(),
    });

    expect(preview.positions[0]!.scope.symbol.startsWith("'=")).toBe(true);
  });
});

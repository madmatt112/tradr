import { describe, it, expect } from 'vitest';

import app from '@/app';
import { config } from '@/lib/config';

import { readBodyCapped } from './csv-import.upload';

// ---------------------------------------------------------------------------
// Preview-path integration tests (design Testing Strategy → Integration, preview
// half). Drives POST /api/csv-import/preview through Hono `app.request` against a
// real Postgres (no DB mocks; per-test transaction-rollback isolation from
// test-setup.ts). Mirrors the positions.test.ts real-PG harness: register →
// session cookie → create account → authed requests.
// ---------------------------------------------------------------------------

let testCounter = 0;
function uniqueEmail() {
  return `csv-preview-${Date.now()}-${++testCounter}@example.com`;
}

let ipCounter = 0;
function uniqueIp() {
  return `10.88.${Math.floor(++ipCounter / 256)}.${ipCounter % 256}`;
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

/** A minimal valid execution-shape request (matches the service-test mapping). */
function execRequest(accountId: string, mappingOverride?: Record<string, string>) {
  return {
    accountId,
    rowShape: 'execution',
    mapping: {
      rowShape: 'execution',
      columns: mappingOverride ?? {
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
async function postPreview(
  cookie: string,
  csv: string,
  request: unknown,
  requestPartOverride?: string,
): Promise<Response> {
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'trades.csv');
  form.append('request', requestPartOverride ?? JSON.stringify(request));
  return app.request('/api/csv-import/preview', {
    method: 'POST',
    headers: {
      Cookie: `session=${cookie}`,
      'X-Forwarded-For': uniqueIp(),
    },
    body: form,
  });
}

const CLEAN_CSV = [
  'Symbol,Type,Side,Price,Quantity,Date,Fees',
  'AAPL,STOCK,BUY,100,10,2026-01-01,1',
  'AAPL,STOCK,SELL,110,10,2026-01-02,1',
].join('\n');

describe('POST /api/csv-import/preview — classification', () => {
  it('returns 200 with a token + committable clean preview, mints a fresh token on re-preview (supersession)', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);

    const res = await postPreview(cookie, CLEAN_CSV, execRequest(accountId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.committable).toBe(true);
    expect(body.errors).toHaveLength(0);
    expect(body.summary.positions).toBe(1);
    expect(body.summary.fills).toBe(2);
    expect(typeof body.token).toBe('string');

    // Re-preview supersedes: a new token is minted (one active staged per user).
    const res2 = await postPreview(cookie, CLEAN_CSV, execRequest(accountId));
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.token).not.toBe(body.token);
  });

  it('classifies a crossing-flat segment as blocking → non-committable', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      'AAPL,STOCK,BUY,100,10,2026-01-01,0',
      'AAPL,STOCK,SELL,110,15,2026-01-02,0', // exit exceeds open → crossing flat
    ].join('\n');

    const res = await postPreview(cookie, csv, execRequest(accountId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.committable).toBe(false);
    expect(body.errors.some((e: { code: string }) => e.code === 'SEGMENT_CROSSES_FLAT')).toBe(true);
  });

  it('rejects option rows with a blocking per-row error (options unsupported)', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      'AAPL,OPTION,BUY,1,1,2026-01-01,0',
      'AAPL,OPTION,SELL,2,1,2026-01-02,0',
    ].join('\n');

    const res = await postPreview(cookie, csv, execRequest(accountId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.committable).toBe(false);
    expect(body.errors.some((e: { code: string }) => e.code === 'OPTIONS_NOT_SUPPORTED')).toBe(
      true,
    );
  });
});

describe('POST /api/csv-import/preview — warnings & caps', () => {
  it('emits a no_fees_column warning when no fees column is mapped (REQ-10.2)', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date',
      'AAPL,STOCK,BUY,100,10,2026-01-01',
      'AAPL,STOCK,SELL,110,10,2026-01-02',
    ].join('\n');
    const req = execRequest(accountId, {
      symbol: 'Symbol',
      assetType: 'Type',
      action: 'Side',
      price: 'Price',
      quantity: 'Quantity',
      filledAt: 'Date',
    });

    const res = await postPreview(cookie, csv, req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings.some((w: { kind: string }) => w.kind === 'no_fees_column')).toBe(true);
  });

  it('emits a currency_hint_mismatch warning when the CSV currency differs from the account (REQ-7.3)', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie, 'USD');
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees,Currency',
      'AAPL,STOCK,BUY,100,10,2026-01-01,0,EUR',
      'AAPL,STOCK,SELL,110,10,2026-01-02,0,EUR',
    ].join('\n');

    const res = await postPreview(cookie, csv, execRequest(accountId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warnings.some((w: { kind: string }) => w.kind === 'currency_hint_mismatch')).toBe(
      true,
    );
  });

  it('caps the error list at 1000 with a TRUNCATED sentinel (REQ-11.4)', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    const lines = ['Symbol,Type,Side,Price,Quantity,Date,Fees'];
    for (let i = 0; i < 1200; i++) {
      lines.push('AAPL,STOCK,BUY,notanumber,10,2026-01-01,0');
    }

    const res = await postPreview(cookie, lines.join('\n'), execRequest(accountId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.errors).toHaveLength(1001); // 1000 + the truncation sentinel
    expect(body.errors[1000].code).toBe('TRUNCATED');
    expect(body.committable).toBe(false);
  });

  it('reflects neutralizeCsvCell neutralization in the returned payload', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      '=CMD,STOCK,BUY,100,10,2026-01-01,0',
      '=CMD,STOCK,SELL,110,10,2026-01-02,0',
    ].join('\n');

    const res = await postPreview(cookie, csv, execRequest(accountId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.positions[0].scope.symbol.startsWith("'=")).toBe(true);
  });
});

describe('POST /api/csv-import/preview — duplicate scan (date-windowed)', () => {
  it('blocks with requiresDuplicateAffirmation when overlap ≥ 90%', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);

    // Commit a first import so the account has the same fills the second file
    // re-imports (≥90% overlap → blocking affirmation gate).
    const first = await postPreview(cookie, CLEAN_CSV, execRequest(accountId));
    const firstBody = await first.json();
    const commit = await app.request('/api/csv-import/commit', {
      method: 'POST',
      headers: {
        Cookie: `session=${cookie}`,
        'Content-Type': 'application/json',
        'X-Forwarded-For': uniqueIp(),
      },
      body: JSON.stringify({ token: firstBody.token }),
    });
    expect(commit.status).toBe(200);

    const res = await postPreview(cookie, CLEAN_CSV, execRequest(accountId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requiresDuplicateAffirmation).toBe(true);
    expect(body.committable).toBe(true); // affirmation gate, not a hard block
  });

  it('surfaces a sub-90% timestamp-drift overlap as per-fill partial_duplicate warnings (MF-A residual)', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);

    // Seed one matching round-trip in the account (2 fills on 01-01/01-02).
    const seed = await postPreview(cookie, CLEAN_CSV, execRequest(accountId));
    const seedBody = await seed.json();
    const commit = await app.request('/api/csv-import/commit', {
      method: 'POST',
      headers: {
        Cookie: `session=${cookie}`,
        'Content-Type': 'application/json',
        'X-Forwarded-For': uniqueIp(),
      },
      body: JSON.stringify({ token: seedBody.token }),
    });
    expect(commit.status).toBe(200);

    // Re-import a file whose first two fills match the seed but with 4 extra
    // non-matching fills → overlap 2/6 ≈ 33% (< 90%): warnings, not a block.
    const csv = [
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      'AAPL,STOCK,BUY,100,10,2026-01-01,1', // matches seed
      'AAPL,STOCK,SELL,110,10,2026-01-02,1', // matches seed
      'MSFT,STOCK,BUY,50,5,2026-01-03,0',
      'MSFT,STOCK,SELL,60,5,2026-01-04,0',
      'TSLA,STOCK,BUY,200,3,2026-01-05,0',
      'TSLA,STOCK,SELL,210,3,2026-01-06,0',
    ].join('\n');

    const res = await postPreview(cookie, csv, execRequest(accountId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requiresDuplicateAffirmation).toBe(false);
    expect(body.warnings.some((w: { kind: string }) => w.kind === 'partial_duplicate')).toBe(true);
  });
});

describe('POST /api/csv-import/preview — ingress guards', () => {
  it('rejects a request with no rows mapped / empty file with a 4xx, never 500', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    // Header only → no importable rows.
    const res = await postPreview(
      cookie,
      'Symbol,Type,Side,Price,Quantity,Date,Fees',
      execRequest(accountId),
    );
    expect([400, 413]).toContain(res.status);
    const body = await res.json();
    expect(body.error.code).toBe('CSV_NO_ROWS');
  });

  it('rejects an oversized `request` part → 400 CSV_IMPORT_REQUEST_TOO_LARGE (SF-A)', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    // A valid request JSON padded past CSV_IMPORT_MAX_REQUEST_BYTES via a giant
    // unknown field (the schema is non-strict, so the JSON still parses/validates
    // after the size gate — but the size gate trips first).
    const fat = JSON.stringify({
      ...execRequest(accountId),
      _pad: 'x'.repeat(config.CSV_IMPORT_MAX_REQUEST_BYTES + 100),
    });
    const res = await postPreview(cookie, CLEAN_CSV, undefined, fat);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('CSV_IMPORT_REQUEST_TOO_LARGE');
  });

  it('rejects a row-cap overflow → 413 CSV_IMPORT_TOO_MANY_ROWS (REQ-11.1)', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    const lines = ['Symbol,Type,Side,Price,Quantity,Date,Fees'];
    const over = config.CSV_IMPORT_MAX_ROWS + 1;
    for (let i = 0; i < over; i++) {
      lines.push('AAPL,STOCK,BUY,100,1,2026-01-01,0');
    }

    const res = await postPreview(cookie, lines.join('\n'), execRequest(accountId));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error.code).toBe('CSV_IMPORT_TOO_MANY_ROWS');
  });

  it('rejects a staged result over CSV_IMPORT_MAX_STAGED_BYTES → 413 CSV_IMPORT_RESULT_TOO_LARGE', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);
    // The staged-byte cap (24 MiB) is larger than any payload achievable under
    // the 10k row cap + 1000-entry response caps, so it is unreachable with the
    // production default through this route. Temporarily lower the cap so a
    // normal clean preview's staged payload exceeds it — exercising the route's
    // exact RESULT_TOO_LARGE branch (config is read at call time, line 274).
    const original = config.CSV_IMPORT_MAX_STAGED_BYTES;
    config.CSV_IMPORT_MAX_STAGED_BYTES = 32; // smaller than any real staged JSONB
    try {
      const res = await postPreview(cookie, CLEAN_CSV, execRequest(accountId));
      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error.code).toBe('CSV_IMPORT_RESULT_TOO_LARGE');
    } finally {
      config.CSV_IMPORT_MAX_STAGED_BYTES = original;
    }
  });

  it('returns 409 CSV_IMPORT_IN_PROGRESS when a preview is attempted while an import is committing (SF-C)', async () => {
    const cookie = await registerAndGetCookie();
    const accountId = await createAccount(cookie);

    // Stage a preview, then force its row into the durable `committing` state so
    // the widened one-active-per-user unique index rejects a new preview insert.
    const staged = await postPreview(cookie, CLEAN_CSV, execRequest(accountId));
    const stagedBody = await staged.json();

    // Flip the staged row to `committing` via the same test transaction `db`.
    const { db } = await import('@/db');
    const { csvImportStaging } = await import('@/db/schema/csv-import.schema');
    const { eq } = await import('drizzle-orm');
    await db
      .update(csvImportStaging)
      .set({ status: 'committing', claimedAt: new Date() })
      .where(eq(csvImportStaging.id, stagedBody.token));

    const res = await postPreview(cookie, CLEAN_CSV, execRequest(accountId));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CSV_IMPORT_IN_PROGRESS');
  });
});

// ---------------------------------------------------------------------------
// Deceptive Content-Length → 413 off the raw-body byte cap (REQ-1.6).
//
// `app.request` accepts a Request object; we craft one whose streamed body
// exceeds CSV_IMPORT_MAX_FILE_BYTES while advertising a small Content-Length.
// The handler reads `c.req.raw.body.getReader()` and tallies ACTUAL bytes, so
// the under-stated Content-Length cannot bypass the cap. If the runtime strips
// the body stream off a hand-built streaming Request (some undici builds do not
// surface a duplex request body to a sync handler), we fall back to exercising
// the exact same guard directly — the faithful equivalent the task permits.
// ---------------------------------------------------------------------------
describe('POST /api/csv-import/preview — deceptive Content-Length (REQ-1.6)', () => {
  const CAP = config.CSV_IMPORT_MAX_FILE_BYTES;

  /** A lazy stream emitting `total` bytes in chunks (bounded memory). */
  function byteStream(total: number, chunkSize = 64 * 1024): ReadableStream<Uint8Array> {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) {
          controller.close();
          return;
        }
        const size = Math.min(chunkSize, total - sent);
        controller.enqueue(new Uint8Array(size));
        sent += size;
      },
    });
  }

  it('returns 413 PAYLOAD_TOO_LARGE for an over-cap body even with an understated Content-Length', async () => {
    const cookie = await registerAndGetCookie();

    const overCapStream = byteStream(CAP + 64 * 1024);
    let routed: Response | null = null;
    try {
      const req = new Request('http://local/api/csv-import/preview', {
        method: 'POST',
        headers: {
          Cookie: `session=${cookie}`,
          'X-Forwarded-For': uniqueIp(),
          'Content-Type': 'multipart/form-data; boundary=deceptive',
          // Deceptive: advertises far fewer bytes than the body streams.
          'Content-Length': '128',
        },
        body: overCapStream,
        // Required for a streaming request body in undici/Node.
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });

      routed = await app.request(req);
    } catch {
      routed = null;
    }

    if (routed) {
      // Full-path faithful assertion: the route's byte cap fired despite the
      // tiny Content-Length.
      expect(routed.status).toBe(413);
      const body = await routed.json();
      expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
    } else {
      // Runtime did not surface the streaming body to the handler; exercise the
      // identical guard directly (same code path the route awaits). The reader
      // never sees Content-Length, so an over-cap stream still 413s.
      await expect(readBodyCapped(byteStream(CAP + 64 * 1024))).rejects.toMatchObject({
        statusCode: 413,
        code: 'PAYLOAD_TOO_LARGE',
      });
    }
  });
});

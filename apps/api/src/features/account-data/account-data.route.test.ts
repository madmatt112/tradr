import { describe, expect, it } from 'vitest';

import app from '@/app';

// The account export/import routes (design C9) end to end through `app.request`,
// each test rolled back by the single-connection harness (test-setup.ts). Nothing
// optional is configured, so object storage is off (inline images) and the
// per-user limiters run on their process-local Map at the real `max` (not the
// Redis-outage fallback). Every test registers its OWN user, so the userId-keyed
// buckets never carry a count across tests.

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `acct-data-route${testRunId}-${++testCounter}@example.com`;
}

let ipCounter = 500;
function uniqueIp() {
  return `10.9.${Math.floor(++ipCounter / 256)}.${ipCounter % 256}`;
}

const PASSWORD = 'password123';
const ZERO_DIGEST = '0'.repeat(64);

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
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() },
    body: JSON.stringify({ email: uniqueEmail(), password: PASSWORD }),
  });
  expect(res.status).toBe(201);
  const cookie = getCookieValue(res, 'session');
  expect(cookie).toBeTruthy();
  return cookie!;
}

async function createAccount(cookie: string): Promise<void> {
  const res = await app.request('/api/accounts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': uniqueIp(),
      Cookie: `session=${cookie}`,
    },
    body: JSON.stringify({ name: 'Export Test', currency: 'USD' }),
  });
  expect(res.status).toBe(201);
}

async function exportArchive(cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { 'X-Forwarded-For': uniqueIp() };
  if (cookie) headers.Cookie = `session=${cookie}`;
  return app.request('/api/account-data/export', { method: 'POST', headers });
}

async function importRequest(path: string, cookie?: string, body?: BodyInit): Promise<Response> {
  const headers: Record<string, string> = { 'X-Forwarded-For': uniqueIp() };
  if (cookie) headers.Cookie = `session=${cookie}`;
  return app.request(path, { method: 'POST', headers, body });
}

describe('account-data routes', () => {
  it('every route is 401 without a session', async () => {
    expect((await exportArchive()).status).toBe(401);
    expect((await importRequest('/api/account-data/import/preview')).status).toBe(401);
    expect((await importRequest(`/api/account-data/import?digest=${ZERO_DIGEST}`)).status).toBe(
      401,
    );
  });

  it('export returns application/zip with a dated filename and zip magic bytes', async () => {
    const cookie = await registerAndGetCookie();
    await createAccount(cookie);

    const res = await exportArchive(cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('attachment');
    expect(disposition).toMatch(/filename="tradr-export-\d{4}-\d{2}-\d{2}\.zip"/);

    const bytes = new Uint8Array(await res.arrayBuffer());
    // Local-file-header magic "PK\x03\x04".
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('rate-limits the sixth export in the window with 429', async () => {
    const cookie = await registerAndGetCookie();
    // Five exports each pass the limiter (200); consuming the body releases the
    // per-process export slot before the next acquire.
    for (let i = 0; i < 5; i++) {
      const res = await exportArchive(cookie);
      expect(res.status).toBe(200);
      await res.arrayBuffer();
    }
    const sixth = await exportArchive(cookie);
    expect(sixth.status).toBe(429);
  });

  it('previews then confirms a round-trip into an empty account', async () => {
    // Source user with one account → a non-empty archive.
    const source = await registerAndGetCookie();
    await createAccount(source);
    const exported = await exportArchive(source);
    expect(exported.status).toBe(200);
    const archive = new Uint8Array(await exported.arrayBuffer());

    // Target user is freshly registered, so it owns no data.
    const target = await registerAndGetCookie();

    const previewRes = await importRequest('/api/account-data/import/preview', target, archive);
    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()) as {
      counts: Record<string, number>;
      digest: string;
    };
    expect(preview.counts.accounts).toBe(1);
    expect(preview.digest).toMatch(/^[0-9a-f]{64}$/);

    const confirmRes = await importRequest(
      `/api/account-data/import?digest=${preview.digest}`,
      target,
      archive,
    );
    expect(confirmRes.status).toBe(200);
    const result = (await confirmRes.json()) as { counts: Record<string, number> };
    expect(result.counts.accounts).toBe(1);
  });

  it('confirm with a missing or non-hex digest is 400 before the body is read', async () => {
    const cookie = await registerAndGetCookie();

    const missing = await importRequest('/api/account-data/import', cookie, new Uint8Array([1]));
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.code).toBe('ARCHIVE_DIGEST_MISMATCH');

    const nonHex = await importRequest(
      '/api/account-data/import?digest=not-a-digest',
      cookie,
      new Uint8Array([1]),
    );
    expect(nonHex.status).toBe(400);
    expect((await nonHex.json()).error.code).toBe('ARCHIVE_DIGEST_MISMATCH');
  });

  it('confirm with a well-formed but wrong digest is 400 ARCHIVE_DIGEST_MISMATCH', async () => {
    const source = await registerAndGetCookie();
    await createAccount(source);
    const exported = await exportArchive(source);
    const archive = new Uint8Array(await exported.arrayBuffer());

    const target = await registerAndGetCookie();
    const res = await importRequest(
      `/api/account-data/import?digest=${ZERO_DIGEST}`,
      target,
      archive,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('ARCHIVE_DIGEST_MISMATCH');
  });
});

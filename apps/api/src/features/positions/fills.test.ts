import { describe, it, expect } from 'vitest';

import app from '@/app';

let emailCounter = 0;
function uniqueEmail() {
  return `fill-test${++emailCounter}-${Date.now()}@example.com`;
}

let ipCounter = 0;
function uniqueIp() {
  const n = ++ipCounter;
  const b = (n >> 8) & 255;
  const c = n & 255;
  return `10.5.${b}.${c || 1}`;
}

function getCookieValue(res: Response, name: string): string | undefined {
  const setCookieHeaders = res.headers.getSetCookie();
  for (const header of setCookieHeaders) {
    const match = header.match(new RegExp(`${name}=([^;]*)`));
    if (match) return match[1];
  }
  return undefined;
}

async function registerAndGetCookie(email = uniqueEmail()): Promise<{ cookie: string }> {
  const res = await app.request('/api/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': uniqueIp(),
    },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  expect(res.status).toBe(201);
  const cookie = getCookieValue(res, 'session')!;
  expect(cookie).toBeDefined();
  return { cookie };
}

function authedRequest(method: string, path: string, cookie: string, body?: unknown) {
  const headers: Record<string, string> = {
    Cookie: `session=${cookie}`,
    'X-Forwarded-For': uniqueIp(),
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  return app.request(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

let acctCounter = 0;
async function createTestAccount(cookie: string) {
  const res = await authedRequest('POST', '/api/accounts', cookie, {
    name: `Fill Test Account ${++acctCounter}-${Date.now()}`,
    currency: 'USD',
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function createDraftPosition(
  cookie: string,
  accountId: string,
  opts?: { assetType?: string },
) {
  const assetType = opts?.assetType ?? 'stock';
  const res = await authedRequest('POST', '/api/positions', cookie, {
    accountId,
    symbol: assetType === 'option' ? 'AAPL260116C150' : 'AAPL',
    side: 'long',
    assetType,
  });
  expect(res.status).toBe(201);
  return res.json();
}

function makeFill(
  overrides?: Partial<{
    type: string;
    price: string;
    quantity: string;
    fees: string;
    filledAt: string;
  }>,
) {
  return {
    type: 'entry',
    price: '150.00',
    quantity: '10',
    fees: '1.00',
    filledAt: '2025-01-15T10:00:00Z',
    ...overrides,
  };
}

async function addFill(cookie: string, positionId: string, fill: ReturnType<typeof makeFill>) {
  const res = await authedRequest('POST', `/api/positions/${positionId}/fills`, cookie, fill);
  expect(res.status).toBe(201);
  return res.json();
}

async function openPos(cookie: string, positionId: string) {
  const res = await authedRequest('POST', `/api/positions/${positionId}/open`, cookie, {});
  expect(res.status).toBe(200);
  return res.json();
}

async function closePos(cookie: string, positionId: string) {
  const res = await authedRequest('POST', `/api/positions/${positionId}/close`, cookie, {});
  expect(res.status).toBe(200);
  return res.json();
}

/** Creates a closed position: draft -> add entry -> open -> add exit -> close */
async function createClosedPosition(cookie: string, accountId: string) {
  const pos = await createDraftPosition(cookie, accountId);
  await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
  await openPos(cookie, pos.id);
  await addFill(cookie, pos.id, makeFill({ type: 'exit', quantity: '10', price: '160.00' }));
  await closePos(cookie, pos.id);
  return pos;
}

describe('fills', () => {
  // 1. Add entry fill to draft — success
  it('adds entry fill to a draft position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);

    const res = await authedRequest('POST', `/api/positions/${pos.id}/fills`, cookie, makeFill());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty('id');
    expect(body.type).toBe('entry');
    expect(Number(body.quantity)).toBe(10);
    expect(body.positionId).toBe(pos.id);
  });

  // 2. Add entry fill to open (scale-in) — success
  it('adds entry fill to an open position (scale-in)', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos.id);

    const res = await authedRequest(
      'POST',
      `/api/positions/${pos.id}/fills`,
      cookie,
      makeFill({ type: 'entry', quantity: '5' }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.type).toBe('entry');
    expect(Number(body.quantity)).toBe(5);
  });

  // 3. Add exit fill to open — success
  it('adds exit fill to an open position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos.id);

    const res = await authedRequest(
      'POST',
      `/api/positions/${pos.id}/fills`,
      cookie,
      makeFill({ type: 'exit', quantity: '5', price: '155.00' }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.type).toBe('exit');
    expect(Number(body.quantity)).toBe(5);
  });

  // 4. Reject exit fill on draft → 409
  it('rejects exit fill on a draft position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));

    const res = await authedRequest(
      'POST',
      `/api/positions/${pos.id}/fills`,
      cookie,
      makeFill({ type: 'exit', quantity: '5' }),
    );
    expect(res.status).toBe(409);
  });

  // 5. Reject exit qty exceeding entry qty → 400
  it('rejects exit fill when quantity exceeds entry quantity', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos.id);

    const res = await authedRequest(
      'POST',
      `/api/positions/${pos.id}/fills`,
      cookie,
      makeFill({ type: 'exit', quantity: '15' }),
    );
    expect(res.status).toBe(400);
  });

  // 6. Reject add fill on closed → 409
  it('rejects adding fill to a closed position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createClosedPosition(cookie, account.id);

    const res = await authedRequest('POST', `/api/positions/${pos.id}/fills`, cookie, makeFill());
    expect(res.status).toBe(409);
  });

  // 7. Update fill price/quantity/fees on open position
  it('updates fill price, quantity, and fees on an open position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const fill = await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos.id);

    const res = await authedRequest('PUT', `/api/positions/${pos.id}/fills/${fill.id}`, cookie, {
      price: '155.00',
      quantity: '12',
      fees: '2.50',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Number(body.price)).toBe(155);
    expect(Number(body.quantity)).toBe(12);
    expect(Number(body.fees)).toBe(2.5);
  });

  // 8. Update non-quantity fields on closed position → should succeed
  it('allows updating price, fees, notes, date on a closed position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const fill = await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos.id);
    await addFill(cookie, pos.id, makeFill({ type: 'exit', quantity: '10', price: '160.00' }));
    await closePos(cookie, pos.id);

    const res = await authedRequest('PUT', `/api/positions/${pos.id}/fills/${fill.id}`, cookie, {
      price: '151.00',
      fees: '0.50',
      notes: 'updated note',
      filledAt: '2025-01-16T12:00:00Z',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Number(body.price)).toBe(151);
    expect(Number(body.fees)).toBe(0.5);
    expect(body.notes).toBe('updated note');
  });

  // 9. Reject quantity-changing update on closed position → 409
  it('rejects quantity change on a closed position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const fill = await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos.id);
    await addFill(cookie, pos.id, makeFill({ type: 'exit', quantity: '10', price: '160.00' }));
    await closePos(cookie, pos.id);

    const res = await authedRequest('PUT', `/api/positions/${pos.id}/fills/${fill.id}`, cookie, {
      quantity: '15',
    });
    expect(res.status).toBe(409);
  });

  // 10. Type change on update is ignored (UpdateFillSchema excludes type)
  it('ignores type field on fill update (stripped by validation)', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const fill = await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos.id);

    // Send type in the body — it should be stripped by schema validation
    const res = await authedRequest('PUT', `/api/positions/${pos.id}/fills/${fill.id}`, cookie, {
      type: 'exit',
      price: '152.00',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Type should still be entry
    expect(body.type).toBe('entry');
    expect(Number(body.price)).toBe(152);
  });

  // 11. Delete fill on open position — success
  it('deletes a fill on an open position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    const fill2 = await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '5' }));
    await openPos(cookie, pos.id);

    const res = await authedRequest('DELETE', `/api/positions/${pos.id}/fills/${fill2.id}`, cookie);
    expect(res.status).toBe(204);
  });

  // 12. Reject delete entry fill with dependent exits → 409
  it('rejects deleting entry fill when it would make entry qty < exit qty', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const entryFill = await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '5' }));
    await openPos(cookie, pos.id);
    await addFill(cookie, pos.id, makeFill({ type: 'exit', quantity: '12' }));

    // Deleting entry of 10 would leave 5 entry vs 12 exit
    const res = await authedRequest(
      'DELETE',
      `/api/positions/${pos.id}/fills/${entryFill.id}`,
      cookie,
    );
    expect(res.status).toBe(409);
  });

  // 13. Reject delete any fill on closed position → 409
  it('rejects deleting a fill on a closed position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const fill = await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos.id);
    await addFill(cookie, pos.id, makeFill({ type: 'exit', quantity: '10', price: '160.00' }));
    await closePos(cookie, pos.id);

    const res = await authedRequest('DELETE', `/api/positions/${pos.id}/fills/${fill.id}`, cookie);
    expect(res.status).toBe(409);
  });

  // 14. Reject delete entry fill that would reduce entry qty to zero on open position → 409
  it('rejects deleting the last entry fill on an open position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const entryFill = await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos.id);

    const res = await authedRequest(
      'DELETE',
      `/api/positions/${pos.id}/fills/${entryFill.id}`,
      cookie,
    );
    expect(res.status).toBe(409);
  });

  // 15. Option integer quantity validation → 400
  it('rejects non-integer quantity for option positions', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id, { assetType: 'option' });

    const res = await authedRequest(
      'POST',
      `/api/positions/${pos.id}/fills`,
      cookie,
      makeFill({ quantity: '1.5' }),
    );
    expect(res.status).toBe(400);
  });

  // 16. Fill not found → 404
  it('returns 404 for non-existent fill', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos.id);

    const fakeFillId = '00000000-0000-0000-0000-000000000000';
    const res = await authedRequest('PUT', `/api/positions/${pos.id}/fills/${fakeFillId}`, cookie, {
      price: '155.00',
    });
    expect(res.status).toBe(404);
  });

  // 17. Fill wrong position returns 404
  it('returns 404 when fill belongs to a different position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos1 = await createDraftPosition(cookie, account.id);
    const pos2 = await createDraftPosition(cookie, account.id);
    const fill1 = await addFill(cookie, pos1.id, makeFill({ type: 'entry', quantity: '10' }));
    await addFill(cookie, pos2.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos1.id);
    await openPos(cookie, pos2.id);

    // Try to update fill1 via pos2's endpoint
    const res = await authedRequest('PUT', `/api/positions/${pos2.id}/fills/${fill1.id}`, cookie, {
      price: '155.00',
    });
    expect(res.status).toBe(404);
  });
});

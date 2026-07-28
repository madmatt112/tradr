import { eq } from 'drizzle-orm';
import { describe, it, expect } from 'vitest';

import app from '@/app';
import { db } from '@/db';
import { accounts, positions } from '@/db/schema';

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `brk-test${testRunId}-${++testCounter}@example.com`;
}

let ipCounter = 200;
function uniqueIp() {
  return `10.2.0.${++ipCounter}`;
}

function getCookieValue(res: Response, name: string): string | undefined {
  const setCookieHeaders = res.headers.getSetCookie();
  for (const header of setCookieHeaders) {
    const match = header.match(new RegExp(`${name}=([^;]*)`));
    if (match) return match[1];
  }
  return undefined;
}

async function registerAndGetCookie(
  email = uniqueEmail(),
): Promise<{ cookie: string; email: string }> {
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
  return { cookie, email };
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

async function getMe(cookie: string) {
  const res = await authedRequest('GET', '/api/auth/me', cookie);
  return res.json();
}

async function createTestBrokerage(cookie: string, name = 'Test Brokerage', notes?: string) {
  const res = await authedRequest('POST', '/api/brokerages', cookie, { name, notes });
  expect(res.status).toBe(201);
  return res.json();
}

async function getSystemBrokerage(cookie: string) {
  const res = await authedRequest('GET', '/api/brokerages', cookie);
  const list = await res.json();
  const system = list.find((b: { isSystem: boolean }) => b.isSystem);
  expect(system).toBeDefined();
  return system;
}

describe('brokerages', () => {
  // 1. Create brokerage — verify 201, name/notes, fee schedule defaults
  it('creates a brokerage with default fee schedule zeros', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/brokerages', cookie, {
      name: 'My Broker',
      notes: 'Some notes',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty('id');
    expect(body.name).toBe('My Broker');
    expect(body.notes).toBe('Some notes');
    expect(body.feeSchedule).toBeDefined();
    expect(body.feeSchedule.stockPerShareCommission).toBe('0');
    expect(body.feeSchedule.stockMinPerFill).toBe('0');
    expect(body.feeSchedule.stockMaxPerFill).toBe('0');
    expect(body.feeSchedule.optionsPerContractCommission).toBe('0');
    expect(body.feeSchedule.optionsPerContractExchangeFee).toBe('0');
    expect(body.feeSchedule.optionsMinPerFill).toBe('0');
    expect(body.feeSchedule.optionsMaxPerFill).toBe('0');
  });

  // 2. List brokerages — returns user brokerages + system brokerages
  it('lists user brokerages and system brokerages', async () => {
    const { cookie } = await registerAndGetCookie();
    await createTestBrokerage(cookie, 'User Broker A');
    await createTestBrokerage(cookie, 'User Broker B');

    const res = await authedRequest('GET', '/api/brokerages', cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    const userBrokerages = body.filter((b: { isSystem: boolean }) => !b.isSystem);
    const systemBrokerages = body.filter((b: { isSystem: boolean }) => b.isSystem);
    expect(userBrokerages.length).toBeGreaterThanOrEqual(2);
    expect(systemBrokerages.length).toBeGreaterThanOrEqual(1);
  });

  // 3. Get brokerage by ID — verify returns brokerage with fee schedule
  it('gets a brokerage by ID with fee schedule', async () => {
    const { cookie } = await registerAndGetCookie();
    const created = await createTestBrokerage(cookie, 'Lookup Broker');

    const res = await authedRequest('GET', `/api/brokerages/${created.id}`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(created.id);
    expect(body.name).toBe('Lookup Broker');
    expect(body.feeSchedule).toBeDefined();
  });

  // 4. Update brokerage name and notes
  it('updates brokerage name and notes', async () => {
    const { cookie } = await registerAndGetCookie();
    const created = await createTestBrokerage(cookie, 'Old Name', 'Old notes');

    const res = await authedRequest('PUT', `/api/brokerages/${created.id}`, cookie, {
      name: 'New Name',
      notes: 'New notes',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('New Name');
    expect(body.notes).toBe('New notes');
  });

  // 5. Update fee schedule
  it('updates fee schedule fields', async () => {
    const { cookie } = await registerAndGetCookie();
    const created = await createTestBrokerage(cookie, 'Fee Broker');

    const res = await authedRequest('PUT', `/api/brokerages/${created.id}`, cookie, {
      feeSchedule: {
        stockPerShareCommission: '0.005',
        stockMinPerFill: '1',
        stockMaxPerFill: '10',
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.feeSchedule.stockPerShareCommission).toBe('0.005');
    expect(body.feeSchedule.stockMinPerFill).toBe('1');
    expect(body.feeSchedule.stockMaxPerFill).toBe('10');
  });

  // 6. Delete brokerage
  it('deletes a brokerage', async () => {
    const { cookie } = await registerAndGetCookie();
    const created = await createTestBrokerage(cookie, 'To Delete');

    const deleteRes = await authedRequest('DELETE', `/api/brokerages/${created.id}`, cookie);
    expect(deleteRes.status).toBe(204);

    const getRes = await authedRequest('GET', `/api/brokerages/${created.id}`, cookie);
    expect(getRes.status).toBe(404);
  });

  // 7. Duplicate name rejection (case-insensitive)
  it('returns 409 for duplicate brokerage name (case-insensitive)', async () => {
    const { cookie } = await registerAndGetCookie();
    await createTestBrokerage(cookie, 'Test');

    const res = await authedRequest('POST', '/api/brokerages', cookie, { name: 'test' });
    expect(res.status).toBe(409);
  });

  // 8. Delete guard — brokerage assigned to account
  it('returns 409 when deleting brokerage assigned to an account', async () => {
    const { cookie } = await registerAndGetCookie();
    const brokerage = await createTestBrokerage(cookie, 'Assigned Broker');

    // Create an account and assign the brokerage via direct DB update
    const accountRes = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Linked Account',
      currency: 'USD',
    });
    expect(accountRes.status).toBe(201);
    const account = await accountRes.json();

    await db.update(accounts).set({ brokerageId: brokerage.id }).where(eq(accounts.id, account.id));

    const deleteRes = await authedRequest('DELETE', `/api/brokerages/${brokerage.id}`, cookie);
    expect(deleteRes.status).toBe(409);
  });

  // 9. System brokerage edit → 403
  it('returns 403 when editing a system brokerage', async () => {
    const { cookie } = await registerAndGetCookie();
    const system = await getSystemBrokerage(cookie);

    const res = await authedRequest('PUT', `/api/brokerages/${system.id}`, cookie, {
      name: 'Hacked',
    });
    expect(res.status).toBe(403);
  });

  // 10. System brokerage delete → 403
  it('returns 403 when deleting a system brokerage', async () => {
    const { cookie } = await registerAndGetCookie();
    const system = await getSystemBrokerage(cookie);

    const res = await authedRequest('DELETE', `/api/brokerages/${system.id}`, cookie);
    expect(res.status).toBe(403);
  });

  // 11. Duplicate system brokerage to user copy
  it('duplicates a system brokerage to a user copy', async () => {
    const { cookie } = await registerAndGetCookie();
    const system = await getSystemBrokerage(cookie);

    const res = await authedRequest('POST', `/api/brokerages/${system.id}/duplicate`, cookie);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.isSystem).toBe(false);
    expect(body.name).toBe(system.name);
    expect(body.feeSchedule).toBeDefined();
  });

  // 12. Position-count endpoint
  it('returns position count for a brokerage', async () => {
    const { cookie } = await registerAndGetCookie();
    const meData = await getMe(cookie);
    const me = meData.user ?? meData;
    const brokerage = await createTestBrokerage(cookie, 'Count Broker');

    // Create an account linked to this brokerage
    const accountRes = await authedRequest('POST', '/api/accounts', cookie, {
      name: 'Count Account',
      currency: 'USD',
    });
    expect(accountRes.status).toBe(201);
    const account = await accountRes.json();

    await db.update(accounts).set({ brokerageId: brokerage.id }).where(eq(accounts.id, account.id));

    // Insert a position directly
    // eslint-disable-next-line no-restricted-syntax -- performance-charts §8.2 audit: status='open' is CHECK-safe
    await db.insert(positions).values({
      userId: me.id,
      accountId: account.id,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'equity',
      status: 'open',
    });

    const res = await authedRequest(
      'GET',
      `/api/brokerages/${brokerage.id}/position-count`,
      cookie,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
  });
});

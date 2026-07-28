import { describe, it, expect } from 'vitest';

import app from '@/app';

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `brk-svc${testRunId}-${++testCounter}@example.com`;
}

let ipCounter = 50;
function uniqueIp() {
  return `10.3.0.${++ipCounter}`;
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

async function createTestBrokerage(cookie: string, name = 'Test Brokerage') {
  const res = await authedRequest('POST', '/api/brokerages', cookie, { name });
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

describe('brokerages service validation', () => {
  // 1. Min/max constraint: min > max (non-zero max) → 400
  it('returns 400 when stockMinPerFill exceeds stockMaxPerFill', async () => {
    const { cookie } = await registerAndGetCookie();
    const brokerage = await createTestBrokerage(cookie, 'Min Max Broker');

    const res = await authedRequest('PUT', `/api/brokerages/${brokerage.id}`, cookie, {
      feeSchedule: {
        stockMinPerFill: '5',
        stockMaxPerFill: '1',
      },
    });
    expect(res.status).toBe(400);
  });

  // 2. Sentinel exemption: max=0 means unlimited, so min=5 max=0 is valid
  it('accepts stockMinPerFill=5 with stockMaxPerFill=0 (sentinel)', async () => {
    const { cookie } = await registerAndGetCookie();
    const brokerage = await createTestBrokerage(cookie, 'Sentinel Broker');

    const res = await authedRequest('PUT', `/api/brokerages/${brokerage.id}`, cookie, {
      feeSchedule: {
        stockMinPerFill: '5',
        stockMaxPerFill: '0',
      },
    });
    expect(res.status).toBe(200);
  });

  // 3. min=0 max=0 → accepted
  it('accepts min=0 max=0', async () => {
    const { cookie } = await registerAndGetCookie();
    const brokerage = await createTestBrokerage(cookie, 'Zero Broker');

    const res = await authedRequest('PUT', `/api/brokerages/${brokerage.id}`, cookie, {
      feeSchedule: {
        stockMinPerFill: '0',
        stockMaxPerFill: '0',
      },
    });
    expect(res.status).toBe(200);
  });

  // 4. System brokerage PUT → 403
  it('returns 403 when updating a system brokerage', async () => {
    const { cookie } = await registerAndGetCookie();
    const system = await getSystemBrokerage(cookie);

    const res = await authedRequest('PUT', `/api/brokerages/${system.id}`, cookie, {
      name: 'Hacked System',
    });
    expect(res.status).toBe(403);
  });

  // 5. System brokerage DELETE → 403
  it('returns 403 when deleting a system brokerage', async () => {
    const { cookie } = await registerAndGetCookie();
    const system = await getSystemBrokerage(cookie);

    const res = await authedRequest('DELETE', `/api/brokerages/${system.id}`, cookie);
    expect(res.status).toBe(403);
  });

  // 6. Cross-user access: user B tries to GET user A's brokerage → 404
  it('returns 404 when user B tries to GET user A brokerage', async () => {
    const { cookie: cookieA } = await registerAndGetCookie();
    const { cookie: cookieB } = await registerAndGetCookie();

    const brokerageA = await createTestBrokerage(cookieA, 'A Private Broker');

    const res = await authedRequest('GET', `/api/brokerages/${brokerageA.id}`, cookieB);
    expect(res.status).toBe(404);
  });

  // 7. Cross-user access: user B tries to PUT user A's brokerage → 404
  it('returns 404 when user B tries to PUT user A brokerage', async () => {
    const { cookie: cookieA } = await registerAndGetCookie();
    const { cookie: cookieB } = await registerAndGetCookie();

    const brokerageA = await createTestBrokerage(cookieA, 'A Private Broker');

    const res = await authedRequest('PUT', `/api/brokerages/${brokerageA.id}`, cookieB, {
      name: 'Hacked',
    });
    expect(res.status).toBe(404);
  });
});

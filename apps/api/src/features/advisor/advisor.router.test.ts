import { describe, expect, it } from 'vitest';

import app from '@/app';

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `advisor-router-test${testRunId}-${++testCounter}@example.com`;
}

let ipCounter = 100;
function uniqueIp() {
  return `10.9.0.${++ipCounter}`;
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
  return getCookieValue(res, 'session')!;
}

describe('advisor router mount', () => {
  it('rejects unauthed GET /api/advisor/_health with 401', async () => {
    const res = await app.request('/api/advisor/_health', {
      method: 'GET',
      headers: { 'X-Forwarded-For': uniqueIp() },
    });
    expect(res.status).toBe(401);
  });

  it('serves authed GET /api/advisor/_health with smoke shape', async () => {
    const cookie = await registerAndGetCookie();
    const res = await app.request('/api/advisor/_health', {
      method: 'GET',
      headers: { Cookie: `session=${cookie}`, 'X-Forwarded-For': uniqueIp() },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, router: 'advisor' });
  });

  it('returns 404 for authed GET on an unknown advisor path', async () => {
    const cookie = await registerAndGetCookie();
    const res = await app.request('/api/advisor/__nonexistent__', {
      method: 'GET',
      headers: { Cookie: `session=${cookie}`, 'X-Forwarded-For': uniqueIp() },
    });
    expect(res.status).toBe(404);
  });
});

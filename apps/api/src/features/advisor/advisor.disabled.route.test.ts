// DISABLE_ADVISOR — the operator posture that withdraws the advisor from an
// instance. The gate sits on the router after auth and before every route, so
// the contract is: anonymous callers still get 401 (the gate is not an
// unauthenticated probe), and every authenticated call under /api/advisor —
// the smoke endpoint, the options-chain viewer, keys, personas, conversations —
// answers 403 ADVISOR_DISABLED. Reads config live, so a direct mutation flips
// it with no restart, exactly as config.test.ts does for DISABLE_REGISTRATION.

import { afterEach, describe, expect, it } from 'vitest';

import app from '@/app';
import { config } from '@/lib/config';

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `advisor-disabled-test${testRunId}-${++testCounter}@example.com`;
}

let ipCounter = 100;
function uniqueIp() {
  return `10.9.1.${++ipCounter}`;
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

async function authedGet(path: string, cookie: string): Promise<Response> {
  return app.request(path, {
    method: 'GET',
    headers: { Cookie: `session=${cookie}`, 'X-Forwarded-For': uniqueIp() },
  });
}

describe('DISABLE_ADVISOR', () => {
  afterEach(() => {
    config.DISABLE_ADVISOR = false;
  });

  it('leaves the advisor served when unset (the default)', async () => {
    const cookie = await registerAndGetCookie();
    const res = await authedGet('/api/advisor/_health', cookie);
    expect(res.status).toBe(200);
  });

  it('still answers 401 to an anonymous caller — the gate is not a probe', async () => {
    config.DISABLE_ADVISOR = true;
    const res = await app.request('/api/advisor/_health', {
      method: 'GET',
      headers: { 'X-Forwarded-For': uniqueIp() },
    });
    expect(res.status).toBe(401);
  });

  it('answers 403 ADVISOR_DISABLED to every authenticated advisor route', async () => {
    config.DISABLE_ADVISOR = true;
    const cookie = await registerAndGetCookie();

    // The smoke endpoint proves the gate precedes every route, not a subset.
    for (const path of [
      '/api/advisor/_health',
      '/api/advisor/options-chain?symbol=SPY',
      '/api/advisor/market-data-key',
      '/api/advisor/conversations',
      '/api/advisor/personas',
    ]) {
      const res = await authedGet(path, cookie);
      expect(res.status, path).toBe(403);
      const body = await res.json();
      expect(body.error?.code ?? body.code, path).toBe('ADVISOR_DISABLED');
    }
  });

  it('withdraws and restores without a restart', async () => {
    const cookie = await registerAndGetCookie();

    config.DISABLE_ADVISOR = true;
    expect((await authedGet('/api/advisor/_health', cookie)).status).toBe(403);

    config.DISABLE_ADVISOR = false;
    expect((await authedGet('/api/advisor/_health', cookie)).status).toBe(200);
  });
});

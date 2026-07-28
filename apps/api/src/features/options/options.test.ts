import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { blackScholes, encodeOccSymbol, parseOccSymbol } from '@tradr/shared';

import app from '@/app';

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `opts-test${testRunId}-${++testCounter}@example.com`;
}

let ipCounter = 400;
function uniqueIp() {
  return `10.4.0.${++ipCounter}`;
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

function unauthedRequest(method: string, urlPath: string, body?: unknown) {
  const headers: Record<string, string> = {
    'X-Forwarded-For': uniqueIp(),
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  return app.request(urlPath, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const ATM_CALL_REQUEST = {
  S: 150,
  K: 150,
  T: 0.5,
  sigma: 0.3,
  r: 0.04,
  q: 0,
  type: 'call' as const,
};

// Pinned to the `bs-atm-call` swagger-example response in options.route.ts —
// the JSDoc lint test locks this against actual `blackScholes(...)` output.
const ATM_CALL_RESPONSE = {
  price: '14.0857',
  delta: '5.79395e-1',
  gamma: '1.22884e-2',
  thetaPerDay: '-4.20684e-2',
  vegaPerPct: '4.14735e-1',
  rhoPerPct: '3.64118e-1',
};

describe('options API', () => {
  it('401 unauthed for /occ/parse', async () => {
    const res = await unauthedRequest('POST', '/api/options/occ/parse', {
      input: 'AAPL  250620C00150000',
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('401 unauthed for /occ/encode', async () => {
    const res = await unauthedRequest('POST', '/api/options/occ/encode', {
      underlying: 'AAPL',
      expiration: '2025-06-20',
      type: 'call',
      strike: '150',
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('401 unauthed for /black-scholes', async () => {
    const res = await unauthedRequest('POST', '/api/options/black-scholes', ATM_CALL_REQUEST);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('/occ/parse positive smoke', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/options/occ/parse', cookie, {
      input: 'AAPL  250620C00150000',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      underlying: 'AAPL',
      expiration: '2025-06-20',
      type: 'call',
      strike: '150.000',
    });
  });

  it('/occ/parse validation envelope shape', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/options/occ/parse', cookie, {
      input: 'foo',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.fields[0].path).toBe('input');
    expect(body.error.fields[0].code).toMatch(/^OCC_/);
    expect(body.error.details).toBeDefined();
    expect(body.error.fields).toBeDefined();
  });

  it('/occ/encode positive smoke', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/options/occ/encode', cookie, {
      underlying: 'AAPL',
      expiration: '2025-06-20',
      type: 'call',
      strike: '150',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ symbol: 'AAPL  250620C00150000' });
  });

  it('/occ/encode validation envelope shape', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/options/occ/encode', cookie, {
      underlying: '1AAPL',
      expiration: '2025-06-20',
      type: 'call',
      strike: '150',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.fields[0].code).not.toBe('VALIDATION_ERROR');
    expect(body.error.details).toBeDefined();
    expect(body.error.fields).toBeDefined();
  });

  it('/black-scholes positive smoke', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/options/black-scholes', cookie, ATM_CALL_REQUEST);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(ATM_CALL_RESPONSE);
  });

  it('/black-scholes validation envelope shape (negative S)', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/options/black-scholes', cookie, {
      S: -1,
      K: 100,
      T: 1,
      sigma: 0.3,
      r: 0.04,
      type: 'call',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.fields[0].code).toBe('too_small');
    expect(body.error.details).toBeDefined();
    expect(body.error.fields).toBeDefined();
  });

  it('/black-scholes q-omission parity (and pinned atm-call body)', async () => {
    const { cookie } = await registerAndGetCookie();

    const withQ = await authedRequest(
      'POST',
      '/api/options/black-scholes',
      cookie,
      ATM_CALL_REQUEST,
    );
    expect(withQ.status).toBe(200);
    const bodyWithQ = await withQ.json();

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { q: _omitted, ...withoutQRequest } = ATM_CALL_REQUEST;
    const withoutQ = await authedRequest(
      'POST',
      '/api/options/black-scholes',
      cookie,
      withoutQRequest,
    );
    expect(withoutQ.status).toBe(200);
    const bodyWithoutQ = await withoutQ.json();

    expect(bodyWithoutQ).toEqual(bodyWithQ);
    expect(bodyWithoutQ).toEqual(ATM_CALL_RESPONSE);
  });

  it('JSDoc @swagger-example blocks match real pure-function output', () => {
    const ROUTE_FILE = path.resolve(import.meta.dirname, 'options.route.ts');
    const source = readFileSync(ROUTE_FILE, 'utf8');
    const regex = /^\s*\*\s*@swagger-example\s+(\S+)\s+(.+?)\s+→\s+(.+?)\s*$/gm;

    let occParseCount = 0;
    let occEncodeCount = 0;
    let bsCount = 0;

    const matches = Array.from(source.matchAll(regex));
    expect(matches.length).toBeGreaterThan(0);

    for (const match of matches) {
      const name = match[1];
      const request = JSON.parse(match[2]);
      const expectedResponse = JSON.parse(match[3]);

      if (name.startsWith('occ-parse-')) {
        occParseCount++;
        const result = parseOccSymbol(request.input);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toEqual(expectedResponse);
        }
      } else if (name.startsWith('occ-encode-')) {
        occEncodeCount++;
        const result = encodeOccSymbol(request);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect({ symbol: result.value }).toEqual(expectedResponse);
        }
      } else if (name.startsWith('bs-')) {
        bsCount++;
        const output = blackScholes(request);
        expect(output).toEqual(expectedResponse);
      } else {
        throw new Error(`Unknown @swagger-example prefix in name: ${name}`);
      }
    }

    expect(occParseCount).toBeGreaterThanOrEqual(4);
    expect(occEncodeCount).toBeGreaterThanOrEqual(1);
    expect(bsCount).toBeGreaterThanOrEqual(3);
  });

  it('/black-scholes 400 on T > 50', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/options/black-scholes', cookie, {
      S: 100,
      K: 100,
      T: 51,
      sigma: 0.3,
      r: 0.04,
      type: 'call',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.fields[0].code).toBe('too_big');
    expect(body.error.details).toBeDefined();
    expect(body.error.fields).toBeDefined();
  });

  it('/occ/parse 400 on input over 64 chars (OCC_TOO_LONG)', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/options/occ/parse', cookie, {
      input: 'A'.repeat(65),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.fields[0].code).toBe('OCC_TOO_LONG');
  });

  it('/occ/parse whitespace fixture (tab) normalises per REQ-1.2', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/options/occ/parse', cookie, {
      // Two tabs (REQ-1.2 substitutes each to a single space) yields the
      // same 21-char Form-1 canonical as test 4's `'AAPL  250620C00150000'`.
      input: 'AAPL\t\t250620C00150000',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      underlying: 'AAPL',
      expiration: '2025-06-20',
      type: 'call',
      strike: '150.000',
    });
  });
});

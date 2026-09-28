import { eq } from 'drizzle-orm';
import { describe, it, expect } from 'vitest';

import app from '@/app';
import { db } from '@/db';
import { tradingRules, users } from '@/db/schema';

import { ruleDedupKey } from './rule-key';

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `rules-test${testRunId}-${++testCounter}@example.com`;
}

let ipCounter = 0;
function uniqueIp() {
  return `10.99.${Math.floor(++ipCounter / 256)}.${ipCounter % 256}`;
}

function getCookieValue(res: Response, name: string): string | undefined {
  for (const header of res.headers.getSetCookie()) {
    const match = header.match(new RegExp(`${name}=([^;]*)`));
    if (match) return match[1];
  }
  return undefined;
}

async function registerAndGetCookie(): Promise<{ cookie: string; userId: string }> {
  const email = uniqueEmail();
  const res = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  expect(res.status).toBe(201);
  const cookie = getCookieValue(res, 'session')!;
  const [user] = await db.select().from(users).where(eq(users.email, email));
  return { cookie, userId: user.id };
}

function authedRequest(method: string, path: string, cookie: string, body?: unknown) {
  const headers: Record<string, string> = {
    Cookie: `session=${cookie}`,
    'X-Forwarded-For': uniqueIp(),
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function createTestAccount(cookie: string, name = 'Rules Account', currency = 'USD') {
  const res = await authedRequest('POST', '/api/accounts', cookie, { name, currency });
  expect(res.status).toBe(201);
  return res.json();
}

async function createTestTag(cookie: string, name = 'discipline') {
  const res = await authedRequest('POST', '/api/tags', cookie, { name, category: 'general' });
  expect(res.status).toBe(201);
  return res.json();
}

// A rule body with both scopes null by default; `TradingRuleInputSchema` needs
// `accountId` and `tagId` present (nullable, not optional).
function ruleBody(partial: Record<string, unknown> = {}) {
  return {
    definition: { type: 'max_risk_percent', params: { percent: '2' } },
    weight: 'important',
    enabled: true,
    accountId: null,
    tagId: null,
    ...partial,
  };
}

const RANDOM_UUID = '00000000-0000-4000-8000-000000000000';

describe('trading-rules CRUD', () => {
  it('creates, lists, replaces and deletes a rule', async () => {
    const { cookie } = await registerAndGetCookie();

    const createRes = await authedRequest('POST', '/api/trading-rules', cookie, ruleBody());
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created).toMatchObject({
      definition: { type: 'max_risk_percent', params: { percent: '2' } },
      weight: 'important',
      enabled: true,
      accountId: null,
      tagId: null,
    });
    expect(created.id).toBeDefined();
    expect(created.description).toBe('Risk per trade at most 2% of account balance');

    const listRes = await authedRequest('GET', '/api/trading-rules', cookie);
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toHaveLength(1);

    // Full replacement (D2): a new definition and a flipped enabled flag.
    const putRes = await authedRequest('PUT', `/api/trading-rules/${created.id}`, cookie, {
      ...ruleBody(),
      definition: { type: 'min_risk_reward', params: { ratio: '2' } },
      weight: 'critical',
      enabled: false,
    });
    expect(putRes.status).toBe(200);
    const edited = await putRes.json();
    expect(edited).toMatchObject({
      definition: { type: 'min_risk_reward', params: { ratio: '2' } },
      weight: 'critical',
      enabled: false,
    });

    const delRes = await authedRequest('DELETE', `/api/trading-rules/${created.id}`, cookie);
    expect(delRes.status).toBe(204);
    expect(await (await authedRequest('GET', '/api/trading-rules', cookie)).json()).toHaveLength(0);
  });

  it('isolates rules per user: a second user sees and changes none', async () => {
    const owner = await registerAndGetCookie();
    const other = await registerAndGetCookie();
    const rule = await (
      await authedRequest('POST', '/api/trading-rules', owner.cookie, ruleBody())
    ).json();

    expect(await (await authedRequest('GET', '/api/trading-rules', other.cookie)).json()).toEqual(
      [],
    );

    const put = await authedRequest(
      'PUT',
      `/api/trading-rules/${rule.id}`,
      other.cookie,
      ruleBody(),
    );
    expect(put.status).toBe(404);
    const del = await authedRequest('DELETE', `/api/trading-rules/${rule.id}`, other.cookie);
    expect(del.status).toBe(404);

    // The owner's rule is untouched.
    expect(
      await (await authedRequest('GET', '/api/trading-rules', owner.cookie)).json(),
    ).toHaveLength(1);
  });

  it('returns 404 for a rule id the user does not own on PUT and DELETE', async () => {
    const { cookie } = await registerAndGetCookie();
    expect(
      (await authedRequest('PUT', `/api/trading-rules/${RANDOM_UUID}`, cookie, ruleBody())).status,
    ).toBe(404);
    expect(
      (await authedRequest('DELETE', `/api/trading-rules/${RANDOM_UUID}`, cookie)).status,
    ).toBe(404);
  });
});

describe('trading-rules validation (Req 1.3, 1.4)', () => {
  it('rejects a parameter outside its bounds with 400', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest(
      'POST',
      '/api/trading-rules',
      cookie,
      ruleBody({ definition: { type: 'max_risk_percent', params: { percent: '0' } } }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects an unsupported currency code with 400', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest(
      'POST',
      '/api/trading-rules',
      cookie,
      ruleBody({
        definition: { type: 'max_risk_amount', params: { amount: '100', currency: 'ZZZ' } },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects an account id the user does not own with 400', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest(
      'POST',
      '/api/trading-rules',
      cookie,
      ruleBody({ accountId: RANDOM_UUID }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.details).toHaveProperty('accountId');
  });

  it('rejects a tag id the user does not own with 400', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest(
      'POST',
      '/api/trading-rules',
      cookie,
      ruleBody({ tagId: RANDOM_UUID }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.details).toHaveProperty('tagId');
  });

  it('rejects a scoped currency-amount rule whose currency differs from the account (Req 1.4)', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie, 'USD Account', 'USD');
    const res = await authedRequest(
      'POST',
      '/api/trading-rules',
      cookie,
      ruleBody({
        definition: { type: 'max_risk_amount', params: { amount: '100', currency: 'EUR' } },
        accountId: account.id,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.details).toHaveProperty('definition.params.currency');
  });

  it('accepts a scoped currency-amount rule whose currency matches the account', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie, 'USD Account', 'USD');
    const res = await authedRequest(
      'POST',
      '/api/trading-rules',
      cookie,
      ruleBody({
        definition: { type: 'max_risk_amount', params: { amount: '100', currency: 'USD' } },
        accountId: account.id,
      }),
    );
    expect(res.status).toBe(201);
  });
});

describe('trading-rules cap and duplicates', () => {
  it('refuses the 51st create with 409 TRADING_RULE_LIMIT_REACHED', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    // Seed 50 rules directly, each with a distinct dedup key.
    await db.insert(tradingRules).values(
      Array.from({ length: 50 }, (_, i) => {
        const definition = { type: 'max_trades_per_day' as const, params: { count: i + 1 } };
        return {
          userId,
          type: definition.type,
          params: definition.params,
          weight: 'important',
          enabled: true,
          dedupKey: ruleDedupKey(definition, null, null),
        };
      }),
    );

    const over = await authedRequest('POST', '/api/trading-rules', cookie, ruleBody());
    expect(over.status).toBe(409);
    expect((await over.json()).error.code).toBe('TRADING_RULE_LIMIT_REACHED');
  });

  it('refuses an exact duplicate with 409 on create and on edit', async () => {
    const { cookie } = await registerAndGetCookie();
    const a = await (await authedRequest('POST', '/api/trading-rules', cookie, ruleBody())).json();

    const dupCreate = await authedRequest('POST', '/api/trading-rules', cookie, ruleBody());
    expect(dupCreate.status).toBe(409);
    expect((await dupCreate.json()).error.code).toBe('TRADING_RULE_DUPLICATE');

    // A distinct second rule, then an edit that makes it equal `a` — a 409.
    const b = await (
      await authedRequest(
        'POST',
        '/api/trading-rules',
        cookie,
        ruleBody({ definition: { type: 'max_risk_percent', params: { percent: '3' } } }),
      )
    ).json();
    expect(b.id).not.toBe(a.id);

    const dupEdit = await authedRequest('PUT', `/api/trading-rules/${b.id}`, cookie, ruleBody());
    expect(dupEdit.status).toBe(409);
    expect((await dupEdit.json()).error.code).toBe('TRADING_RULE_DUPLICATE');
  });

  it('allows a USD/EUR pair, a warn/hard amount ladder, and a global plus scoped pair', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie, 'USD Account', 'USD');

    // USD and EUR of the same type and amount differ only in currency (D6).
    const usd = await authedRequest(
      'POST',
      '/api/trading-rules',
      cookie,
      ruleBody({
        definition: { type: 'max_risk_amount', params: { amount: '100', currency: 'USD' } },
      }),
    );
    expect(usd.status).toBe(201);
    const eur = await authedRequest(
      'POST',
      '/api/trading-rules',
      cookie,
      ruleBody({
        definition: { type: 'max_risk_amount', params: { amount: '100', currency: 'EUR' } },
      }),
    );
    expect(eur.status).toBe(201);

    // A warn/hard ladder: the same type, differing only in the amount.
    const hard = await authedRequest(
      'POST',
      '/api/trading-rules',
      cookie,
      ruleBody({
        definition: { type: 'max_risk_amount', params: { amount: '200', currency: 'USD' } },
      }),
    );
    expect(hard.status).toBe(201);

    // A global rule and an account-scoped rule with equal type and parameters:
    // "no scope" is its own value, so they do not collide (D4).
    const global = await authedRequest('POST', '/api/trading-rules', cookie, ruleBody());
    expect(global.status).toBe(201);
    const scoped = await authedRequest(
      'POST',
      '/api/trading-rules',
      cookie,
      ruleBody({ accountId: account.id }),
    );
    expect(scoped.status).toBe(201);
  });
});

describe('trading-rules scope cascades (Req 9.2)', () => {
  it('deleting a tag removes rules scoped to it', async () => {
    const { cookie } = await registerAndGetCookie();
    const tag = await createTestTag(cookie);
    const rule = await (
      await authedRequest('POST', '/api/trading-rules', cookie, ruleBody({ tagId: tag.id }))
    ).json();

    const del = await authedRequest('DELETE', `/api/tags/${tag.id}`, cookie);
    expect(del.status).toBe(204);

    const list = await (await authedRequest('GET', '/api/trading-rules', cookie)).json();
    expect(list.find((r: { id: string }) => r.id === rule.id)).toBeUndefined();
    expect(list).toHaveLength(0);
  });

  it('deleting an account removes rules scoped to it', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    await authedRequest('POST', '/api/trading-rules', cookie, ruleBody({ accountId: account.id }));

    const del = await authedRequest('DELETE', `/api/accounts/${account.id}`, cookie);
    expect(del.status).toBe(204);

    expect(await (await authedRequest('GET', '/api/trading-rules', cookie)).json()).toHaveLength(0);
  });

  it('the demo teardown removes rules scoped to the demo account', async () => {
    const { cookie } = await registerAndGetCookie();
    const demo = await (await authedRequest('POST', '/api/accounts/demo', cookie)).json();
    expect(demo.isDemo).toBe(true);
    await authedRequest('POST', '/api/trading-rules', cookie, ruleBody({ accountId: demo.id }));

    const del = await authedRequest('DELETE', `/api/accounts/${demo.id}?cascade=demo`, cookie);
    expect(del.status).toBe(204);

    expect(await (await authedRequest('GET', '/api/trading-rules', cookie)).json()).toHaveLength(0);
  });
});

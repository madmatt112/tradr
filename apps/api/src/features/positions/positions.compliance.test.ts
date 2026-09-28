import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

import app from '@/app';
import { db } from '@/db';
import { users } from '@/db/schema';
import {
  insertPositionCloseLedgerEntries,
  reversePositionCloseLedgerEntries,
} from '@/features/accounting/ledger-hook';
import {
  replaceCloseHook,
  unregisterCloseHook,
  replaceReverseHook,
  unregisterReverseHook,
} from '@/features/positions/positions.service';
import * as ruleEvaluator from '@/features/trading-rules/rule-evaluator';
import { logger } from '@/lib/logger';

// The `compliance` field on `GET /api/positions/:id` (design C6). Driven through
// `app.request` with the harness shape of positions.tags.test.ts:20-39, so the
// route, service and compliance service are exercised end to end against the
// live scoring path. No positions test asserts the detail's full key set, and
// none creates a rule, so adding rules here changes no other file's assertions.

// --- Harness (own copies of positions.tags.test.ts:20-108) ------------------

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `poscompliance-test${testRunId}-${++testCounter}@example.com`;
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
  expect(cookie).toBeDefined();
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

async function createTestAccount(cookie: string, name = 'Test Account', timezone = 'UTC') {
  const res = await authedRequest('POST', '/api/accounts', cookie, {
    name,
    currency: 'USD',
    timezone,
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function createTestPosition(
  cookie: string,
  accountId: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await authedRequest('POST', '/api/positions', cookie, {
    accountId,
    symbol: 'AAPL',
    side: 'long',
    assetType: 'stock',
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function addFill(
  cookie: string,
  positionId: string,
  data: { type: string; price: string; quantity: string; filledAt: string },
) {
  return authedRequest('POST', `/api/positions/${positionId}/fills`, cookie, data);
}

/** Create a rule via the API. Weight `important`, unscoped, enabled by default. */
async function createRule(
  cookie: string,
  definition: { type: string; params: Record<string, unknown> },
  overrides: {
    weight?: string;
    enabled?: boolean;
    accountId?: string | null;
    tagId?: string | null;
  } = {},
) {
  const res = await authedRequest('POST', '/api/trading-rules', cookie, {
    definition,
    weight: overrides.weight ?? 'important',
    enabled: overrides.enabled ?? true,
    accountId: overrides.accountId ?? null,
    tagId: overrides.tagId ?? null,
  });
  expect(res.status).toBe(201);
  return res.json();
}

/** Full replacement of a rule (PUT), the create-shaped body. */
async function updateRule(
  cookie: string,
  id: string,
  definition: { type: string; params: Record<string, unknown> },
  overrides: {
    weight?: string;
    enabled?: boolean;
    accountId?: string | null;
    tagId?: string | null;
  } = {},
) {
  const res = await authedRequest('PUT', `/api/trading-rules/${id}`, cookie, {
    definition,
    weight: overrides.weight ?? 'important',
    enabled: overrides.enabled ?? true,
    accountId: overrides.accountId ?? null,
    tagId: overrides.tagId ?? null,
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function readDetail(cookie: string, id: string) {
  const res = await authedRequest('GET', `/api/positions/${id}`, cookie);
  expect(res.status).toBe(200);
  return res.json();
}

/** Draft → open, with a single entry fill at the given instant. */
async function openPositionAt(
  cookie: string,
  accountId: string,
  filledAt: string,
  overrides: Record<string, unknown> = {},
) {
  const pos = await createTestPosition(cookie, accountId, overrides);
  const fill = await addFill(cookie, pos.id, {
    type: 'entry',
    price: '10',
    quantity: '100',
    filledAt,
  });
  expect(fill.status).toBe(201);
  const res = await authedRequest('POST', `/api/positions/${pos.id}/open`, cookie, {
    openedAt: filledAt,
  });
  expect(res.status).toBe(200);
  return pos;
}

// The close/reverse ledger hooks are cleared cross-file by test-setup, so
// re-register them here (positions.test.ts pattern) — close and reopen drive them.
beforeAll(() => {
  replaceCloseHook('ledger', insertPositionCloseLedgerEntries);
  replaceReverseHook('ledger', reversePositionCloseLedgerEntries);
});
afterAll(() => {
  unregisterCloseHook('ledger');
  unregisterReverseHook('ledger');
});

afterEach(() => {
  vi.restoreAllMocks();
});

const LONG_ONLY = { type: 'allowed_directions', params: { directions: ['long'] } };
const SHORT_ONLY = { type: 'allowed_directions', params: { directions: ['short'] } };

describe('GET /api/positions/:id — compliance', () => {
  it('omits the compliance field when the user holds no rules (Req 6.1)', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await openPositionAt(cookie, account.id, '2025-01-15T15:00:00Z');

    const detail = await readDetail(cookie, pos.id);
    expect('compliance' in detail).toBe(false);
  });

  it('returns the draft shape when a draft is read and rules exist (Req 6.1)', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    await createRule(cookie, LONG_ONLY);
    const draft = await createTestPosition(cookie, account.id);

    const detail = await readDetail(cookie, draft.id);
    expect(detail.compliance).toEqual({
      finality: null,
      score: null,
      status: 'unscored',
      entries: [],
    });
  });

  it('marks an open position provisional, a closed one final, and a reopened one provisional again (Req 4.4, 4.6)', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    await createRule(cookie, LONG_ONLY);
    const pos = await openPositionAt(cookie, account.id, '2025-01-15T15:00:00Z');

    const open = await readDetail(cookie, pos.id);
    expect(open.compliance.finality).toBe('provisional');
    expect(open.compliance.score).toBe(100);
    expect(open.compliance.status).toBe('compliant');

    const exit = await addFill(cookie, pos.id, {
      type: 'exit',
      price: '11',
      quantity: '100',
      filledAt: '2025-01-15T18:00:00Z',
    });
    expect(exit.status).toBe(201);
    const closed = await readDetail(cookie, pos.id);
    expect(closed.status).toBe('closed');
    expect(closed.compliance.finality).toBe('final');

    const reopen = await authedRequest('POST', `/api/positions/${pos.id}/reopen`, cookie, {
      reopenedAt: '2025-01-15T19:00:00Z',
    });
    expect(reopen.status).toBe(200);
    const reopened = await readDetail(cookie, pos.id);
    expect(reopened.status).toBe('open');
    expect(reopened.compliance.finality).toBe('provisional');
  });

  it('rescoring reflects a rule edit and a rule disable on the next read (Req 4.5)', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const rule = await createRule(cookie, LONG_ONLY);
    const pos = await openPositionAt(cookie, account.id, '2025-01-15T15:00:00Z');

    const first = await readDetail(cookie, pos.id);
    expect(first.compliance.status).toBe('compliant');
    expect(first.compliance.score).toBe(100);

    // Edit the rule so the long position now breaches it.
    await updateRule(cookie, rule.id, SHORT_ONLY);
    const edited = await readDetail(cookie, pos.id);
    expect(edited.compliance.status).toBe('non_compliant');
    expect(edited.compliance.score).toBe(0);

    // Disable the (only) rule: nothing scores, so the position is unscored.
    await updateRule(cookie, rule.id, SHORT_ONLY, { enabled: false });
    const disabled = await readDetail(cookie, pos.id);
    expect(disabled.compliance).toEqual({
      finality: 'provisional',
      score: null,
      status: 'unscored',
      entries: [],
    });
  });

  it("reflects a context rule reading another position's earlier fill (Req 4.5)", async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    // Exposure over both open positions' notional; the target alone is under it.
    await createRule(cookie, {
      type: 'max_total_exposure',
      params: { amount: '1500', currency: 'USD' },
    });
    const target = await openPositionAt(cookie, account.id, '2025-01-15T15:00:00Z', {
      symbol: 'AAA',
    });

    const before = await readDetail(cookie, target.id);
    const beforeEntry = before.compliance.entries.find(
      (e: { type: string }) => e.type === 'max_total_exposure',
    );
    expect(before.compliance.status).toBe('compliant');
    expect(beforeEntry.outcome).toBe('pass');

    // A second open position with a fill before the target's open instant.
    await openPositionAt(cookie, account.id, '2025-01-15T14:00:00Z', { symbol: 'BBB' });

    const after = await readDetail(cookie, target.id);
    const afterEntry = after.compliance.entries.find(
      (e: { type: string }) => e.type === 'max_total_exposure',
    );
    expect(after.compliance.status).toBe('non_compliant');
    expect(afterEntry.outcome).toBe('breach');
    expect(Number(afterEntry.measured)).toBeGreaterThan(Number(beforeEntry.measured));
  });

  it('never blocks a position operation when a rule breaches (Req 5.1)', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    // A long position breaches this rule at every step, yet no step is refused.
    await createRule(cookie, SHORT_ONLY);

    const create = await authedRequest('POST', '/api/positions', cookie, {
      accountId: account.id,
      symbol: 'AAPL',
      side: 'long',
      assetType: 'stock',
    });
    expect(create.status).toBe(201);
    const pos = await create.json();

    const entry = await addFill(cookie, pos.id, {
      type: 'entry',
      price: '10',
      quantity: '100',
      filledAt: '2025-01-15T15:00:00Z',
    });
    expect(entry.status).toBe(201);

    const open = await authedRequest('POST', `/api/positions/${pos.id}/open`, cookie, {
      openedAt: '2025-01-15T15:00:00Z',
    });
    expect(open.status).toBe(200);

    const edit = await authedRequest('PUT', `/api/positions/${pos.id}`, cookie, {
      notes: 'still breaching, still editable',
    });
    expect(edit.status).toBe(200);

    const exit = await addFill(cookie, pos.id, {
      type: 'exit',
      price: '11',
      quantity: '100',
      filledAt: '2025-01-15T18:00:00Z',
    });
    expect(exit.status).toBe(201);

    const reopen = await authedRequest('POST', `/api/positions/${pos.id}/reopen`, cookie, {
      reopenedAt: '2025-01-15T19:00:00Z',
    });
    expect(reopen.status).toBe(200);

    const del = await authedRequest('DELETE', `/api/positions/${pos.id}`, cookie);
    expect(del.status).toBe(204);
  });

  it('returns a 200 unscored detail when scoring throws (Req 5.2)', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    await createRule(cookie, LONG_ONLY);
    const pos = await openPositionAt(cookie, account.id, '2025-01-15T15:00:00Z');

    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(ruleEvaluator, 'scorePosition').mockImplementation(() => {
      throw new Error('forced scoring failure');
    });

    const res = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    expect(res.status).toBe(200);
    const detail = await res.json();
    expect(detail.compliance).toEqual({
      finality: 'provisional',
      score: null,
      status: 'unscored',
      entries: [],
    });
    expect(errorSpy).toHaveBeenCalledWith(
      'trading_rules_scoring_failed',
      expect.objectContaining({ positionId: pos.id }),
    );
  });
});

/**
 * Admin-surface integration tests (admin-platform Task 15; design §Testing
 * Strategy → Integration).
 *
 * Real Postgres (NO DB mocks) via `src/test-setup.ts` — migrations applied in
 * beforeAll, every test wrapped in a rolled-back drizzle transaction. All
 * fixtures are direct-insert (users/sessions/positions/usage_records/
 * wallet_transactions), per the advisor.platform-billing.test.ts precedent —
 * no auth-route round-trips, no bcrypt cost.
 *
 * Covers:
 *  - REQ-1.5 regression guards: 403/'ADMIN_REQUIRED' from EVERY admin route
 *    for a non-admin (all four reads AND the toggle write); 401 when
 *    unauthenticated; admin happy-path per endpoint.
 *  - Stats: seeded counts; empty-instance zeros; active-users 30-min/24-h
 *    window bounds (REQ-2.x).
 *  - Users: descending (created_at, id) pagination stable across pages;
 *    detail aggregates; no password/key material in responses (REQ-3.6);
 *    last_active_at returned as-is for stale sessions, NULL for
 *    never-logged-in (REQ-3.1/3.2).
 *  - Toggle: promote / demote / post-lock no-op (no update, no audit row) /
 *    self-demote with >=2 admins / LAST_ADMIN refusal / same-tx audit row
 *    (REQ-3.3/3.4/3.5).
 *  - Usage & revenue: totals + raw_cost coverage, UTC day buckets, top-50
 *    ordering/limit, cross-period reversal attribution incl. the
 *    two-credits-one-payment-intent DISTINCT ON hardening and the stats
 *    currentMonth attribution, query validation, well-formed zeros
 *    (REQ-4.x).
 *  - Bootstrap: bootstrapFirstAdmin promote/no-op matrix (REQ-8.3/8.4).
 *
 * CONCURRENCY HONESTY (stated, not hidden): the shared harness pins every
 * test to a single Postgres connection (SAVEPOINT isolation — deferral
 * d-4e81d48e recorded during wallet-billing), so true cross-connection
 * `FOR UPDATE` contention on the toggle is NOT exercisable in-suite. The
 * sequential guard matrix below is covered exhaustively; the race-safety of
 * the last-admin guard relies on the documented `FOR UPDATE` + EvalPlanQual
 * semantics (design Component 3).
 *
 * _Requirements: REQ-1.x, REQ-2.x, REQ-3.x, REQ-4.x, REQ-8.3, REQ-8.4_
 */
import { createHash, randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdminStatsSchema, AdminUsageSchema, AdminUserListResponseSchema } from '@tradr/shared';

import app from '@/app';
import { db } from '@/db';
import {
  accounts,
  adminAuditLog,
  advisorTurnCounters,
  ledgerEntries,
  positions,
  sessions,
  usageRecords,
  users,
  walletTransactions,
  wallets,
} from '@/db/schema';
import { config } from '@/lib/config';

import { bootstrapFirstAdmin, getPlatformStats } from './admin.service';
import { currentPeriodKeyUtc } from './gating.query';

// ---------------------------------------------------------------------------
// Direct-insert fixtures
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// The shared tradr_test DB carries COMMITTED leftovers from older runs of
// other suites (the documented DB-state baseline — users/sessions/positions
// rows that escaped their transactions). The admin surface aggregates
// platform-wide, so every test first wipes user-rooted state INSIDE its own
// rolled-back transaction (never committed) to make absolute count
// assertions deterministic. Explicit child-first order sidesteps the
// RESTRICT FKs (ledger_entries/positions → accounts) that can trip a bare
// cascading `DELETE FROM users`.
beforeEach(async () => {
  await db.delete(ledgerEntries);
  await db.delete(positions);
  await db.delete(walletTransactions);
  await db.delete(usageRecords);
  await db.delete(accounts);
  await db.delete(sessions);
  await db.delete(adminAuditLog);
  await db.delete(users);
});

// A recognizable sentinel so the sensitive-field assertions can check the
// VALUE never leaks, not just the column name.
const SEEDED_PASSWORD_HASH = `bcrypt-sentinel-${'x'.repeat(40)}`;

let seedCounter = 0;
const runId = Date.now();
function uniqueEmail(tag: string): string {
  return `admin-it-${runId}-${++seedCounter}-${tag}@example.com`;
}

async function seedUser(
  opts: { isAdmin?: boolean; email?: string; createdAt?: Date; emailVerified?: boolean } = {},
): Promise<{ id: string; email: string; createdAt: Date }> {
  const [row] = await db
    .insert(users)
    .values({
      email: opts.email ?? uniqueEmail('user'),
      passwordHash: SEEDED_PASSWORD_HASH,
      isAdmin: opts.isAdmin ?? false,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      ...(opts.emailVerified === undefined ? {} : { emailVerified: opts.emailVerified }),
    })
    .returning({ id: users.id, email: users.email, createdAt: users.createdAt });
  return row!;
}

/** Insert a session row directly; returns the plaintext cookie token. */
async function seedSession(
  userId: string,
  opts: { createdAt?: Date; lastAccessed?: Date } = {},
): Promise<string> {
  const token = randomUUID();
  const createdAt = opts.createdAt ?? new Date();
  await db.insert(sessions).values({
    userId,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    createdAt,
    lastAccessed: opts.lastAccessed ?? createdAt,
    expiresAt: new Date(createdAt.getTime() + DAY),
  });
  return token;
}

async function seedAdmin(): Promise<{ id: string; email: string; token: string }> {
  const user = await seedUser({ isAdmin: true, email: uniqueEmail('admin') });
  const token = await seedSession(user.id);
  return { id: user.id, email: user.email, token };
}

async function seedAccount(userId: string): Promise<string> {
  const [row] = await db
    .insert(accounts)
    .values({ userId, name: `acct-${++seedCounter}`, currency: 'USD' })
    .returning({ id: accounts.id });
  return row!.id;
}

async function seedPosition(
  userId: string,
  accountId: string,
  status: 'draft' | 'open' | 'closed',
): Promise<void> {
  // Direct insert per the accounts.test.ts precedent — CHECK-safe: closed
  // rows always carry closedAt (positions_closed_at_when_closed_chk).
  // eslint-disable-next-line no-restricted-syntax
  await db.insert(positions).values({
    userId,
    accountId,
    symbol: 'AAPL',
    side: 'long',
    assetType: 'stock',
    status,
    openedAt: status === 'draft' ? null : new Date(),
    closedAt: status === 'closed' ? new Date() : null,
  });
}

async function seedUsageRecord(
  userId: string,
  opts: {
    inputTokens: bigint;
    outputTokens: bigint;
    creditCost: bigint;
    rawCost: bigint | null;
    createdAt: Date;
  },
): Promise<void> {
  await db.insert(usageRecords).values({
    userId,
    providerId: 'openai',
    model: 'gpt-4o',
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
    creditCost: opts.creditCost,
    rawCost: opts.rawCost,
    createdAt: opts.createdAt,
  });
}

async function seedWalletTx(
  userId: string,
  kind: 'credit' | 'reversal',
  amount: bigint,
  opts: { paymentIntentId?: string; createdAt?: Date } = {},
): Promise<void> {
  await db.insert(walletTransactions).values({
    userId,
    kind,
    amount,
    balanceAfter: 0n,
    stripePaymentIntentId: opts.paymentIntentId ?? null,
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  });
}

async function auditRows() {
  return db.select().from(adminAuditLog);
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function get(path: string, token?: string) {
  return app.request(path, {
    headers: token ? { Cookie: `session=${token}` } : {},
  });
}

function patchAdminFlag(targetId: string, isAdmin: unknown, token?: string) {
  return app.request(`/api/admin/users/${targetId}/admin`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Cookie: `session=${token}` } : {}),
    },
    body: JSON.stringify({ isAdmin }),
  });
}

function usagePath(from?: string, to?: string): string {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const qs = params.toString();
  return qs ? `/api/admin/usage?${qs}` : '/api/admin/usage';
}

async function errorBody(res: Response): Promise<{ code: string; message: string }> {
  const body = (await res.json()) as { error: { code: string; message: string } };
  // Envelope shape, not just status (error.middleware.ts).
  expect(body).toHaveProperty('error.code');
  expect(body).toHaveProperty('error.message');
  return body.error;
}

// ---------------------------------------------------------------------------
// 1. REQ-1.5 regression guards — every route, 401 / 403 / admin happy-path
// ---------------------------------------------------------------------------

describe('admin surface guards (REQ-1.5)', () => {
  const someUuid = randomUUID();
  const routes = [
    { name: 'GET /stats', call: (token?: string) => get('/api/admin/stats', token) },
    { name: 'GET /users', call: (token?: string) => get('/api/admin/users', token) },
    {
      name: 'GET /users/:id',
      call: (token?: string) => get(`/api/admin/users/${someUuid}`, token),
    },
    { name: 'GET /usage', call: (token?: string) => get('/api/admin/usage', token) },
    {
      name: 'PATCH /users/:id/admin',
      call: (token?: string) => patchAdminFlag(someUuid, true, token),
    },
  ];

  it('unauthenticated requests receive 401 from every admin route', async () => {
    for (const route of routes) {
      const res = await route.call(undefined);
      expect(res.status, route.name).toBe(401);
      const err = await errorBody(res);
      expect(err.code, route.name).toBe('UNAUTHORIZED');
    }
  });

  it("a non-admin receives 403/'ADMIN_REQUIRED' from every admin route — all reads AND the toggle write", async () => {
    const user = await seedUser();
    const token = await seedSession(user.id);
    for (const route of routes) {
      const res = await route.call(token);
      expect(res.status, route.name).toBe(403);
      const err = await errorBody(res);
      expect(err.code, route.name).toBe('ADMIN_REQUIRED');
    }
  });

  it('an admin reaches every endpoint (happy path per endpoint)', async () => {
    const admin = await seedAdmin();
    const target = await seedUser();

    const stats = await get('/api/admin/stats', admin.token);
    expect(stats.status).toBe(200);
    AdminStatsSchema.parse(await stats.json());

    const list = await get('/api/admin/users', admin.token);
    expect(list.status).toBe(200);
    AdminUserListResponseSchema.parse(await list.json());

    const detail = await get(`/api/admin/users/${target.id}`, admin.token);
    expect(detail.status).toBe(200);

    const usage = await get('/api/admin/usage', admin.token);
    expect(usage.status).toBe(200);
    AdminUsageSchema.parse(await usage.json());

    const toggle = await patchAdminFlag(target.id, true, admin.token);
    expect(toggle.status).toBe(200);
    expect((await toggle.json()) as { isAdmin: boolean }).toMatchObject({
      id: target.id,
      email: target.email,
      isAdmin: true,
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Stats (REQ-2.x, REQ-4.4)
// ---------------------------------------------------------------------------

describe('GET /api/admin/stats', () => {
  it('returns seeded counts: users, positions by status, active-users window bounds', async () => {
    const admin = await seedAdmin(); // session lastAccessed = now → active

    // Active-window matrix (countActiveUsersNow: last_accessed > now()-30min
    // AND created_at > now()-24h). Margins are generous so the frozen tx
    // now() vs JS Date.now() skew can never flip a case.
    const insideUser = await seedUser();
    await seedSession(insideUser.id, {
      createdAt: new Date(Date.now() - HOUR),
      lastAccessed: new Date(Date.now() - 5 * MINUTE),
    });
    const idleUser = await seedUser(); // outside the 30-min idle bound
    await seedSession(idleUser.id, {
      createdAt: new Date(Date.now() - 2 * HOUR),
      lastAccessed: new Date(Date.now() - 45 * MINUTE),
    });
    const oldUser = await seedUser(); // outside the 24-h absolute bound
    await seedSession(oldUser.id, {
      createdAt: new Date(Date.now() - 25 * HOUR),
      lastAccessed: new Date(Date.now() - 5 * MINUTE),
    });

    // Positions: 1 draft, 2 open, 1 closed.
    const accountId = await seedAccount(insideUser.id);
    await seedPosition(insideUser.id, accountId, 'draft');
    await seedPosition(insideUser.id, accountId, 'open');
    await seedPosition(insideUser.id, accountId, 'open');
    await seedPosition(insideUser.id, accountId, 'closed');

    const res = await get('/api/admin/stats', admin.token);
    expect(res.status).toBe(200);
    const stats = AdminStatsSchema.parse(await res.json());

    expect(stats.totalUsers).toBe(4);
    // admin + insideUser only; idleUser and oldUser fall outside the bounds.
    expect(stats.activeUsers).toBe(2);
    expect(stats.activeUsersWindowMinutes).toBe(30);
    expect(stats.positions).toEqual({ total: 4, draft: 1, open: 2, closed: 1 });
  });

  it("empty instance returns well-formed zeros ('0' strings), never errors (REQ-2.7)", async () => {
    // Service-level: a truly empty instance (no users at all — unreachable
    // via the route, which needs an authenticated admin).
    const empty = AdminStatsSchema.parse(await getPlatformStats());
    expect(empty.totalUsers).toBe(0);
    expect(empty.activeUsers).toBe(0);
    expect(empty.positions).toEqual({ total: 0, draft: 0, open: 0, closed: 0 });
    expect(empty.revenue.allTime).toBe('0');
    expect(empty.revenue.currentMonth).toBe('0');
    expect(empty.revenue.basis).toBe('purchased-credit-volume');

    // Route-level: only the requesting admin exists — everything else zero.
    const admin = await seedAdmin();
    const res = await get('/api/admin/stats', admin.token);
    expect(res.status).toBe(200);
    const stats = AdminStatsSchema.parse(await res.json());
    expect(stats.totalUsers).toBe(1);
    expect(stats.positions.total).toBe(0);
    expect(stats.revenue.allTime).toBe('0');
    expect(stats.revenue.currentMonth).toBe('0');
  });

  it('revenue.currentMonth is reversal-ATTRIBUTED: a this-month reversal of a prior-month credit leaves it untouched; a current-month credit+reversal nets within it (REQ-4.4)', async () => {
    const admin = await seedAdmin();
    const buyer = await seedUser();

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const priorMonth = new Date(monthStart.getTime() - 10 * DAY);
    // 1 s ago — inside the current month unless the test runs within the
    // first second of a UTC month (accepted).
    const inMonth = new Date(Date.now() - 1000);

    // Prior-month purchase, refunded THIS month → must reduce the PRIOR
    // month's net, never currentMonth.
    await seedWalletTx(buyer.id, 'credit', 10_000_000n, {
      paymentIntentId: 'pi_prior',
      createdAt: priorMonth,
    });
    await seedWalletTx(buyer.id, 'reversal', -4_000_000n, {
      paymentIntentId: 'pi_prior',
      createdAt: inMonth,
    });
    // Current-month purchase kept.
    await seedWalletTx(buyer.id, 'credit', 2_000_000n, {
      paymentIntentId: 'pi_cur_keep',
      createdAt: inMonth,
    });
    // Current-month purchase + same-month reversal → nets within currentMonth.
    await seedWalletTx(buyer.id, 'credit', 1_000_000n, {
      paymentIntentId: 'pi_cur_rev',
      createdAt: inMonth,
    });
    await seedWalletTx(buyer.id, 'reversal', -1_000_000n, {
      paymentIntentId: 'pi_cur_rev',
      createdAt: inMonth,
    });

    const res = await get('/api/admin/stats', admin.token);
    const stats = AdminStatsSchema.parse(await res.json());
    // allTime = 10M − 4M + 2M + 1M − 1M.
    expect(stats.revenue.allTime).toBe('8000000');
    // currentMonth = (2M + 1M credited in-month) − 1M (the only reversal
    // ATTRIBUTED to an in-month credit). The 4M reversal hit the prior month.
    expect(stats.revenue.currentMonth).toBe('2000000');
  });
});

// ---------------------------------------------------------------------------
// 3. Users — pagination, detail, sensitive fields, last_active_at (REQ-3.x)
// ---------------------------------------------------------------------------

describe('GET /api/admin/users (+ /users/:id)', () => {
  it('paginates descending over (created_at, id), stable across pages, newest first — incl. same-timestamp id tiebreak', async () => {
    const admin = await seedAdmin(); // createdAt = tx now() → newest row
    const base = Date.now() - HOUR;
    const seeded: { id: string; createdAt: Date }[] = [];
    // Distinct timestamps...
    for (let i = 0; i < 4; i++) {
      seeded.push(await seedUser({ createdAt: new Date(base - i * MINUTE) }));
    }
    // ...plus three sharing ONE timestamp to force the id tiebreak across a
    // page boundary (ms-precision dates → exact cursor roundtrip).
    const tied = new Date(base - 10 * MINUTE);
    for (let i = 0; i < 3; i++) {
      seeded.push(await seedUser({ createdAt: tied }));
    }

    const expectedIds = [
      admin.id,
      ...seeded
        .slice()
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
        )
        .map((u) => u.id),
    ];

    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const path: string = cursor
        ? `/api/admin/users?limit=2&cursor=${encodeURIComponent(cursor)}`
        : '/api/admin/users?limit=2';
      const res = await get(path, admin.token);
      expect(res.status).toBe(200);
      const page = AdminUserListResponseSchema.parse(await res.json());
      expect(page.items.length).toBeLessThanOrEqual(2);
      collected.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== null && pages < 20);

    // Every user exactly once, in (created_at, id) descending order — no
    // duplicates, no skips across page boundaries.
    expect(collected).toEqual(expectedIds);
    expect(new Set(collected).size).toBe(expectedIds.length);
  });

  it('responses carry NO password_hash / key material — explicit column allowlist (REQ-3.6)', async () => {
    const admin = await seedAdmin();
    const user = await seedUser();
    await seedSession(user.id);

    const listRes = await get('/api/admin/users', admin.token);
    const listText = await listRes.clone().text();
    const list = AdminUserListResponseSchema.parse(await listRes.json());
    for (const item of list.items) {
      expect(Object.keys(item).sort()).toEqual([
        'createdAt',
        'email',
        'emailVerified',
        'id',
        'isAdmin',
        'lastActiveAt',
      ]);
    }
    expect(listText).not.toContain('password');
    expect(listText).not.toContain(SEEDED_PASSWORD_HASH);
    expect(listText).not.toContain('tokenHash');
    expect(listText).not.toContain('token_hash');

    const detailRes = await get(`/api/admin/users/${user.id}`, admin.token);
    const detailText = await detailRes.clone().text();
    const detail = (await detailRes.json()) as Record<string, unknown>;
    expect(Object.keys(detail).sort()).toEqual([
      'advisorTurns',
      'createdAt',
      'email',
      'emailVerified',
      'id',
      'isAdmin',
      'lastActiveAt',
      'positionCount',
      'usage',
      'walletBalance',
    ]);
    expect(detailText).not.toContain('password');
    expect(detailText).not.toContain(SEEDED_PASSWORD_HASH);
    expect(detailText).not.toContain('tokenHash');
    expect(detailText).not.toContain('token_hash');
  });

  it('last_active_at: a stale session timestamp is returned AS-IS (may be old); NULL for a never-logged-in user', async () => {
    const admin = await seedAdmin();
    const staleUser = await seedUser();
    const stale = new Date('2026-01-15T12:00:00.000Z');
    await seedSession(staleUser.id, {
      createdAt: new Date(stale.getTime() - HOUR),
      lastAccessed: stale,
    });
    // A second, older session — the lateral takes max(last_accessed).
    await seedSession(staleUser.id, {
      createdAt: new Date(stale.getTime() - 10 * DAY),
      lastAccessed: new Date(stale.getTime() - 10 * DAY),
    });
    const neverUser = await seedUser();

    const res = await get('/api/admin/users?limit=100', admin.token);
    const { items } = AdminUserListResponseSchema.parse(await res.json());
    const staleItem = items.find((i) => i.id === staleUser.id)!;
    const neverItem = items.find((i) => i.id === neverUser.id)!;
    expect(staleItem.lastActiveAt).toBe('2026-01-15T12:00:00.000Z');
    expect(neverItem.lastActiveAt).toBeNull();
  });

  it('emailVerified: surfaced on list AND detail for both states (REQ-5.7; transactional-email)', async () => {
    const admin = await seedAdmin();
    // Column default is true (the REQ-6.1 grandfathering) — seed the
    // unverified state explicitly.
    const verified = await seedUser();
    const unverified = await seedUser({ emailVerified: false });

    const res = await get('/api/admin/users?limit=100', admin.token);
    const { items } = AdminUserListResponseSchema.parse(await res.json());
    expect(items.find((i) => i.id === verified.id)!.emailVerified).toBe(true);
    expect(items.find((i) => i.id === unverified.id)!.emailVerified).toBe(false);

    const verifiedDetail = await get(`/api/admin/users/${verified.id}`, admin.token);
    expect(((await verifiedDetail.json()) as { emailVerified: boolean }).emailVerified).toBe(true);
    const unverifiedDetail = await get(`/api/admin/users/${unverified.id}`, admin.token);
    expect(((await unverifiedDetail.json()) as { emailVerified: boolean }).emailVerified).toBe(
      false,
    );
  });

  it('detail aggregates: positionCount, current-UTC-month advisorTurns, all-time usage sums, walletBalance (REQ-3.2)', async () => {
    const admin = await seedAdmin();
    const user = await seedUser();
    const accountId = await seedAccount(user.id);
    await seedPosition(user.id, accountId, 'draft');
    await seedPosition(user.id, accountId, 'open');
    await seedPosition(user.id, accountId, 'closed');
    // Current month counts; an old period must NOT.
    await db
      .insert(advisorTurnCounters)
      .values({ userId: user.id, periodKey: currentPeriodKeyUtc(), turnCount: 7 });
    await db
      .insert(advisorTurnCounters)
      .values({ userId: user.id, periodKey: '2020-01', turnCount: 5 });
    await seedUsageRecord(user.id, {
      inputTokens: 100n,
      outputTokens: 10n,
      creditCost: 5n,
      rawCost: 3n,
      createdAt: new Date(Date.now() - 2 * DAY),
    });
    await seedUsageRecord(user.id, {
      inputTokens: 200n,
      outputTokens: 20n,
      creditCost: 7n,
      rawCost: null,
      createdAt: new Date(Date.now() - DAY),
    });
    await db.insert(wallets).values({ userId: user.id, balance: 123_456n });

    const res = await get(`/api/admin/users/${user.id}`, admin.token);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as Record<string, unknown>;
    expect(detail).toMatchObject({
      id: user.id,
      email: user.email,
      isAdmin: false,
      positionCount: 3,
      advisorTurns: 7,
      usage: { inputTokens: '300', outputTokens: '30', billedCredits: '12' },
      walletBalance: '123456',
    });

    // No wallet row → '0' (and zero aggregates all round).
    const bare = await seedUser();
    const bareRes = await get(`/api/admin/users/${bare.id}`, admin.token);
    const bareDetail = (await bareRes.json()) as Record<string, unknown>;
    expect(bareDetail).toMatchObject({
      positionCount: 0,
      advisorTurns: 0,
      usage: { inputTokens: '0', outputTokens: '0', billedCredits: '0' },
      walletBalance: '0',
      lastActiveAt: null,
    });
  });

  it('detail: unknown id → 404/NOT_FOUND; non-UUID id → 400/VALIDATION_ERROR', async () => {
    const admin = await seedAdmin();

    const missing = await get(`/api/admin/users/${randomUUID()}`, admin.token);
    expect(missing.status).toBe(404);
    expect((await errorBody(missing)).code).toBe('NOT_FOUND');

    const malformed = await get('/api/admin/users/not-a-uuid', admin.token);
    expect(malformed.status).toBe(400);
    expect((await errorBody(malformed)).code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// 4. Toggle matrix (REQ-3.3/3.4/3.5)
//
// NOTE on concurrency: the harness pins all queries to ONE connection
// (SAVEPOINT isolation — deferral d-4e81d48e), so cross-connection FOR UPDATE
// contention cannot be exercised here. The sequential matrix below is
// exhaustive; race-safety rests on the documented FOR UPDATE + EvalPlanQual
// semantics (design Component 3).
// ---------------------------------------------------------------------------

describe('PATCH /api/admin/users/:id/admin', () => {
  it('promote writes the flip AND the audit row in the same tx (action/actor/target emails/old→new/timestamp)', async () => {
    const admin = await seedAdmin();
    const target = await seedUser();

    const res = await patchAdminFlag(target.id, true, admin.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ id: target.id, email: target.email, isAdmin: true });
    expect(typeof body.createdAt).toBe('string');

    const [row] = await db.select().from(users).where(eq(users.id, target.id));
    expect(row!.isAdmin).toBe(true);

    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'admin_toggle',
      actorUserId: admin.id,
      actorEmail: admin.email, // resolved in-tx, not from context
      targetUserId: target.id,
      targetEmail: target.email,
      oldValue: false,
      newValue: true,
    });
    expect(audit[0]!.createdAt).toBeInstanceOf(Date);
  });

  it('demote (≥2 admins) flips the flag and audits old:true → new:false', async () => {
    const admin = await seedAdmin();
    const other = await seedUser({ isAdmin: true });

    const res = await patchAdminFlag(other.id, false, admin.token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { isAdmin: boolean }).isAdmin).toBe(false);

    const [row] = await db.select().from(users).where(eq(users.id, other.id));
    expect(row!.isAdmin).toBe(false);

    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorUserId: admin.id,
      targetUserId: other.id,
      oldValue: true,
      newValue: false,
    });
  });

  it('idempotent no-op (both directions) decided post-lock: 200, NO update, NO audit row', async () => {
    const admin = await seedAdmin();
    const alreadyAdmin = await seedUser({ isAdmin: true });
    const nonAdmin = await seedUser();

    const before = await db
      .select({ updatedAt: users.updatedAt })
      .from(users)
      .where(eq(users.id, alreadyAdmin.id));

    // Promote an existing admin → no-op.
    const promote = await patchAdminFlag(alreadyAdmin.id, true, admin.token);
    expect(promote.status).toBe(200);
    expect(((await promote.json()) as { isAdmin: boolean }).isAdmin).toBe(true);

    // Demote a non-admin → no-op.
    const demote = await patchAdminFlag(nonAdmin.id, false, admin.token);
    expect(demote.status).toBe(200);
    expect(((await demote.json()) as { isAdmin: boolean }).isAdmin).toBe(false);

    // NO audit rows, NO update (updated_at untouched).
    expect(await auditRows()).toHaveLength(0);
    const after = await db
      .select({ updatedAt: users.updatedAt })
      .from(users)
      .where(eq(users.id, alreadyAdmin.id));
    expect(after[0]!.updatedAt.getTime()).toBe(before[0]!.updatedAt.getTime());
  });

  it('self-demote is allowed with ≥2 admins — and the demoted admin loses access', async () => {
    const admin = await seedAdmin();
    await seedUser({ isAdmin: true }); // second admin keeps the instance safe

    const res = await patchAdminFlag(admin.id, false, admin.token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { isAdmin: boolean }).isAdmin).toBe(false);
    expect(await auditRows()).toHaveLength(1);

    // The freshly demoted admin is now gated out.
    const followUp = await get('/api/admin/stats', admin.token);
    expect(followUp.status).toBe(403);
    expect((await errorBody(followUp)).code).toBe('ADMIN_REQUIRED');
  });

  it("demoting the last admin is refused 409/'LAST_ADMIN' — flag unchanged, no audit row", async () => {
    const admin = await seedAdmin(); // the ONLY admin

    const res = await patchAdminFlag(admin.id, false, admin.token);
    expect(res.status).toBe(409);
    const err = await errorBody(res);
    expect(err.code).toBe('LAST_ADMIN');
    expect(err.message).toBe('Cannot remove the last admin');

    const [row] = await db.select().from(users).where(eq(users.id, admin.id));
    expect(row!.isAdmin).toBe(true);
    expect(await auditRows()).toHaveLength(0);
  });

  it('unknown target → 404/NOT_FOUND; non-boolean body → 400/VALIDATION_ERROR', async () => {
    const admin = await seedAdmin();

    const missing = await patchAdminFlag(randomUUID(), true, admin.token);
    expect(missing.status).toBe(404);
    expect((await errorBody(missing)).code).toBe('NOT_FOUND');

    const target = await seedUser();
    const malformed = await patchAdminFlag(target.id, 'yes', admin.token);
    expect(malformed.status).toBe(400);
    expect((await errorBody(malformed)).code).toBe('VALIDATION_ERROR');
    expect(await auditRows()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Usage & revenue (REQ-4.x)
// ---------------------------------------------------------------------------

describe('GET /api/admin/usage', () => {
  it('totals with mixed NULL/non-NULL raw_cost → correct sums + coverage counts; UTC day-series buckets; [from,to) half-open bounds', async () => {
    const admin = await seedAdmin();
    const user = await seedUser();

    const from = '2026-03-01T00:00:00.000Z';
    const to = '2026-03-03T00:00:00.000Z';
    // Day 1: two covered rows (one exactly AT from → included, gte).
    await seedUsageRecord(user.id, {
      inputTokens: 100n,
      outputTokens: 10n,
      creditCost: 1000n,
      rawCost: 700n,
      createdAt: new Date(from),
    });
    await seedUsageRecord(user.id, {
      inputTokens: 200n,
      outputTokens: 20n,
      creditCost: 2000n,
      rawCost: 800n,
      createdAt: new Date('2026-03-01T23:59:00.000Z'),
    });
    // Day 2: one pre-0013-style row (raw_cost NULL) — excluded from
    // providerCost but counted in records.
    await seedUsageRecord(user.id, {
      inputTokens: 400n,
      outputTokens: 40n,
      creditCost: 4000n,
      rawCost: null,
      createdAt: new Date('2026-03-02T12:00:00.000Z'),
    });
    // Exactly AT to → EXCLUDED (lt — half-open interval).
    await seedUsageRecord(user.id, {
      inputTokens: 9999n,
      outputTokens: 9999n,
      creditCost: 99_999n,
      rawCost: 1n,
      createdAt: new Date(to),
    });

    const res = await get(usagePath(from, to), admin.token);
    expect(res.status).toBe(200);
    const usage = AdminUsageSchema.parse(await res.json());

    expect(usage.period).toEqual({ from, to });
    expect(usage.totals).toEqual({
      inputTokens: '700',
      outputTokens: '70',
      billedCredits: '7000',
      providerCost: '1500', // covered rows only
      providerCostCoverage: { records: 3, recordsWithRawCost: 2 },
    });
    expect(usage.series).toEqual([
      { day: '2026-03-01', inputTokens: '300', outputTokens: '30', billedCredits: '3000' },
      { day: '2026-03-02', inputTokens: '400', outputTokens: '40', billedCredits: '4000' },
    ]);
    expect(usage.topUsers).toEqual([
      {
        userId: user.id,
        email: user.email,
        inputTokens: '700',
        outputTokens: '70',
        billedCredits: '7000',
        turns: 3,
      },
    ]);
  });

  it('topUsers: ordered by billed credits descending, capped at 50 (51st excluded)', async () => {
    const admin = await seedAdmin();
    const when = new Date('2026-04-10T12:00:00.000Z');
    const seeded = await db
      .insert(users)
      .values(
        Array.from({ length: 51 }, (_, i) => ({
          email: uniqueEmail(`top${i}`),
          passwordHash: SEEDED_PASSWORD_HASH,
        })),
      )
      .returning({ id: users.id });
    await db.insert(usageRecords).values(
      seeded.map((u, i) => ({
        userId: u.id,
        providerId: 'openai',
        model: 'gpt-4o',
        inputTokens: 1n,
        outputTokens: 1n,
        creditCost: BigInt(i + 1), // user i billed i+1 credits
        rawCost: null,
        createdAt: when,
      })),
    );

    const res = await get(
      usagePath('2026-04-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z'),
      admin.token,
    );
    expect(res.status).toBe(200);
    const usage = AdminUsageSchema.parse(await res.json());

    expect(usage.topUsers).toHaveLength(50);
    expect(usage.topUsers[0]!.billedCredits).toBe('51');
    expect(usage.topUsers[49]!.billedCredits).toBe('2');
    // Strictly non-increasing ordering; the 1-credit user fell off the cap.
    const credits = usage.topUsers.map((u) => BigInt(u.billedCredits));
    for (let i = 1; i < credits.length; i++) {
      expect(credits[i]! <= credits[i - 1]!).toBe(true);
    }
    expect(usage.topUsers.some((u) => u.billedCredits === '1')).toBe(false);
  });

  it("revenue attribution: a credit in period A reversed in period B reduces A's net, not B's (REQ-4.4)", async () => {
    const admin = await seedAdmin();
    const buyer = await seedUser();
    const periodA = { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' };
    const periodB = { from: '2026-02-01T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' };

    await seedWalletTx(buyer.id, 'credit', 10_000_000n, {
      paymentIntentId: 'pi_attr',
      createdAt: new Date('2026-01-10T00:00:00.000Z'),
    });
    await seedWalletTx(buyer.id, 'credit', 3_000_000n, {
      paymentIntentId: 'pi_kept',
      createdAt: new Date('2026-01-20T00:00:00.000Z'),
    });
    // Reversal lands in period B but reverses the period-A credit.
    await seedWalletTx(buyer.id, 'reversal', -10_000_000n, {
      paymentIntentId: 'pi_attr',
      createdAt: new Date('2026-02-05T00:00:00.000Z'),
    });

    const resA = await get(usagePath(periodA.from, periodA.to), admin.token);
    const usageA = AdminUsageSchema.parse(await resA.json());
    expect(usageA.revenue).toEqual({
      credited: '13000000',
      reversed: '-10000000',
      net: '3000000',
    });

    const resB = await get(usagePath(periodB.from, periodB.to), admin.token);
    const usageB = AdminUsageSchema.parse(await resB.json());
    expect(usageB.revenue).toEqual({ credited: '0', reversed: '0', net: '0' });

    // All-time (stats) = sum(credit) − |reversals| = 13M − 10M.
    const stats = AdminStatsSchema.parse(await (await get('/api/admin/stats', admin.token)).json());
    expect(stats.revenue.allTime).toBe('3000000');
  });

  it('two credits sharing one payment intent (defensive case): each reversal counted exactly ONCE via DISTINCT ON', async () => {
    const admin = await seedAdmin();
    const buyer = await seedUser();

    // Operationally there is one credit per PI; this seeds the drift case the
    // attribution join is hardened against.
    await seedWalletTx(buyer.id, 'credit', 5_000_000n, {
      paymentIntentId: 'pi_dup',
      createdAt: new Date('2026-01-10T00:00:00.000Z'),
    });
    await seedWalletTx(buyer.id, 'credit', 5_000_000n, {
      paymentIntentId: 'pi_dup',
      createdAt: new Date('2026-01-12T00:00:00.000Z'),
    });
    await seedWalletTx(buyer.id, 'reversal', -5_000_000n, {
      paymentIntentId: 'pi_dup',
      createdAt: new Date('2026-02-03T00:00:00.000Z'),
    });
    await seedWalletTx(buyer.id, 'reversal', -2_000_000n, {
      paymentIntentId: 'pi_dup',
      createdAt: new Date('2026-02-04T00:00:00.000Z'),
    });

    const res = await get(
      usagePath('2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
      admin.token,
    );
    const usage = AdminUsageSchema.parse(await res.json());
    // A naive join would attribute each reversal to BOTH credit rows (−14M);
    // DISTINCT ON pins each reversal to the earliest credit, exactly once.
    expect(usage.revenue).toEqual({
      credited: '10000000',
      reversed: '-7000000',
      net: '3000000',
    });
  });

  it("from > to and >366-day ranges → 400/'VALIDATION_ERROR' (incl. the from-only defaulted pair)", async () => {
    const admin = await seedAdmin();

    const inverted = await get(
      usagePath('2026-03-02T00:00:00.000Z', '2026-03-01T00:00:00.000Z'),
      admin.token,
    );
    expect(inverted.status).toBe(400);
    expect((await errorBody(inverted)).code).toBe('VALIDATION_ERROR');

    const tooLong = await get(
      usagePath('2025-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'),
      admin.token,
    );
    expect(tooLong.status).toBe(400);
    expect((await errorBody(tooLong)).code).toBe('VALIDATION_ERROR');

    // from-only: the EFFECTIVE pair (to defaults to now) is re-validated, so a
    // from older than 366 days cannot bypass the cap (Task 11 semantics).
    const fromOnly = await get(usagePath('2024-01-01T00:00:00.000Z'), admin.token);
    expect(fromOnly.status).toBe(400);
    expect((await errorBody(fromOnly)).code).toBe('VALIDATION_ERROR');

    const malformed = await get(usagePath('not-a-date'), admin.token);
    expect(malformed.status).toBe(400);
    expect((await errorBody(malformed)).code).toBe('VALIDATION_ERROR');
  });

  it('from == to and future ranges → well-formed zeros, providerCost null (REQ-4.6); empty default window likewise', async () => {
    const admin = await seedAdmin();

    const zeroExpectation = {
      totals: {
        inputTokens: '0',
        outputTokens: '0',
        billedCredits: '0',
        providerCost: null,
        providerCostCoverage: { records: 0, recordsWithRawCost: 0 },
      },
      series: [],
      topUsers: [],
      revenue: { credited: '0', reversed: '0', net: '0' },
    };

    const same = '2026-03-01T00:00:00.000Z';
    const equalRes = await get(usagePath(same, same), admin.token);
    expect(equalRes.status).toBe(200);
    expect(AdminUsageSchema.parse(await equalRes.json())).toMatchObject(zeroExpectation);

    const futureRes = await get(
      usagePath('2030-01-01T00:00:00.000Z', '2030-01-31T00:00:00.000Z'),
      admin.token,
    );
    expect(futureRes.status).toBe(200);
    expect(AdminUsageSchema.parse(await futureRes.json())).toMatchObject(zeroExpectation);

    // Empty instance, default trailing-30-day window (REQ-8.3 analog).
    const defaultRes = await get('/api/admin/usage', admin.token);
    expect(defaultRes.status).toBe(200);
    expect(AdminUsageSchema.parse(await defaultRes.json())).toMatchObject(zeroExpectation);
  });
});

// ---------------------------------------------------------------------------
// 6. Bootstrap (REQ-8.4)
// ---------------------------------------------------------------------------

describe('bootstrapFirstAdmin', () => {
  let prevSeedEmail: string | undefined;

  beforeEach(() => {
    prevSeedEmail = config.SEED_ADMIN_EMAIL;
  });

  afterEach(() => {
    config.SEED_ADMIN_EMAIL = prevSeedEmail;
  });

  async function isAdminFlag(id: string): Promise<boolean> {
    const [row] = await db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, id));
    return row!.isAdmin;
  }

  it('promotes the seed email when ZERO admins exist', async () => {
    const user = await seedUser();
    config.SEED_ADMIN_EMAIL = user.email;
    await bootstrapFirstAdmin();
    expect(await isAdminFlag(user.id)).toBe(true);
  });

  it('no-ops when an admin already exists (never re-promotes a demoted user)', async () => {
    await seedUser({ isAdmin: true });
    const user = await seedUser();
    config.SEED_ADMIN_EMAIL = user.email;
    await bootstrapFirstAdmin();
    expect(await isAdminFlag(user.id)).toBe(false);
  });

  it('no-ops (without throwing) when the seed email is unregistered', async () => {
    const user = await seedUser();
    config.SEED_ADMIN_EMAIL = uniqueEmail('unregistered');
    await expect(bootstrapFirstAdmin()).resolves.toBeUndefined();
    expect(await isAdminFlag(user.id)).toBe(false);
  });

  it('no-ops when SEED_ADMIN_EMAIL is unset', async () => {
    const user = await seedUser();
    config.SEED_ADMIN_EMAIL = undefined;
    await expect(bootstrapFirstAdmin()).resolves.toBeUndefined();
    expect(await isAdminFlag(user.id)).toBe(false);
  });
});

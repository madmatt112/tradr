import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { BODY_LIMIT_BYTES, PerWidgetMinSize } from '@tradr/shared';

import app from '@/app';
import { db } from '@/db';
import { dashboardLayouts, sessions, users } from '@/db/schema';

import { clearDashboardCache } from './dashboard.service';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `dash-test${testRunId}-${++testCounter}@example.com`;
}

let ipCounter = 100;
function uniqueIp() {
  return `10.7.0.${++ipCounter}`;
}

function getCookieValue(res: Response, name: string): string | undefined {
  const setCookieHeaders = res.headers.getSetCookie();
  for (const header of setCookieHeaders) {
    const match = header.match(new RegExp(`${name}=([^;]*)`));
    if (match) return match[1];
  }
  return undefined;
}

function getSetCookieHeader(res: Response, name: string): string | undefined {
  for (const h of res.headers.getSetCookie()) {
    if (h.startsWith(`${name}=`)) return h;
  }
  return undefined;
}

async function registerAndGetCookie(): Promise<{ cookie: string; userId: string }> {
  const email = uniqueEmail();
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
  const meRes = await app.request('/api/auth/me', {
    method: 'GET',
    headers: { Cookie: `session=${cookie}`, 'X-Forwarded-For': uniqueIp() },
  });
  const me = (await meRes.json()) as { id: string };
  return { cookie, userId: me.id };
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

// Two non-overlapping minimal-valid widgets. Each must satisfy:
//   - x + w <= 12, w/h >= PerWidgetMinSize, unique types, no overlap.
function makeValidWidgets() {
  return [
    {
      id: randomUUID(),
      type: 'stats-summary' as const,
      x: 0,
      y: 0,
      w: 12,
      h: 2,
    },
    {
      id: randomUUID(),
      type: 'performance-chart' as const,
      x: 0,
      y: 2,
      w: 6,
      // Read from the schema's own minimum rather than written out: a chart
      // widget's minimum height is derived from the height its chart needs, so
      // a literal here goes stale the next time that changes and every case
      // below starts failing on the fixture instead of on what it tests.
      h: PerWidgetMinSize['performance-chart'].h,
    },
  ];
}

beforeEach(() => {
  clearDashboardCache();
});

describe('dashboard routes', () => {
  it('GET /api/dashboard/layout (no row) returns default layout with deterministic ids', async () => {
    const { cookie } = await registerAndGetCookie();

    const res1 = await authedRequest('GET', '/api/dashboard/layout', cookie);
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as {
      widgets: Array<{ id: string; type: string }>;
      updatedAt: string | null;
      theme: string;
    };
    expect(body1.updatedAt).toBeNull();
    expect(body1.widgets.length).toBe(6);

    // Clear cache to ensure determinism does not depend on cached array.
    clearDashboardCache();

    const res2 = await authedRequest('GET', '/api/dashboard/layout', cookie);
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { widgets: Array<{ id: string }> };
    expect(body2.widgets.map((w) => w.id)).toEqual(body1.widgets.map((w) => w.id));
  });

  it('GET /api/dashboard/layout (with row) returns the persisted row', async () => {
    const { cookie } = await registerAndGetCookie();
    const widgets = makeValidWidgets();
    const putRes = await authedRequest('PUT', '/api/dashboard/layout', cookie, {
      widgets,
    });
    expect(putRes.status).toBe(200);

    const res = await authedRequest('GET', '/api/dashboard/layout', cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      widgets: Array<{ id: string; type: string }>;
      updatedAt: string | null;
    };
    expect(body.widgets.map((w) => w.type)).toEqual(widgets.map((w) => w.type));
    expect(body.updatedAt).not.toBeNull();
  });

  it('PUT combined body updates both rows and sets theme cookie', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    const widgets = makeValidWidgets();

    const res = await authedRequest('PUT', '/api/dashboard/layout', cookie, {
      widgets,
      theme: 'dark',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      widgets: Array<{ id: string; type: string }>;
      theme: string;
      updatedAt: string;
    };
    expect(body.theme).toBe('dark');
    expect(body.widgets.map((w) => w.type)).toEqual(widgets.map((w) => w.type));

    // Verify on-disk state matches response
    const [userRow] = await db
      .select({ theme: users.theme })
      .from(users)
      .where(eq(users.id, userId));
    expect(userRow.theme).toBe('dark');
    const [layoutRow] = await db
      .select({ widgets: dashboardLayouts.widgets, updatedAt: dashboardLayouts.updatedAt })
      .from(dashboardLayouts)
      .where(eq(dashboardLayouts.userId, userId));
    expect(layoutRow.widgets.map((w) => w.type)).toEqual(widgets.map((w) => w.type));
    expect(layoutRow.updatedAt.toISOString()).toBe(body.updatedAt);

    // Set-Cookie assertions
    const setCookie = getSetCookieHeader(res, 'tradr_theme');
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain('tradr_theme=dark');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=31536000');
    expect(setCookie).not.toContain('Secure');
  });

  it('PUT widgets-only updates only the layout row and emits no theme cookie', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    const widgets = makeValidWidgets();

    const res = await authedRequest('PUT', '/api/dashboard/layout', cookie, { widgets });
    expect(res.status).toBe(200);

    expect(getSetCookieHeader(res, 'tradr_theme')).toBeUndefined();

    const [layoutRow] = await db
      .select({ widgets: dashboardLayouts.widgets })
      .from(dashboardLayouts)
      .where(eq(dashboardLayouts.userId, userId));
    expect(layoutRow.widgets.map((w) => w.type)).toEqual(widgets.map((w) => w.type));

    // users.theme unchanged from default
    const [userRow] = await db
      .select({ theme: users.theme })
      .from(users)
      .where(eq(users.id, userId));
    expect(userRow.theme).toBe('system');
  });

  it('PUT theme-only first-ever returns default-built layout with null updatedAt and inserts no row (J(a))', async () => {
    const { cookie, userId } = await registerAndGetCookie();

    const res = await authedRequest('PUT', '/api/dashboard/layout', cookie, { theme: 'dark' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      widgets: Array<{ id: string; type: string }>;
      theme: string;
      updatedAt: string | null;
    };
    expect(body.theme).toBe('dark');
    expect(body.updatedAt).toBeNull();
    expect(body.widgets.length).toBe(6);

    // No dashboard_layouts row written
    const countRows = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(dashboardLayouts)
      .where(eq(dashboardLayouts.userId, userId));
    expect(countRows[0].c).toBe(0);

    // users.theme updated
    const [userRow] = await db
      .select({ theme: users.theme })
      .from(users)
      .where(eq(users.id, userId));
    expect(userRow.theme).toBe('dark');
  });

  it('PUT theme-only when layout row exists returns existing widgets and does not rewrite the row (J(b))', async () => {
    const { cookie, userId } = await registerAndGetCookie();
    const widgets = makeValidWidgets();

    const seedRes = await authedRequest('PUT', '/api/dashboard/layout', cookie, { widgets });
    expect(seedRes.status).toBe(200);
    const seedBody = (await seedRes.json()) as { updatedAt: string };
    const preUpdatedAt = seedBody.updatedAt;

    // small wait to ensure any new "updated_at" would differ
    await new Promise((r) => setTimeout(r, 20));

    const res = await authedRequest('PUT', '/api/dashboard/layout', cookie, { theme: 'light' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      widgets: Array<{ id: string; type: string }>;
      updatedAt: string;
    };
    expect(body.widgets.map((w) => w.type)).toEqual(widgets.map((w) => w.type));
    expect(body.updatedAt).toBe(preUpdatedAt);

    // Row's updated_at unchanged
    const [layoutRow] = await db
      .select({ updatedAt: dashboardLayouts.updatedAt })
      .from(dashboardLayouts)
      .where(eq(dashboardLayouts.userId, userId));
    expect(layoutRow.updatedAt.toISOString()).toBe(preUpdatedAt);
  });

  it('PUT combined then theme-only returns identical widgets and stable updatedAt (J(c))', async () => {
    const { cookie } = await registerAndGetCookie();
    const widgets = makeValidWidgets();

    const first = await authedRequest('PUT', '/api/dashboard/layout', cookie, {
      widgets,
      theme: 'dark',
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      widgets: Array<{ id: string; type: string }>;
      updatedAt: string;
    };

    await new Promise((r) => setTimeout(r, 20));

    const second = await authedRequest('PUT', '/api/dashboard/layout', cookie, { theme: 'light' });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      widgets: Array<{ id: string; type: string }>;
      updatedAt: string;
    };

    expect(secondBody.widgets.map((w) => w.id)).toEqual(firstBody.widgets.map((w) => w.id));
    expect(secondBody.updatedAt).toBe(firstBody.updatedAt);
  });

  it('PUT empty body returns 400 ValidationError with required-field message', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('PUT', '/api/dashboard/layout', cookie, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string; fields?: Array<{ message: string }> };
    };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    const messages = [body.error.message, ...(body.error.fields?.map((f) => f.message) ?? [])].join(
      ' | ',
    );
    expect(messages).toMatch(/body must contain at least one of/i);
  });

  it('PUT content-length 17KB body returns 413 envelope and does not mutate either table', async () => {
    const { cookie, userId } = await registerAndGetCookie();

    const bigString = 'x'.repeat(17 * 1024);
    const body = JSON.stringify({ pad: bigString });

    const res = await app.request('/api/dashboard/layout', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
        Cookie: `session=${cookie}`,
        'X-Forwarded-For': uniqueIp(),
      },
      body,
    });
    expect(res.status).toBe(413);
    const json = (await res.json()) as {
      error: { code: string; message: string; requestId: unknown };
    };
    expect(json.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(json.error.message).toBe(`Request body exceeds ${BODY_LIMIT_BYTES} bytes`);

    // Rollback verified
    const countRows = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(dashboardLayouts)
      .where(eq(dashboardLayouts.userId, userId));
    expect(countRows[0].c).toBe(0);
    const [userRow] = await db
      .select({ theme: users.theme })
      .from(users)
      .where(eq(users.id, userId));
    expect(userRow.theme).toBe('system');
  });

  it('PUT 16KB body returns 200 (raw-body hand-off through zValidator)', async () => {
    const { cookie } = await registerAndGetCookie();
    const widgets = makeValidWidgets();

    // Construct a body that is <= BODY_LIMIT_BYTES (16384). Pad with whitespace
    // (JSON-significant only in arrays/strings → use a config string on widgets).
    const padTarget = BODY_LIMIT_BYTES - 1000;
    const padded = [{ ...widgets[0], config: { pad: 'a'.repeat(padTarget) } }, widgets[1]];
    const body = JSON.stringify({ widgets: padded });
    // Sanity-check we're within the limit.
    expect(body.length).toBeLessThanOrEqual(BODY_LIMIT_BYTES);
    expect(body.length).toBeGreaterThan(BODY_LIMIT_BYTES - 2000);

    // The widget-config limit is 2048 bytes (per WidgetPlacementSchema), so we
    // can't actually hit 16KB with a single widget config. Instead, send a
    // valid 16KB-ish body via repeated padding within widget configs.
    // Re-build to actually approach 16KB while respecting per-widget 2048-byte
    // config cap: use a 'config' on the second widget too. Total ~4KB of
    // configs; the rest is structural JSON. We just need a 200, not exact size.
    const w1Config = { pad: 'a'.repeat(2000) };
    const w2Config = { pad: 'b'.repeat(2000) };
    const padded2 = [
      { ...widgets[0], config: w1Config },
      { ...widgets[1], config: w2Config },
    ];
    const body2 = JSON.stringify({ widgets: padded2 });
    expect(body2.length).toBeLessThanOrEqual(BODY_LIMIT_BYTES);

    const res = await app.request('/api/dashboard/layout', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session=${cookie}`,
        'X-Forwarded-For': uniqueIp(),
      },
      body: body2,
    });
    expect(res.status).toBe(200);
  });

  it('PUT chunked stream > 16KB returns 413 with the §A-r4 envelope (integration regression surface)', async () => {
    const { cookie } = await registerAndGetCookie();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new TextEncoder().encode('x'.repeat(1700));
        for (let i = 0; i < 10; i++) controller.enqueue(chunk); // 17KB total
        controller.close();
      },
    });

    const res = await app.request('/api/dashboard/layout', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session=${cookie}`,
        'X-Forwarded-For': uniqueIp(),
      },
      body: stream,
      // @ts-expect-error - duplex required by undici/Node fetch when body is a stream
      duplex: 'half',
    });
    expect(res.status).toBe(413);
    const json = (await res.json()) as {
      error: { code: string; message: string; requestId: unknown };
    };
    expect(json.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(json.error.message).toBe(`Request body exceeds ${BODY_LIMIT_BYTES} bytes`);
  });

  it('PUT with overlapping rectangles returns 400 ValidationError and does not mutate state', async () => {
    const { cookie, userId } = await registerAndGetCookie();

    const overlapping = [
      {
        id: randomUUID(),
        type: 'stats-summary' as const,
        x: 0,
        y: 0,
        w: 12,
        h: 2,
      },
      {
        id: randomUUID(),
        type: 'performance-chart' as const,
        x: 0,
        y: 0,
        w: 6,
        // Legal on its own — the only thing wrong with this layout is that it
        // sits on top of the stats-summary above, which is what the case is for.
        h: PerWidgetMinSize['performance-chart'].h,
      },
    ];

    const res = await authedRequest('PUT', '/api/dashboard/layout', cookie, {
      widgets: overlapping,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');

    const countRows = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(dashboardLayouts)
      .where(eq(dashboardLayouts.userId, userId));
    expect(countRows[0].c).toBe(0);
  });

  it('GET /api/dashboard/theme returns 200 with Cache-Control: no-store and no DB mutation', async () => {
    const { cookie, userId } = await registerAndGetCookie();

    const res = await authedRequest('GET', '/api/dashboard/theme', cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { theme: string };
    expect(['light', 'dark', 'system']).toContain(body.theme);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(getSetCookieHeader(res, 'tradr_theme')).toBeUndefined();

    // No mutation
    const [userRow] = await db
      .select({ theme: users.theme })
      .from(users)
      .where(eq(users.id, userId));
    expect(userRow.theme).toBe('system');
  });

  it('POST /api/dashboard/theme-cookie empty body returns 204 with correct Set-Cookie attributes', async () => {
    const { cookie, userId } = await registerAndGetCookie();

    // Seed user theme to a non-default value to make the assertion meaningful.
    await db.update(users).set({ theme: 'dark' }).where(eq(users.id, userId));

    const res = await authedRequest('POST', '/api/dashboard/theme-cookie', cookie);
    expect(res.status).toBe(204);

    const setCookie = getSetCookieHeader(res, 'tradr_theme');
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain('tradr_theme=dark');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=31536000');
    expect(setCookie).not.toContain('Secure');
    expect(setCookie).not.toContain('HttpOnly');
  });

  it('POST /api/dashboard/theme-cookie with non-empty body returns 400 ValidationError', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await app.request('/api/dashboard/theme-cookie', {
      method: 'POST',
      headers: {
        Cookie: `session=${cookie}`,
        'Content-Type': 'text/plain',
        'X-Forwarded-For': uniqueIp(),
      },
      body: 'foo',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('unauthenticated requests to dashboard endpoints return 401', async () => {
    const endpoints: Array<[string, string, BodyInit | undefined]> = [
      ['GET', '/api/dashboard/layout', undefined],
      ['PUT', '/api/dashboard/layout', JSON.stringify({ theme: 'dark' })],
      ['GET', '/api/dashboard/theme', undefined],
      ['POST', '/api/dashboard/theme-cookie', undefined],
    ];
    for (const [method, path, body] of endpoints) {
      const res = await app.request(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': uniqueIp(),
        },
        body,
      });
      expect(res.status, `${method} ${path} should be 401 without auth`).toBe(401);
    }
  });

  it('session valid but user deleted between auth and service yields 401 (FK 23503 mapping)', async () => {
    // Insert a user and mint a session manually (bypass /register so we keep
    // control of the user id).
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: uniqueEmail(),
      passwordHash: 'unused',
    });
    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await db.insert(sessions).values({
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
    });

    // Delete the user — cascades to sessions. Whether the failure path is
    // (auth middleware no-row → 401) or (service FK 23503 → 401), the
    // observable outcome must be 401, per §I.
    await db.delete(users).where(eq(users.id, userId));

    const res = await app.request('/api/dashboard/layout', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session=${token}`,
        'X-Forwarded-For': uniqueIp(),
      },
      body: JSON.stringify({ theme: 'dark' }),
    });
    expect(res.status).toBe(401);
  });
});

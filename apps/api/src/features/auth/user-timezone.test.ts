import { readFile } from 'node:fs/promises';

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { DEFAULT_REPORTING_TIMEZONE } from '@tradr/shared';

import app from '@/app';
import { db } from '@/db';
import { users } from '@/db/schema';

// A sibling of auth.test.ts rather than an addition to it: that file's closing
// test pins the four frozen auth response shapes byte-for-byte, and the
// reporting timezone is a separate preference surface that happens to be seeded
// by the same register call.

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `tz-test${testRunId}-${++testCounter}@example.com`;
}

// Own /8 sub-range (auth.test.ts owns 10.0, password-reset 10.20,
// verification 10.30) so the register limiter never sees a shared client.
let ipCounter = 0;
function uniqueIp() {
  return `10.31.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
}

function getCookieValue(res: Response, name: string): string | undefined {
  for (const header of res.headers.getSetCookie()) {
    const match = header.match(new RegExp(`${name}=([^;]*)`));
    if (match) return match[1];
  }
  return undefined;
}

function register(body: Record<string, unknown>) {
  return app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() },
    body: JSON.stringify(body),
  });
}

async function registerAndGetCookie(
  extra: Record<string, unknown> = {},
): Promise<{ cookie: string; email: string }> {
  const email = uniqueEmail();
  const res = await register({ email, password: 'password123', ...extra });
  expect(res.status).toBe(201);
  const cookie = getCookieValue(res, 'session');
  expect(cookie).toBeDefined();
  return { cookie: cookie!, email };
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

/** The column verbatim — `null` distinguishes a pre-migration row from a seed. */
function storedTimezone(email: string) {
  return db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.email, email))
    .then((rows) => rows[0]?.timezone);
}

async function getTimezoneBody(cookie: string): Promise<{ timezone: string; stored: boolean }> {
  const res = await authedRequest('GET', '/api/users/me/timezone', cookie);
  expect(res.status).toBe(200);
  return await res.json();
}

async function getTimezone(cookie: string) {
  return (await getTimezoneBody(cookie)).timezone;
}

describe('registration seeds the reporting timezone', () => {
  it('persists a browser-detected zone supplied at registration', async () => {
    const { cookie, email } = await registerAndGetCookie({ timezone: 'Europe/London' });
    expect(await storedTimezone(email)).toBe('Europe/London');
    expect(await getTimezone(cookie)).toBe('Europe/London');
  });

  it('falls back to the default when no zone is supplied', async () => {
    // Absent ⇒ a defined default is STORED, not left null to be guessed at
    // later. The stored value, not just the read, is asserted.
    const { cookie, email } = await registerAndGetCookie();
    expect(await storedTimezone(email)).toBe(DEFAULT_REPORTING_TIMEZONE);
    expect(await getTimezone(cookie)).toBe(DEFAULT_REPORTING_TIMEZONE);
  });

  it('rejects an invalid zone at registration without creating the user', async () => {
    const email = uniqueEmail();
    const res = await register({ email, password: 'password123', timezone: 'Mars/Olympus_Mons' });
    expect(res.status).toBe(400);
    expect(await storedTimezone(email)).toBeUndefined();
  });

  it('accepts a zone Intl.supportedValuesOf omits', async () => {
    // Etc/* and bare UTC are real zones the picker list does not carry; the
    // register path must not narrow to that list.
    const { email } = await registerAndGetCookie({ timezone: 'Etc/GMT+5' });
    expect(await storedTimezone(email)).toBe('Etc/GMT+5');
  });
});

describe('GET/PUT /api/users/me/timezone', () => {
  it('resolves a pre-migration NULL column to the default, flagged as NOT stored', async () => {
    // Rows that predate the column must read without erroring. NULLing the
    // column directly is the only way to reach that state now that
    // registration always seeds one.
    const { cookie, email } = await registerAndGetCookie({ timezone: 'Asia/Tokyo' });
    await db.update(users).set({ timezone: null }).where(eq(users.email, email));
    expect(await storedTimezone(email)).toBeNull();

    // `stored: false` is what lets a client tell "never set" from "deliberately
    // UTC" and seed the row once with the zone that user was already bucketed
    // by. Without it the two are the same response and no backfill is safe.
    expect(await getTimezoneBody(cookie)).toEqual({
      timezone: DEFAULT_REPORTING_TIMEZONE,
      stored: false,
    });
    // The read stays side-effect-free — it must not backfill the column.
    expect(await storedTimezone(email)).toBeNull();
  });

  it('flags a deliberately-UTC row as stored, distinguishing it from a NULL one', async () => {
    // The pair this endpoint has to keep apart: both read `timezone: 'UTC'`,
    // and only one of them may be overwritten by a client-side backfill.
    const { cookie } = await registerAndGetCookie({ timezone: 'UTC' });
    expect(await getTimezoneBody(cookie)).toEqual({ timezone: 'UTC', stored: true });
  });

  it('flags a seeded zone as stored', async () => {
    const { cookie } = await registerAndGetCookie({ timezone: 'Europe/London' });
    expect(await getTimezoneBody(cookie)).toEqual({ timezone: 'Europe/London', stored: true });
  });

  it('round-trips a change through PUT', async () => {
    const { cookie, email } = await registerAndGetCookie();

    const put = await authedRequest('PUT', '/api/users/me/timezone', cookie, {
      timezone: 'Australia/Sydney',
    });
    expect(put.status).toBe(200);
    // Same shape as the GET; a write makes the value stored by construction.
    expect(await put.json()).toEqual({ timezone: 'Australia/Sydney', stored: true });

    expect(await getTimezoneBody(cookie)).toEqual({
      timezone: 'Australia/Sydney',
      stored: true,
    });
    expect(await storedTimezone(email)).toBe('Australia/Sydney');
  });

  it('turns a pre-migration NULL into a stored zone once written', async () => {
    // The exact transition the one-time client backfill drives: `stored: false`
    // → PUT the browser zone → `stored: true`, after which nothing may
    // overwrite it again.
    const { cookie, email } = await registerAndGetCookie();
    await db.update(users).set({ timezone: null }).where(eq(users.email, email));
    expect((await getTimezoneBody(cookie)).stored).toBe(false);

    const put = await authedRequest('PUT', '/api/users/me/timezone', cookie, {
      timezone: 'America/New_York',
    });
    expect(put.status).toBe(200);

    expect(await getTimezoneBody(cookie)).toEqual({
      timezone: 'America/New_York',
      stored: true,
    });
  });

  it('rejects an invalid zone with 400 and leaves the stored value alone', async () => {
    const { cookie, email } = await registerAndGetCookie({ timezone: 'Europe/Paris' });

    const res = await authedRequest('PUT', '/api/users/me/timezone', cookie, {
      timezone: 'Not/AZone',
    });
    expect(res.status).toBe(400);
    expect(await storedTimezone(email)).toBe('Europe/Paris');
  });

  it('rejects the Unicode-extension bypass and an over-length value', async () => {
    const { cookie } = await registerAndGetCookie();

    const decorated = await authedRequest('PUT', '/api/users/me/timezone', cookie, {
      timezone: 'America/New_York-u-ca-japanese',
    });
    expect(decorated.status).toBe(400);

    const tooLong = await authedRequest('PUT', '/api/users/me/timezone', cookie, {
      timezone: `America/${'x'.repeat(64)}`,
    });
    expect(tooLong.status).toBe(400);
  });

  it('rejects a missing body field', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('PUT', '/api/users/me/timezone', cookie, {});
    expect(res.status).toBe(400);
  });

  it('requires authentication on both verbs', async () => {
    const get = await app.request('/api/users/me/timezone', {
      headers: { 'X-Forwarded-For': uniqueIp() },
    });
    expect(get.status).toBe(401);

    const put = await app.request('/api/users/me/timezone', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() },
      body: JSON.stringify({ timezone: 'Europe/London' }),
    });
    expect(put.status).toBe(401);
  });

  it('is scoped to the calling user and ignores a userId in the body', async () => {
    const a = await registerAndGetCookie({ timezone: 'Europe/Lisbon' });
    const b = await registerAndGetCookie({ timezone: 'Asia/Kolkata' });

    const bRow = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, b.email))
      .then((rows) => rows[0]);

    // A names B and asks for B's zone to change. The endpoint takes its subject
    // from the session only, so this writes A's row and leaves B's untouched.
    const res = await authedRequest('PUT', '/api/users/me/timezone', a.cookie, {
      userId: bRow.id,
      timezone: 'Pacific/Auckland',
    });
    expect(res.status).toBe(200);

    expect(await storedTimezone(a.email)).toBe('Pacific/Auckland');
    expect(await storedTimezone(b.email)).toBe('Asia/Kolkata');

    // And neither session can read the other's value.
    expect(await getTimezone(a.cookie)).toBe('Pacific/Auckland');
    expect(await getTimezone(b.cookie)).toBe('Asia/Kolkata');
  });
});

// The zone is a BUCKETING zone and nothing else. Timestamps are rendered by
// `lib/format.ts` in the browser zone, by `optionContract.ts` in UTC and by
// `reopenWindow.ts` in the ACCOUNT zone — so any surface claiming this column
// is "the zone timestamps are displayed in" is stating something false about
// three other modules. The claim was written into five places at once and
// corrected in four; only this test stops the fifth from drifting back.
describe('the reporting timezone is documented as a bucketing zone, not a display zone', () => {
  const SURFACES = [
    'db/migrations/0026_user_reporting_timezone.sql',
    'db/schema/users.schema.ts',
    'features/auth/auth.route.ts',
  ];

  it.each(SURFACES)('%s describes bucketing and never claims a display zone', async (relPath) => {
    const source = await readFile(new URL(`../../${relPath}`, import.meta.url), 'utf8');
    // Strip the comment markers and collapse the wrapping before matching: the
    // original claim was split across two comment lines ("…and timestamps\n--
    // are displayed in…"), so a naive regex over the raw file misses it.
    const prose = source.replace(/^[ \t]*(?:--|\/\/|\*|\/\*)+/gm, ' ').replace(/\s+/g, ' ');

    expect(prose).toMatch(/bucketed/);
    expect(prose).not.toMatch(/timestamps? (?:are|is) displayed in/i);
  });
});

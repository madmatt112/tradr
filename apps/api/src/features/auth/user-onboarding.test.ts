import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { MAX_COACH_MARKS_SEEN } from '@tradr/shared';
import type { StoredOnboardingState } from '@tradr/shared';

import app from '@/app';
import { db } from '@/db';
import { users } from '@/db/schema';

// A sibling of auth.test.ts and user-timezone.test.ts: onboarding is its own
// preference surface, and auth.test.ts's closing test pins the frozen auth
// response shapes byte-for-byte and is better left focused.

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `onb-test${testRunId}-${++testCounter}@example.com`;
}

// Own /8 sub-range (auth.test.ts owns 10.0, password-reset 10.20, verification
// 10.30, timezone 10.31) so the register limiter never sees a shared client.
let ipCounter = 0;
function uniqueIp() {
  return `10.32.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
}

function getCookieValue(res: Response, name: string): string | undefined {
  for (const header of res.headers.getSetCookie()) {
    const match = header.match(new RegExp(`${name}=([^;]*)`));
    if (match) return match[1];
  }
  return undefined;
}

async function registerAndGetCookie(): Promise<{ cookie: string; email: string }> {
  const email = uniqueEmail();
  const res = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() },
    body: JSON.stringify({ email, password: 'password123' }),
  });
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

/** The column verbatim, unparsed — the only way to see keys the schema strips. */
function storedOnboarding(email: string) {
  return db
    .select({ onboarding: users.onboarding })
    .from(users)
    .where(eq(users.email, email))
    .then((rows) => rows[0]?.onboarding as Record<string, unknown> | undefined);
}

function setStoredOnboarding(email: string, value: Record<string, unknown>) {
  return db
    .update(users)
    .set({ onboarding: value as StoredOnboardingState })
    .where(eq(users.email, email));
}

async function getOnboarding(cookie: string) {
  const res = await authedRequest('GET', '/api/users/me/onboarding', cookie);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    status: string;
    coachMarksSeen: string[];
    calculatorFirstUsedAt?: string;
  };
}

async function patchOnboarding(cookie: string, body: unknown) {
  return authedRequest('PATCH', '/api/users/me/onboarding', cookie, body);
}

describe('GET /api/users/me/onboarding', () => {
  it('resolves an empty column to the schema defaults', async () => {
    // The column's DEFAULT is '{}', so this is what every registered user and
    // every pre-migration row reads as. The defaults come from the shared
    // schema, not from fallbacks in the handler.
    const { cookie, email } = await registerAndGetCookie();
    expect(await storedOnboarding(email)).toEqual({});

    expect(await getOnboarding(cookie)).toEqual({ status: 'pending', coachMarksSeen: [] });
  });

  it('omits calculatorFirstUsedAt until it is recorded', async () => {
    // Absent is meaningful — the calculator has not been used — so it must not
    // be defaulted to a timestamp or nulled.
    const { cookie } = await registerAndGetCookie();
    expect('calculatorFirstUsedAt' in (await getOnboarding(cookie))).toBe(false);
  });

  it('is side-effect-free', async () => {
    // The SameSite=Lax cookie posture makes any side-effecting GET a CSRF
    // vector, so the read must not "helpfully" materialise the defaults it
    // resolves. Asserted on the raw column, which stays '{}'.
    const { cookie, email } = await registerAndGetCookie();
    await getOnboarding(cookie);
    expect(await storedOnboarding(email)).toEqual({});
  });
});

describe('PATCH /api/users/me/onboarding merges rather than replaces', () => {
  it('sets a status without clearing the coach marks', async () => {
    const { cookie } = await registerAndGetCookie();

    await patchOnboarding(cookie, { coachMarkSeen: 'csv-import' });
    const res = await patchOnboarding(cookie, { status: 'skipped' });
    expect(res.status).toBe(200);

    // The body naming only `status` must leave coachMarksSeen exactly as found.
    expect(await res.json()).toEqual({ status: 'skipped', coachMarksSeen: ['csv-import'] });
    expect(await getOnboarding(cookie)).toEqual({
      status: 'skipped',
      coachMarksSeen: ['csv-import'],
    });
  });

  it('appends a coach mark without disturbing the status', async () => {
    const { cookie } = await registerAndGetCookie();

    await patchOnboarding(cookie, { status: 'active' });
    const res = await patchOnboarding(cookie, { coachMarkSeen: 'scale-in' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'active', coachMarksSeen: ['scale-in'] });
  });

  it('appends the same coach mark twice without duplicating it', async () => {
    const { cookie } = await registerAndGetCookie();

    await patchOnboarding(cookie, { coachMarkSeen: 'widget-management' });
    const second = await patchOnboarding(cookie, { coachMarkSeen: 'widget-management' });
    // Idempotent, not an error: a re-mounted component re-dismissing a mark is
    // ordinary, and the client should not have to check first.
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      status: 'pending',
      coachMarksSeen: ['widget-management'],
    });
  });

  it('accumulates distinct coach marks', async () => {
    const { cookie } = await registerAndGetCookie();

    for (const key of ['partial-close', 'scale-in', 'csv-import']) {
      expect((await patchOnboarding(cookie, { coachMarkSeen: key })).status).toBe(200);
    }
    expect((await getOnboarding(cookie)).coachMarksSeen).toEqual([
      'partial-close',
      'scale-in',
      'csv-import',
    ]);
  });

  it('records calculatorFirstUsedAt without disturbing the other fields', async () => {
    const { cookie } = await registerAndGetCookie();
    await patchOnboarding(cookie, { status: 'active' });
    await patchOnboarding(cookie, { coachMarkSeen: 'options-tools' });

    const at = '2026-08-06T12:00:00.000Z';
    const res = await patchOnboarding(cookie, { calculatorFirstUsedAt: at });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'active',
      coachMarksSeen: ['options-tools'],
      calculatorFirstUsedAt: at,
    });
  });

  it('applies status, timestamp and coach mark in one body', async () => {
    const { cookie } = await registerAndGetCookie();
    const at = '2026-08-06T09:30:00.000Z';

    const res = await patchOnboarding(cookie, {
      status: 'done',
      calculatorFirstUsedAt: at,
      coachMarkSeen: 'partial-close',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'done',
      calculatorFirstUsedAt: at,
      coachMarksSeen: ['partial-close'],
    });
  });

  it('makes a skipped checklist recoverable', async () => {
    // Dismissal must be re-openable without support intervention, which is just
    // another PATCH.
    const { cookie } = await registerAndGetCookie();
    await patchOnboarding(cookie, { status: 'skipped' });
    expect((await getOnboarding(cookie)).status).toBe('skipped');

    await patchOnboarding(cookie, { status: 'active' });
    expect((await getOnboarding(cookie)).status).toBe('active');
  });
});

describe('PATCH preserves state this deployment does not know about', () => {
  it('leaves a key written by a newer deployment intact', async () => {
    // THE ROLLING-DEPLOY HAZARD. OnboardingStateSchema STRIPS unknown keys on
    // read, so a handler that read, parsed, merged and wrote the whole object
    // back would silently delete whatever a newer container had written. The
    // merge happens in SQL and names only the keys in the body, so it cannot.
    const { cookie, email } = await registerAndGetCookie();
    await setStoredOnboarding(email, {
      status: 'active',
      coachMarksSeen: ['csv-import'],
      tourVariant: 'v2-from-a-newer-deployment',
    });

    expect((await patchOnboarding(cookie, { status: 'done' })).status).toBe(200);

    const raw = await storedOnboarding(email);
    expect(raw?.tourVariant).toBe('v2-from-a-newer-deployment');
    expect(raw?.status).toBe('done');
    expect(raw?.coachMarksSeen).toEqual(['csv-import']);

    // The response is still this deployment's known shape — the unknown key is
    // preserved in storage, not leaked onto the wire.
    expect(await getOnboarding(cookie)).toEqual({ status: 'done', coachMarksSeen: ['csv-import'] });
  });

  it('leaves an unknown key intact while appending a coach mark', async () => {
    const { cookie, email } = await registerAndGetCookie();
    await setStoredOnboarding(email, { coachMarksSeen: ['a'], futureKey: { nested: true } });

    expect((await patchOnboarding(cookie, { coachMarkSeen: 'b' })).status).toBe(200);

    const raw = await storedOnboarding(email);
    expect(raw?.futureKey).toEqual({ nested: true });
    expect(raw?.coachMarksSeen).toEqual(['a', 'b']);
  });
});

describe('PATCH is safe under interleaved writes', () => {
  it('keeps both coach marks when two tabs append at once', async () => {
    // The lost-update case a read-modify-write cannot survive: both requests
    // read the same array and the second write drops the first's key. The merge
    // is one UPDATE, so PostgreSQL's row lock serialises them and the second
    // re-evaluates against the first's committed value.
    const { cookie } = await registerAndGetCookie();

    const [first, second] = await Promise.all([
      patchOnboarding(cookie, { coachMarkSeen: 'tab-one' }),
      patchOnboarding(cookie, { coachMarkSeen: 'tab-two' }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    expect((await getOnboarding(cookie)).coachMarksSeen.sort()).toEqual(['tab-one', 'tab-two']);
  });

  it('keeps a concurrent status change and coach-mark append together', async () => {
    // Different keys, so neither request has to know about the other's field.
    const { cookie } = await registerAndGetCookie();

    await Promise.all([
      patchOnboarding(cookie, { status: 'done' }),
      patchOnboarding(cookie, { coachMarkSeen: 'scale-in' }),
    ]);

    expect(await getOnboarding(cookie)).toEqual({
      status: 'done',
      coachMarksSeen: ['scale-in'],
    });
  });

  it('caps the coach-mark set rather than growing it without limit', async () => {
    // Nothing ever removes a key, so an uncapped append is unbounded growth of
    // one row's jsonb by an authenticated client. Past the cap the append is a
    // no-op — a coach mark is a UI nicety, and the cap is an order of magnitude
    // above the five surfaces that carry one.
    const { cookie, email } = await registerAndGetCookie();
    const full = Array.from({ length: MAX_COACH_MARKS_SEEN }, (_, i) => `mark-${i}`);
    await setStoredOnboarding(email, { coachMarksSeen: full });

    const res = await patchOnboarding(cookie, { coachMarkSeen: 'one-too-many' });
    expect(res.status).toBe(200);
    expect((await res.json()).coachMarksSeen).toEqual(full);

    // The rest of the body still applies — the cap silences the append only.
    const withStatus = await patchOnboarding(cookie, {
      status: 'done',
      coachMarkSeen: 'one-too-many',
    });
    expect((await withStatus.json()).status).toBe('done');
  });
});

describe('PATCH validation', () => {
  it('rejects an invalid status with 400 and changes nothing', async () => {
    const { cookie } = await registerAndGetCookie();
    await patchOnboarding(cookie, { status: 'active' });

    const res = await patchOnboarding(cookie, { status: 'finished' });
    expect(res.status).toBe(400);
    expect((await getOnboarding(cookie)).status).toBe('active');
  });

  it('rejects an unknown field', async () => {
    // Strict on the wire, unlike the state schema, whose author may be a newer
    // deployment. Here the author is a client and an unexpected key is a bug.
    const { cookie } = await registerAndGetCookie();
    const res = await patchOnboarding(cookie, { accountCreated: true });
    expect(res.status).toBe(400);
  });

  it('rejects an empty body', async () => {
    const { cookie } = await registerAndGetCookie();
    expect((await patchOnboarding(cookie, {})).status).toBe(400);
  });

  it('rejects a non-ISO calculatorFirstUsedAt and an over-length coach mark', async () => {
    const { cookie } = await registerAndGetCookie();

    const badDate = await patchOnboarding(cookie, { calculatorFirstUsedAt: '2026-08-06' });
    expect(badDate.status).toBe(400);

    const longKey = await patchOnboarding(cookie, { coachMarkSeen: 'x'.repeat(65) });
    expect(longKey.status).toBe(400);

    const emptyKey = await patchOnboarding(cookie, { coachMarkSeen: '' });
    expect(emptyKey.status).toBe(400);
  });

  it('rejects a coachMarksSeen array — the whole set is never sent', async () => {
    // The plural field is deliberately not accepted: a client that could send
    // the array could shrink the set by omission and clobber another tab's mark.
    const { cookie } = await registerAndGetCookie();
    const res = await patchOnboarding(cookie, { coachMarksSeen: ['a', 'b'] });
    expect(res.status).toBe(400);
  });
});

describe('onboarding preference is scoped to the calling user', () => {
  it('requires authentication on both verbs', async () => {
    const get = await app.request('/api/users/me/onboarding', {
      headers: { 'X-Forwarded-For': uniqueIp() },
    });
    expect(get.status).toBe(401);

    const patch = await app.request('/api/users/me/onboarding', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() },
      body: JSON.stringify({ status: 'done' }),
    });
    expect(patch.status).toBe(401);
  });

  it('ignores a userId in the body and never reads another user', async () => {
    const a = await registerAndGetCookie();
    const b = await registerAndGetCookie();
    await patchOnboarding(b.cookie, { status: 'active', coachMarkSeen: 'b-only' });

    const bRow = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, b.email))
      .then((rows) => rows[0]);

    // A names B and asks for B's preference to change. The subject comes from
    // the session only, so the extra key is a 400 and nothing is written at all.
    const res = await patchOnboarding(a.cookie, { userId: bRow.id, status: 'done' });
    expect(res.status).toBe(400);
    expect(await storedOnboarding(a.email)).toEqual({});

    // A's own write lands on A's row and leaves B's alone.
    expect((await patchOnboarding(a.cookie, { status: 'done' })).status).toBe(200);
    expect(await getOnboarding(a.cookie)).toEqual({ status: 'done', coachMarksSeen: [] });
    expect(await getOnboarding(b.cookie)).toEqual({
      status: 'active',
      coachMarksSeen: ['b-only'],
    });
  });
});

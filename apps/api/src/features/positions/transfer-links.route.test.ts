import { eq, inArray } from 'drizzle-orm';
import { describe, it, expect } from 'vitest';

import app from '@/app';
import { db } from '@/db';
import { fillTransferLinks, ledgerEntries, positions } from '@/db/schema';

/**
 * Contract — task 9, design C7, AC 6.1/6.4/6.6/6.7, NFR Security
 *
 * 1. Pre: posA (accountA) has entry 15 + exit 10 (open, exit = exitA); posB
 *    (accountB, same user) has entry 10 (open, entry = entryB) — same symbol
 *    and side as posA, equal quantity, a different account.
 *    Call: PUT /api/positions/:posA.id/fills/:exitA.id/transfer-link
 *    { entryFillId: entryB.id }, then GET the same path.
 *    Observe: PUT 200 with exitFillId/entryFillId/entryPositionId/
 *    entryAccountId/entryAccountName matching exitA/entryB/posB/accountB;
 *    GET's `link` equals the PUT body.
 *    Expected value source: design C7 routes/TransferLinkView and AC 6.1's
 *    storage rule.
 * 2. Six 409-reason cases, each a distinct rule violation from AC 6.1 /
 *    design C7 post-condition 1 (not_an_entry via wrong fill type,
 *    same_account, different_security, quantity_mismatch, exit_already_linked,
 *    entry_already_linked). Call: PUT with the violating entryFillId.
 *    Observe: 409, `error.message` starts with the named reason.
 *    Expected value source: design C7 post-condition 1's reason list, in the
 *    order design states it.
 * 3. Pre: a second, unrelated user owns entryFillId.
 *    Call: PUT with that user's entryFillId as entryFillId.
 *    Observe: 409 not_an_entry; no row in fill_transfer_links for exitA.
 *    Expected value source: NFR Security ("a fill id from another user SHALL
 *    be refused, never resolved") plus AC 6.1's reason list.
 * 4. Pre: two valid exits (exitA, exitC) each eligible to link to the same
 *    entryB.
 *    Call: both PUTs fired concurrently.
 *    Observe: exactly one 200 and one 409 entry_already_linked; exactly one
 *    row in fill_transfer_links for entryB.
 *    Expected value source: design C7 post-condition 1's unique-violation
 *    catch (the race loser gets the same 409, not a 500).
 * 5. Pre: entryB (eligible), plus decoys: a quantity mismatch, a different
 *    symbol, a same-account entry, and an entry already linked elsewhere.
 *    Call: GET /api/positions/:posA.id/fills/:exitA.id/transfer-link.
 *    Observe: `candidates` contains exactly entryB's entryFillId.
 *    Expected value source: design C7 route doc ("Candidates are the
 *    caller's entry fills in other accounts, same symbol and side, equal
 *    quantity, in no link", AC 6.5).
 * 6. Pre: an established link.
 *    Call: DELETE the link path, then DELETE it again.
 *    Observe: 204, then 404.
 *    Expected value source: design C7 routes and AC 6.4 ("the user SHALL be
 *    able to remove a link").
 * 7. Pre: an established link.
 *    7a. Call: DELETE the exit fill itself.
 *         Observe: 204; no row in fill_transfer_links for entryB afterwards.
 *    7b. Call: DELETE the entry's position.
 *         Observe: 204; no row in fill_transfer_links for exitA afterwards.
 *    Expected value source: AC 6.4 ("WHEN either fill or its position is
 *    removed THEN the link SHALL be removed with it") and design's FK
 *    cascade (Data Models, fill_transfer_links).
 * 8. Pre: an established link.
 *    Call: PUT the link.
 *    Observe: ledger_entries rows for posA/posB, and the positions rows
 *    themselves, are unchanged before vs. after.
 *    Expected value source: AC 6.6 ("the journal, ledger, positions ... SHALL
 *    be unchanged") and design C7 post-condition 2 ("no fill hook, ledger
 *    write or position change runs").
 * 9. Pre: posA belongs to user A.
 *    Call: user B's session GETs posA's transfer-link path.
 *    Observe: 404.
 *    Expected value source: NFR Security / the shared `findPositionForUpdate`
 *    cross-user scoping already used by the fills and lots routes.
 *
 * Red-first: none of the three routes exist at base (unmounted) — the setup
 * PUT inside every case above 404s before any assertion on that case's own
 * behaviour is reached.
 *
 * Not red (regression guard, named for the implementer): a no-session call
 * on this path already 401s at base, because `fillsRouter`/`lotsRouter`/
 * `positionImagesRouter` already apply `authMiddleware` to every path under
 * `/api/positions/*`, matched before any specific route 404s. See the final
 * test in this file.
 *
 * Not tested here (AC 6.7 — swagger block + regenerated tradr-api.json): a
 * generated-docs requirement with no code seam to call through vitest; it is
 * satisfied by the implementer regenerating the doc in the same change, not
 * by an assertion in this file.
 */

let emailCounter = 0;
function uniqueEmail() {
  return `transfer-link-test${++emailCounter}-${Date.now()}@example.com`;
}

let ipCounter = 0;
function uniqueIp() {
  const n = ++ipCounter;
  const b = (n >> 8) & 255;
  const c = n & 255;
  return `10.9.${b}.${c || 1}`;
}

function getCookieValue(res: Response, name: string): string | undefined {
  const setCookieHeaders = res.headers.getSetCookie();
  for (const header of setCookieHeaders) {
    const match = header.match(new RegExp(`${name}=([^;]*)`));
    if (match) return match[1];
  }
  return undefined;
}

async function registerAndGetCookie(email = uniqueEmail()): Promise<{ cookie: string }> {
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
  return { cookie };
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

let acctCounter = 0;
async function createTestAccount(cookie: string) {
  const res = await authedRequest('POST', '/api/accounts', cookie, {
    name: `Transfer Link Test Account ${++acctCounter}-${Date.now()}`,
    currency: 'USD',
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function createDraftPosition(cookie: string, accountId: string, opts?: { symbol?: string }) {
  const res = await authedRequest('POST', '/api/positions', cookie, {
    accountId,
    symbol: opts?.symbol ?? 'AAPL',
    side: 'long',
    assetType: 'stock',
  });
  expect(res.status).toBe(201);
  return res.json();
}

function makeFill(
  overrides: Partial<{
    type: string;
    price: string;
    quantity: string;
    fees: string;
    filledAt: string;
  }>,
) {
  return {
    type: 'entry',
    price: '150.00',
    quantity: '10',
    fees: '1.00',
    filledAt: '2025-01-15T10:00:00Z',
    ...overrides,
  };
}

async function addFill(cookie: string, positionId: string, fill: ReturnType<typeof makeFill>) {
  const res = await authedRequest('POST', `/api/positions/${positionId}/fills`, cookie, fill);
  expect(res.status).toBe(201);
  return res.json();
}

async function openPos(cookie: string, positionId: string) {
  const res = await authedRequest('POST', `/api/positions/${positionId}/open`, cookie, {});
  expect(res.status).toBe(200);
  return res.json();
}

function linkPath(positionId: string, fillId: string) {
  return `/api/positions/${positionId}/fills/${fillId}/transfer-link`;
}

/** posA (accountA): entry 15 + exit 10 (open, exit = exitA). posB
 * (accountB, same user): entry 10 (open, entry = entryB) — same symbol/side
 * as posA, equal quantity to exitA, a different account. */
async function setupLinkablePair() {
  const { cookie } = await registerAndGetCookie();
  const accountA = await createTestAccount(cookie);
  const accountB = await createTestAccount(cookie);

  const posA = await createDraftPosition(cookie, accountA.id);
  await addFill(
    cookie,
    posA.id,
    makeFill({ type: 'entry', quantity: '15', filledAt: '2025-01-01T10:00:00Z' }),
  );
  await openPos(cookie, posA.id);
  const exitA = await addFill(
    cookie,
    posA.id,
    makeFill({ type: 'exit', quantity: '10', filledAt: '2025-02-01T10:00:00Z' }),
  );

  const posB = await createDraftPosition(cookie, accountB.id);
  const entryB = await addFill(
    cookie,
    posB.id,
    makeFill({ type: 'entry', quantity: '10', filledAt: '2025-01-05T10:00:00Z' }),
  );
  await openPos(cookie, posB.id);

  return { cookie, accountA, accountB, posA, posB, exitA, entryB };
}

/** A self-contained entry+exit pair the caller owns, unrelated to any other
 * fixture — used to supply a stray exit fill id (wrong type) or a second
 * valid exit for a race/collision case. */
async function createOwnEntryAndExit(cookie: string, quantity = '10') {
  const account = await createTestAccount(cookie);
  const pos = await createDraftPosition(cookie, account.id);
  const entry = await addFill(
    cookie,
    pos.id,
    makeFill({ type: 'entry', quantity, filledAt: '2025-01-01T10:00:00Z' }),
  );
  await openPos(cookie, pos.id);
  const exit = await addFill(
    cookie,
    pos.id,
    makeFill({ type: 'exit', quantity, filledAt: '2025-01-05T10:00:00Z' }),
  );
  return { account, pos, entry, exit };
}

describe('transfer-link routes', () => {
  it('PUT links an exit to an equal-quantity entry of the same symbol/side in another account; GET returns it', async () => {
    const { posA, posB, exitA, entryB, accountB, cookie } = await setupLinkablePair();

    const putRes = await authedRequest('PUT', linkPath(posA.id, exitA.id), cookie, {
      entryFillId: entryB.id,
    });
    expect(putRes.status).toBe(200);
    const link = await putRes.json();
    expect(link.exitFillId).toBe(exitA.id);
    expect(link.entryFillId).toBe(entryB.id);
    expect(link.entryPositionId).toBe(posB.id);
    expect(link.entryAccountId).toBe(accountB.id);
    expect(link.entryAccountName).toBe(accountB.name);
    expect(typeof link.id).toBe('string');

    const getRes = await authedRequest('GET', linkPath(posA.id, exitA.id), cookie);
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.link).toEqual(link);
  });

  it('refuses 409 not_an_entry when entryFillId names an exit fill', async () => {
    const { posA, exitA, cookie } = await setupLinkablePair();
    const stray = await createOwnEntryAndExit(cookie);

    const res = await authedRequest('PUT', linkPath(posA.id, exitA.id), cookie, {
      entryFillId: stray.exit.id,
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message.startsWith('not_an_entry')).toBe(true);
  });

  it('refuses 409 same_account when the entry fill sits in the same account as the exit', async () => {
    const { posA, accountA, exitA, cookie } = await setupLinkablePair();
    const posA2 = await createDraftPosition(cookie, accountA.id);
    const entrySameAccount = await addFill(
      cookie,
      posA2.id,
      makeFill({ type: 'entry', quantity: '10', filledAt: '2025-01-01T10:00:00Z' }),
    );

    const res = await authedRequest('PUT', linkPath(posA.id, exitA.id), cookie, {
      entryFillId: entrySameAccount.id,
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message.startsWith('same_account')).toBe(true);
  });

  it('refuses 409 different_security when the entry fill is a different symbol', async () => {
    const { posA, exitA, cookie } = await setupLinkablePair();
    const accountC = await createTestAccount(cookie);
    const posC = await createDraftPosition(cookie, accountC.id, { symbol: 'MSFT' });
    const entryDiffSymbol = await addFill(
      cookie,
      posC.id,
      makeFill({ type: 'entry', quantity: '10', filledAt: '2025-01-01T10:00:00Z' }),
    );

    const res = await authedRequest('PUT', linkPath(posA.id, exitA.id), cookie, {
      entryFillId: entryDiffSymbol.id,
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message.startsWith('different_security')).toBe(true);
  });

  it('refuses 409 quantity_mismatch when the entry fill quantity differs', async () => {
    const { posA, exitA, cookie } = await setupLinkablePair();
    const accountC = await createTestAccount(cookie);
    const posC = await createDraftPosition(cookie, accountC.id);
    const entryMismatch = await addFill(
      cookie,
      posC.id,
      makeFill({ type: 'entry', quantity: '7', filledAt: '2025-01-01T10:00:00Z' }),
    );

    const res = await authedRequest('PUT', linkPath(posA.id, exitA.id), cookie, {
      entryFillId: entryMismatch.id,
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message.startsWith('quantity_mismatch')).toBe(true);
  });

  it('refuses 409 exit_already_linked when the exit already has a link', async () => {
    const { posA, exitA, entryB, cookie } = await setupLinkablePair();
    const first = await authedRequest('PUT', linkPath(posA.id, exitA.id), cookie, {
      entryFillId: entryB.id,
    });
    expect(first.status).toBe(200);

    const other = await createOwnEntryAndExit(cookie);

    const res = await authedRequest('PUT', linkPath(posA.id, exitA.id), cookie, {
      entryFillId: other.entry.id,
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message.startsWith('exit_already_linked')).toBe(true);
  });

  it('refuses 409 entry_already_linked when the entry already has a link', async () => {
    const { posA, exitA, entryB, cookie } = await setupLinkablePair();
    const first = await authedRequest('PUT', linkPath(posA.id, exitA.id), cookie, {
      entryFillId: entryB.id,
    });
    expect(first.status).toBe(200);

    const other = await createOwnEntryAndExit(cookie);

    const res = await authedRequest('PUT', linkPath(other.pos.id, other.exit.id), cookie, {
      entryFillId: entryB.id,
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message.startsWith('entry_already_linked')).toBe(true);
  });

  it("refuses 409 not_an_entry for another user's fill id and writes nothing (NFR Security)", async () => {
    const { posA, exitA, cookie } = await setupLinkablePair();
    const strangersFill = await setupLinkablePair();

    const res = await authedRequest('PUT', linkPath(posA.id, exitA.id), cookie, {
      entryFillId: strangersFill.entryB.id,
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message.startsWith('not_an_entry')).toBe(true);

    const rows = await db
      .select()
      .from(fillTransferLinks)
      .where(eq(fillTransferLinks.exitFillId, exitA.id));
    expect(rows).toHaveLength(0);
  });

  it('two concurrent PUTs for the same entry give exactly one 200 and one 409 entry_already_linked', async () => {
    const { posA, exitA, entryB, cookie } = await setupLinkablePair();
    const other = await createOwnEntryAndExit(cookie);

    const [resA, resOther] = await Promise.all([
      authedRequest('PUT', linkPath(posA.id, exitA.id), cookie, { entryFillId: entryB.id }),
      authedRequest('PUT', linkPath(other.pos.id, other.exit.id), cookie, {
        entryFillId: entryB.id,
      }),
    ]);

    const statuses = [resA.status, resOther.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const loser = resA.status === 409 ? resA : resOther;
    const loserBody = await loser.json();
    expect(loserBody.error.message.startsWith('entry_already_linked')).toBe(true);

    const rows = await db
      .select()
      .from(fillTransferLinks)
      .where(eq(fillTransferLinks.entryFillId, entryB.id));
    expect(rows).toHaveLength(1);
  });

  it('GET lists only eligible candidates, excluding mismatched, cross-symbol, same-account and already-linked entries', async () => {
    const { posA, accountA, exitA, entryB, cookie } = await setupLinkablePair();

    const accountC = await createTestAccount(cookie);
    const posC = await createDraftPosition(cookie, accountC.id);
    await addFill(
      cookie,
      posC.id,
      makeFill({ type: 'entry', quantity: '3', filledAt: '2025-01-01T10:00:00Z' }),
    );

    const accountD = await createTestAccount(cookie);
    const posD = await createDraftPosition(cookie, accountD.id, { symbol: 'MSFT' });
    await addFill(
      cookie,
      posD.id,
      makeFill({ type: 'entry', quantity: '10', filledAt: '2025-01-01T10:00:00Z' }),
    );

    const posA2 = await createDraftPosition(cookie, accountA.id);
    await addFill(
      cookie,
      posA2.id,
      makeFill({ type: 'entry', quantity: '10', filledAt: '2025-01-01T10:00:00Z' }),
    );

    const accountE = await createTestAccount(cookie);
    const posE = await createDraftPosition(cookie, accountE.id);
    const entryAlreadyLinked = await addFill(
      cookie,
      posE.id,
      makeFill({ type: 'entry', quantity: '10', filledAt: '2025-01-01T10:00:00Z' }),
    );
    const otherExit = await createOwnEntryAndExit(cookie);
    const realLink = await authedRequest(
      'PUT',
      linkPath(otherExit.pos.id, otherExit.exit.id),
      cookie,
      { entryFillId: entryAlreadyLinked.id },
    );
    expect(realLink.status).toBe(200);

    const res = await authedRequest('GET', linkPath(posA.id, exitA.id), cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    const candidateIds = (body.candidates as Array<{ entryFillId: string }>).map(
      (c) => c.entryFillId,
    );
    expect(candidateIds).toEqual([entryB.id]);
  });

  it('DELETE removes the link (204), then 404s on a repeat DELETE', async () => {
    const { posA, exitA, entryB, cookie } = await setupLinkablePair();
    const putRes = await authedRequest('PUT', linkPath(posA.id, exitA.id), cookie, {
      entryFillId: entryB.id,
    });
    expect(putRes.status).toBe(200);

    const del1 = await authedRequest('DELETE', linkPath(posA.id, exitA.id), cookie);
    expect(del1.status).toBe(204);

    const del2 = await authedRequest('DELETE', linkPath(posA.id, exitA.id), cookie);
    expect(del2.status).toBe(404);
  });

  it('removing the exit fill removes its link (FK cascade)', async () => {
    const { posA, exitA, entryB, cookie } = await setupLinkablePair();
    const putRes = await authedRequest('PUT', linkPath(posA.id, exitA.id), cookie, {
      entryFillId: entryB.id,
    });
    expect(putRes.status).toBe(200);

    const delFill = await authedRequest(
      'DELETE',
      `/api/positions/${posA.id}/fills/${exitA.id}`,
      cookie,
    );
    expect(delFill.status).toBe(204);

    const rows = await db
      .select()
      .from(fillTransferLinks)
      .where(eq(fillTransferLinks.entryFillId, entryB.id));
    expect(rows).toHaveLength(0);
  });

  it("removing the entry's position removes its link (FK cascade)", async () => {
    const { posA, posB, exitA, entryB, cookie } = await setupLinkablePair();
    const putRes = await authedRequest('PUT', linkPath(posA.id, exitA.id), cookie, {
      entryFillId: entryB.id,
    });
    expect(putRes.status).toBe(200);

    const delPos = await authedRequest('DELETE', `/api/positions/${posB.id}`, cookie);
    expect(delPos.status).toBe(204);

    const rows = await db
      .select()
      .from(fillTransferLinks)
      .where(eq(fillTransferLinks.exitFillId, exitA.id));
    expect(rows).toHaveLength(0);
  });

  it('leaves ledger rows and both positions unchanged when a link is written (AC 6.6)', async () => {
    const { posA, posB, exitA, entryB, cookie } = await setupLinkablePair();

    const ledgerBefore = await db
      .select()
      .from(ledgerEntries)
      .where(inArray(ledgerEntries.positionId, [posA.id, posB.id]));
    const [posABefore] = await db.select().from(positions).where(eq(positions.id, posA.id));
    const [posBBefore] = await db.select().from(positions).where(eq(positions.id, posB.id));

    const putRes = await authedRequest('PUT', linkPath(posA.id, exitA.id), cookie, {
      entryFillId: entryB.id,
    });
    expect(putRes.status).toBe(200);

    const ledgerAfter = await db
      .select()
      .from(ledgerEntries)
      .where(inArray(ledgerEntries.positionId, [posA.id, posB.id]));
    const [posAAfter] = await db.select().from(positions).where(eq(positions.id, posA.id));
    const [posBAfter] = await db.select().from(positions).where(eq(positions.id, posB.id));

    expect(ledgerAfter).toEqual(ledgerBefore);
    expect(posAAfter).toEqual(posABefore);
    expect(posBAfter).toEqual(posBBefore);
  });

  it('404s when the position belongs to another user', async () => {
    const { posA, exitA } = await setupLinkablePair();
    const { cookie: cookieB } = await registerAndGetCookie();

    const res = await authedRequest('GET', linkPath(posA.id, exitA.id), cookieB);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  // Regression guard, not a red case: `/api/positions/*` already 401s with no
  // session via the shared `authMiddleware` applied by every sibling router
  // mounted at that base (fillsRouter, lotsRouter, positionImagesRouter) — true
  // before this route exists and must stay true once it is mounted beside them.
  it('401s with no session', async () => {
    const res = await app.request(linkPath(crypto.randomUUID(), crypto.randomUUID()), {
      headers: { 'X-Forwarded-For': uniqueIp() },
    });
    expect(res.status).toBe(401);
  });
});

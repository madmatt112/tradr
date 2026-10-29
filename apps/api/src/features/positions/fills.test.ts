import { eq } from 'drizzle-orm';
import { describe, it, expect } from 'vitest';

import app from '@/app';
import { db } from '@/db';
import { fillLotSelections, ledgerEntries, positions } from '@/db/schema';

let emailCounter = 0;
function uniqueEmail() {
  return `fill-test${++emailCounter}-${Date.now()}@example.com`;
}

let ipCounter = 0;
function uniqueIp() {
  const n = ++ipCounter;
  const b = (n >> 8) & 255;
  const c = n & 255;
  return `10.5.${b}.${c || 1}`;
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
    name: `Fill Test Account ${++acctCounter}-${Date.now()}`,
    currency: 'USD',
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function createDraftPosition(
  cookie: string,
  accountId: string,
  opts?: { assetType?: string },
) {
  const assetType = opts?.assetType ?? 'stock';
  const res = await authedRequest('POST', '/api/positions', cookie, {
    accountId,
    symbol: assetType === 'option' ? 'AAPL260116C150' : 'AAPL',
    side: 'long',
    assetType,
  });
  expect(res.status).toBe(201);
  return res.json();
}

function makeFill(
  overrides?: Partial<{
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

async function openPos(cookie: string, positionId: string, body: Record<string, unknown> = {}) {
  const res = await authedRequest('POST', `/api/positions/${positionId}/open`, cookie, body);
  expect(res.status).toBe(200);
  return res.json();
}

/**
 * Creates a closed position: draft -> add entry -> open -> add exit.
 *
 * The balancing exit auto-closes the position (R7 amendment), so there is no
 * explicit close step — calling the route here would 409 against an
 * already-closed position.
 */
async function createClosedPosition(cookie: string, accountId: string) {
  const pos = await createDraftPosition(cookie, accountId);
  await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
  await openPos(cookie, pos.id);
  await addFill(cookie, pos.id, makeFill({ type: 'exit', quantity: '10', price: '160.00' }));

  const res = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
  expect(res.status).toBe(200);
  expect((await res.json()).status).toBe('closed');
  return pos;
}

describe('fills', () => {
  // 1. Add entry fill to draft — success
  it('adds entry fill to a draft position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);

    const res = await authedRequest('POST', `/api/positions/${pos.id}/fills`, cookie, makeFill());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty('id');
    expect(body.type).toBe('entry');
    expect(Number(body.quantity)).toBe(10);
    expect(body.positionId).toBe(pos.id);
  });

  // 2. Add entry fill to open (scale-in) — success
  it('adds entry fill to an open position (scale-in)', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos.id);

    const res = await authedRequest(
      'POST',
      `/api/positions/${pos.id}/fills`,
      cookie,
      makeFill({ type: 'entry', quantity: '5' }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.type).toBe('entry');
    expect(Number(body.quantity)).toBe(5);
  });

  // 3. Add exit fill to open — success
  it('adds exit fill to an open position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos.id);

    const res = await authedRequest(
      'POST',
      `/api/positions/${pos.id}/fills`,
      cookie,
      makeFill({ type: 'exit', quantity: '5', price: '155.00' }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.type).toBe('exit');
    expect(Number(body.quantity)).toBe(5);
  });

  // 4. Reject exit fill on draft → 409
  it('rejects exit fill on a draft position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));

    const res = await authedRequest(
      'POST',
      `/api/positions/${pos.id}/fills`,
      cookie,
      makeFill({ type: 'exit', quantity: '5' }),
    );
    expect(res.status).toBe(409);
  });

  // 5. Reject exit qty exceeding entry qty → 400
  it('rejects exit fill when quantity exceeds entry quantity', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos.id);

    const res = await authedRequest(
      'POST',
      `/api/positions/${pos.id}/fills`,
      cookie,
      makeFill({ type: 'exit', quantity: '15' }),
    );
    expect(res.status).toBe(400);
  });

  // 6. Reject add fill on closed → 409
  it('rejects adding fill to a closed position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createClosedPosition(cookie, account.id);

    const res = await authedRequest('POST', `/api/positions/${pos.id}/fills`, cookie, makeFill());
    expect(res.status).toBe(409);
  });

  // 7. Update fill price/quantity/fees on open position
  it('updates fill price, quantity, and fees on an open position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const fill = await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos.id);

    const res = await authedRequest('PUT', `/api/positions/${pos.id}/fills/${fill.id}`, cookie, {
      price: '155.00',
      quantity: '12',
      fees: '2.50',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Number(body.price)).toBe(155);
    expect(Number(body.quantity)).toBe(12);
    expect(Number(body.fees)).toBe(2.5);
  });

  // 8. Update non-quantity fields on closed position → should succeed
  it('allows updating price, fees, notes, date on a closed position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const fill = await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos.id);
    await addFill(cookie, pos.id, makeFill({ type: 'exit', quantity: '10', price: '160.00' }));

    const res = await authedRequest('PUT', `/api/positions/${pos.id}/fills/${fill.id}`, cookie, {
      price: '151.00',
      fees: '0.50',
      notes: 'updated note',
      filledAt: '2025-01-16T12:00:00Z',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Number(body.price)).toBe(151);
    expect(Number(body.fees)).toBe(0.5);
    expect(body.notes).toBe('updated note');
  });

  // 9. Reject quantity-changing update on closed position → 409
  it('rejects quantity change on a closed position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const fill = await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos.id);
    await addFill(cookie, pos.id, makeFill({ type: 'exit', quantity: '10', price: '160.00' }));

    const res = await authedRequest('PUT', `/api/positions/${pos.id}/fills/${fill.id}`, cookie, {
      quantity: '15',
    });
    expect(res.status).toBe(409);
  });

  // 10. Type change on update is ignored (UpdateFillSchema excludes type)
  it('ignores type field on fill update (stripped by validation)', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const fill = await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos.id);

    // Send type in the body — it should be stripped by schema validation
    const res = await authedRequest('PUT', `/api/positions/${pos.id}/fills/${fill.id}`, cookie, {
      type: 'exit',
      price: '152.00',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Type should still be entry
    expect(body.type).toBe('entry');
    expect(Number(body.price)).toBe(152);
  });

  // 11. Delete fill on open position — success
  it('deletes a fill on an open position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    const fill2 = await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '5' }));
    await openPos(cookie, pos.id);

    const res = await authedRequest('DELETE', `/api/positions/${pos.id}/fills/${fill2.id}`, cookie);
    expect(res.status).toBe(204);
  });

  // 12. Reject delete entry fill with dependent exits → 409
  it('rejects deleting entry fill when it would make entry qty < exit qty', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const entryFill = await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '5' }));
    await openPos(cookie, pos.id);
    await addFill(cookie, pos.id, makeFill({ type: 'exit', quantity: '12' }));

    // Deleting entry of 10 would leave 5 entry vs 12 exit
    const res = await authedRequest(
      'DELETE',
      `/api/positions/${pos.id}/fills/${entryFill.id}`,
      cookie,
    );
    expect(res.status).toBe(409);
  });

  // 13. Reject delete any fill on closed position → 409
  it('rejects deleting a fill on a closed position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const fill = await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos.id);
    await addFill(cookie, pos.id, makeFill({ type: 'exit', quantity: '10', price: '160.00' }));

    const res = await authedRequest('DELETE', `/api/positions/${pos.id}/fills/${fill.id}`, cookie);
    expect(res.status).toBe(409);
  });

  // 14. Reject delete entry fill that would reduce entry qty to zero on open position → 409
  it('rejects deleting the last entry fill on an open position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const entryFill = await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos.id);

    const res = await authedRequest(
      'DELETE',
      `/api/positions/${pos.id}/fills/${entryFill.id}`,
      cookie,
    );
    expect(res.status).toBe(409);
  });

  // 15. Option integer quantity validation → 400
  it('rejects non-integer quantity for option positions', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id, { assetType: 'option' });

    const res = await authedRequest(
      'POST',
      `/api/positions/${pos.id}/fills`,
      cookie,
      makeFill({ quantity: '1.5' }),
    );
    expect(res.status).toBe(400);
  });

  // 16. Fill not found → 404
  it('returns 404 for non-existent fill', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos.id);

    const fakeFillId = '00000000-0000-0000-0000-000000000000';
    const res = await authedRequest('PUT', `/api/positions/${pos.id}/fills/${fakeFillId}`, cookie, {
      price: '155.00',
    });
    expect(res.status).toBe(404);
  });

  // 17. Fill wrong position returns 404
  it('returns 404 when fill belongs to a different position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos1 = await createDraftPosition(cookie, account.id);
    const pos2 = await createDraftPosition(cookie, account.id);
    const fill1 = await addFill(cookie, pos1.id, makeFill({ type: 'entry', quantity: '10' }));
    await addFill(cookie, pos2.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos1.id);
    await openPos(cookie, pos2.id);

    // Try to update fill1 via pos2's endpoint
    const res = await authedRequest('PUT', `/api/positions/${pos2.id}/fills/${fill1.id}`, cookie, {
      price: '155.00',
    });
    expect(res.status).toBe(404);
  });
});

/**
 * Lot selection on a new exit (tax-lots task 5, design C5 write steps 1-4, 8).
 *
 * Contract per criterion — pre-condition / call / observable result / expected-value source:
 *
 * AC 3.3 (valid selection stored):
 *   two entry lots open on a position -> POST exit with a lotSelection that
 *   splits across both lots, picking different quantities than default FIFO
 *   would -> 201, and `fill_lot_selections` holds exactly those rows.
 *   Source: design C3/C5 ("its rows are stored"), requirements AC 3.3.
 *
 * Error Handling item 1 (selection on an entry fill):
 *   an existing entry fill -> POST a new entry fill carrying a lotSelection ->
 *   400. Source: design Error Handling item 1, design C5 step 1.
 *
 * Error Handling item 1 (repeated entryFillId):
 *   one entry lot open -> POST exit whose lotSelection repeats the same
 *   entryFillId twice (quantities still summing to the exit quantity) -> 400.
 *   Source: design Error Handling item 1, design C5 step 1.
 *
 * Error Handling item 1 (fractional item on an option position):
 *   an options position with two whole-quantity entry lots -> POST exit whose
 *   lotSelection sums correctly but contains a fractional item -> 400.
 *   Source: design Error Handling item 1 ("On options each item must be
 *   whole, as isWholeContracts checks the fill").
 *
 * AC 3.5 / NFR Security (entryFillId from another position, or another user):
 *   an entry fill that belongs to a different position (same user, and
 *   separately a different user) -> POST exit on the caller's own position
 *   selecting that foreign entryFillId -> 409 naming the id, and the
 *   position's fill count is unchanged (nothing written). Source: design C5
 *   step 2, Error Handling item 2, NFR Security ("never resolved").
 *
 * AC 3.3 (sum mismatch):
 *   one entry lot -> POST exit whose lotSelection sums to less than the exit
 *   quantity -> 409 whose message states both quantities. Source: design C5
 *   step 3, Error Handling item 3.
 *
 * AC 3.5 (claims exceed a lot):
 *   one entry lot already fully claimed by a prior selected exit -> POST a
 *   second exit selecting more of that same lot -> 409 naming the lot.
 *   Source: design C4 `over_claimed`, Error Handling item 4.
 *
 * AC 3.5 (write moves an earlier exit's match):
 *   an earlier, unselected FIFO exit has already consumed a lot in full ->
 *   POST a later exit with a selection that reserves part of that same lot ->
 *   409, and the later exit is never written (rolled back). Source: design C5
 *   step 4 (`assertLotSelectionsTx` with `slicesBefore`), Error Handling item
 *   4 ("or the write moves an earlier exit's match"). The engine
 *   (`apps/api/src/features/positions/lots.ts`) computes reservations from
 *   ALL stored selections before processing any exit, so a later selection
 *   can change an earlier, chronologically-first exit's FIFO slice; traced
 *   directly against `matchExitsToLots` (lines 90-176) rather than the task
 *   prompt's "selected exit dated before" paraphrase, which inverts the
 *   actual before/after relationship.
 *
 * AC 8.1 / AC 8.2 (journal, ledger and flat snapshot unaffected):
 *   two positions with byte-identical fills, one exit carrying a selection
 *   that reproduces the same match FIFO would have chosen, the other with no
 *   selection -> the ledger rows posted and the closing `lastFlatAt` /
 *   `lastFlatNetPnl` are identical between the two. Source: design C5 step 9
 *   ("the ledger never reads selections"), requirements AC 8.1, AC 8.2.
 *
 * Folded/out-of-scope criteria (recorded, not retested here):
 *   - AC 1.3 ("lot exists ... with no extra call") — the add-entry-fill branch
 *     this task does not change is already asserted by the existing "adds
 *     entry fill to a draft position" (line ~135) and "adds entry fill to an
 *     open position (scale-in)" (line ~150) cases above; the "no extra call"
 *     clause is a query-count property this file cannot observe without
 *     mocking a collaborator inside the module under test, which is out of
 *     bounds here.
 *   - AC 3.10 (CSV commit / demo seed add exits with no selection) — per the
 *     task brief, a regression guard whose coverage already lives in
 *     `apps/api/src/features/csv-import/csv-import.commit.test.ts` and
 *     `apps/api/src/features/accounts/accounts.demo.test.ts`; task 5 does not
 *     touch csv-import or the demo seed.
 *   - AC 3.13 (`@swagger` blocks and `tradr-api.json` regeneration) — not
 *     reachable through this file's `authedRequest` seam; enforced by CI's
 *     generated-pages `git diff --exit-code` gate, not a vitest assertion.
 */
describe('lot selection on create', () => {
  it('accepts a valid lot selection on an exit, overriding default FIFO order, and stores its rows', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const entry1 = await addFill(
      cookie,
      pos.id,
      makeFill({ type: 'entry', quantity: '3', filledAt: '2025-01-01T10:00:00Z' }),
    );
    await openPos(cookie, pos.id);
    const entry2 = await addFill(
      cookie,
      pos.id,
      makeFill({ type: 'entry', quantity: '7', filledAt: '2025-01-02T10:00:00Z' }),
    );

    // Default FIFO would take all 5 units from entry1 first (insufficient,
    // 3) then the remainder (2) from entry2 — a 3/2 split. This selection
    // deliberately picks a different 2/3 split to prove it is honoured.
    const res = await authedRequest('POST', `/api/positions/${pos.id}/fills`, cookie, {
      type: 'exit',
      price: '160.00',
      quantity: '5',
      fees: '1.00',
      filledAt: '2025-01-10T10:00:00Z',
      lotSelection: [
        { entryFillId: entry1.id, quantity: '2' },
        { entryFillId: entry2.id, quantity: '3' },
      ],
    });
    expect(res.status).toBe(201);
    const body = await res.json();

    const rows = await db
      .select()
      .from(fillLotSelections)
      .where(eq(fillLotSelections.exitFillId, body.id));
    expect(rows).toHaveLength(2);
    const byEntry = new Map(rows.map((r) => [r.entryFillId, Number(r.quantity)]));
    expect(byEntry.get(entry1.id)).toBe(2);
    expect(byEntry.get(entry2.id)).toBe(3);
  });

  it('rejects a lot selection on an entry fill', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const entry0 = await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '5' }));

    const res = await authedRequest('POST', `/api/positions/${pos.id}/fills`, cookie, {
      type: 'entry',
      price: '150.00',
      quantity: '3',
      fees: '0',
      filledAt: '2025-01-03T10:00:00Z',
      lotSelection: [{ entryFillId: entry0.id, quantity: '3' }],
    });
    expect(res.status).toBe(400);
  });

  it('rejects a lot selection that repeats the same entry fill id', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const entry1 = await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos.id);

    const res = await authedRequest('POST', `/api/positions/${pos.id}/fills`, cookie, {
      type: 'exit',
      price: '160.00',
      quantity: '5',
      fees: '0',
      filledAt: '2025-01-10T10:00:00Z',
      lotSelection: [
        { entryFillId: entry1.id, quantity: '2' },
        { entryFillId: entry1.id, quantity: '3' },
      ],
    });
    expect(res.status).toBe(400);
  });

  it('rejects a fractional lot-selection item on an options position', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id, { assetType: 'option' });
    const entry1 = await addFill(
      cookie,
      pos.id,
      makeFill({ type: 'entry', quantity: '3', filledAt: '2025-01-01T10:00:00Z' }),
    );
    await openPos(cookie, pos.id);
    const entry2 = await addFill(
      cookie,
      pos.id,
      makeFill({ type: 'entry', quantity: '3', filledAt: '2025-01-02T10:00:00Z' }),
    );

    const res = await authedRequest('POST', `/api/positions/${pos.id}/fills`, cookie, {
      type: 'exit',
      price: '160.00',
      quantity: '2',
      fees: '0',
      filledAt: '2025-01-10T10:00:00Z',
      lotSelection: [
        { entryFillId: entry1.id, quantity: '1.5' },
        { entryFillId: entry2.id, quantity: '0.5' },
      ],
    });
    expect(res.status).toBe(400);
  });

  it('rejects a lot selection naming an entry fill from a different position, and writes nothing', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const posX = await createDraftPosition(cookie, account.id);
    const posY = await createDraftPosition(cookie, account.id);
    await addFill(cookie, posX.id, makeFill({ type: 'entry', quantity: '5' }));
    const otherEntry = await addFill(cookie, posY.id, makeFill({ type: 'entry', quantity: '5' }));
    await openPos(cookie, posX.id);
    await openPos(cookie, posY.id);

    const res = await authedRequest('POST', `/api/positions/${posX.id}/fills`, cookie, {
      type: 'exit',
      price: '160.00',
      quantity: '3',
      fees: '0',
      filledAt: '2025-01-10T10:00:00Z',
      lotSelection: [{ entryFillId: otherEntry.id, quantity: '3' }],
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toContain(otherEntry.id);

    const detail = await authedRequest('GET', `/api/positions/${posX.id}`, cookie);
    const detailBody = await detail.json();
    expect(detailBody.fills).toHaveLength(1);
  });

  it('rejects a lot selection naming an entry fill from another user, and writes nothing', async () => {
    const { cookie: cookieA } = await registerAndGetCookie();
    const accountA = await createTestAccount(cookieA);
    const posA = await createDraftPosition(cookieA, accountA.id);
    await addFill(cookieA, posA.id, makeFill({ type: 'entry', quantity: '5' }));
    await openPos(cookieA, posA.id);

    const { cookie: cookieB } = await registerAndGetCookie();
    const accountB = await createTestAccount(cookieB);
    const posB = await createDraftPosition(cookieB, accountB.id);
    const entryB = await addFill(cookieB, posB.id, makeFill({ type: 'entry', quantity: '5' }));
    await openPos(cookieB, posB.id);

    const res = await authedRequest('POST', `/api/positions/${posA.id}/fills`, cookieA, {
      type: 'exit',
      price: '160.00',
      quantity: '3',
      fees: '0',
      filledAt: '2025-01-10T10:00:00Z',
      lotSelection: [{ entryFillId: entryB.id, quantity: '3' }],
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toContain(entryB.id);

    const detail = await authedRequest('GET', `/api/positions/${posA.id}`, cookieA);
    const detailBody = await detail.json();
    expect(detailBody.fills).toHaveLength(1);
  });

  it('rejects a lot selection whose quantities do not sum to the exit quantity, naming both', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const entry1 = await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos.id);

    const res = await authedRequest('POST', `/api/positions/${pos.id}/fills`, cookie, {
      type: 'exit',
      price: '160.00',
      quantity: '10',
      fees: '0',
      filledAt: '2025-01-10T10:00:00Z',
      lotSelection: [{ entryFillId: entry1.id, quantity: '4' }],
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toContain('10');
    expect(body.error.message).toContain('4');
  });

  it('rejects a lot selection whose claims exceed the lot quantity, naming the lot', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const entry1 = await addFill(
      cookie,
      pos.id,
      makeFill({ type: 'entry', quantity: '5', filledAt: '2025-01-01T10:00:00Z' }),
    );
    await openPos(cookie, pos.id);
    await addFill(
      cookie,
      pos.id,
      makeFill({ type: 'entry', quantity: '10', filledAt: '2025-01-02T10:00:00Z' }),
    );

    const exitARes = await authedRequest('POST', `/api/positions/${pos.id}/fills`, cookie, {
      type: 'exit',
      price: '160.00',
      quantity: '5',
      fees: '0',
      filledAt: '2025-01-10T10:00:00Z',
      lotSelection: [{ entryFillId: entry1.id, quantity: '5' }],
    });
    expect(exitARes.status).toBe(201);

    const res = await authedRequest('POST', `/api/positions/${pos.id}/fills`, cookie, {
      type: 'exit',
      price: '161.00',
      quantity: '3',
      fees: '0',
      filledAt: '2025-01-11T10:00:00Z',
      lotSelection: [{ entryFillId: entry1.id, quantity: '3' }],
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toContain(entry1.id);
  });

  it("rejects a selection write that would change an earlier exit's FIFO match, and rolls back", async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const entry1 = await addFill(
      cookie,
      pos.id,
      makeFill({ type: 'entry', quantity: '5', filledAt: '2025-01-01T10:00:00Z' }),
    );
    await openPos(cookie, pos.id);
    await addFill(
      cookie,
      pos.id,
      makeFill({ type: 'entry', quantity: '5', filledAt: '2025-01-02T10:00:00Z' }),
    );

    // Unselected FIFO exit: consumes entry1 (the oldest lot) in full.
    const exitA = await addFill(
      cookie,
      pos.id,
      makeFill({
        type: 'exit',
        quantity: '5',
        price: '160.00',
        filledAt: '2025-01-05T10:00:00Z',
      }),
    );

    // A later, selected exit that reserves part of entry1. The engine
    // computes reservations from ALL stored selections before processing any
    // exit (apps/api/src/features/positions/lots.ts:90-176), so exitA — which
    // is ordered before this write by filledAt — now has less of entry1
    // available and spills into entry2: its match changes from {entry1: 5}
    // to {entry1: 2, entry2: 3}.
    const res = await authedRequest('POST', `/api/positions/${pos.id}/fills`, cookie, {
      type: 'exit',
      price: '161.00',
      quantity: '3',
      fees: '0',
      filledAt: '2025-01-10T10:00:00Z',
      lotSelection: [{ entryFillId: entry1.id, quantity: '3' }],
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toContain(exitA.id);

    const detail = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    const detailBody = await detail.json();
    // entry1 + entry2 + exitA only — the new exit must never have been written.
    expect(detailBody.fills).toHaveLength(3);
  });

  it('posts the same ledger rows and flat snapshot for a selected exit as for the same exit with none', async () => {
    const { cookie } = await registerAndGetCookie();

    const accountNoSel = await createTestAccount(cookie);
    const posNoSel = await createDraftPosition(cookie, accountNoSel.id);
    await addFill(
      cookie,
      posNoSel.id,
      makeFill({
        type: 'entry',
        quantity: '10',
        price: '100.00',
        fees: '1.00',
        filledAt: '2025-01-01T10:00:00Z',
      }),
    );
    // Explicit, identical openedAt for both positions: the exit's filledAt
    // (2025-01-10) is otherwise earlier than the real "now" `/open` would
    // otherwise stamp, which clamps closedAt to openedAt (see addFillTx) and
    // would make lastFlatAt depend on wall-clock jitter between these two
    // sequential requests rather than on the byte-identical fills.
    await openPos(cookie, posNoSel.id, { openedAt: '2024-12-01T00:00:00Z' });
    await addFill(
      cookie,
      posNoSel.id,
      makeFill({
        type: 'exit',
        quantity: '10',
        price: '110.00',
        fees: '2.00',
        filledAt: '2025-01-10T10:00:00Z',
      }),
    );

    const accountSel = await createTestAccount(cookie);
    const posSel = await createDraftPosition(cookie, accountSel.id);
    const entrySel = await addFill(
      cookie,
      posSel.id,
      makeFill({
        type: 'entry',
        quantity: '10',
        price: '100.00',
        fees: '1.00',
        filledAt: '2025-01-01T10:00:00Z',
      }),
    );
    await openPos(cookie, posSel.id, { openedAt: '2024-12-01T00:00:00Z' });
    const exitSelRes = await authedRequest('POST', `/api/positions/${posSel.id}/fills`, cookie, {
      type: 'exit',
      price: '110.00',
      quantity: '10',
      fees: '2.00',
      filledAt: '2025-01-10T10:00:00Z',
      lotSelection: [{ entryFillId: entrySel.id, quantity: '10' }],
    });
    expect(exitSelRes.status).toBe(201);
    const exitSelBody = await exitSelRes.json();

    // Confirms the selection was actually accepted and stored — otherwise
    // the comparison below would hold vacuously (an ignored field cannot
    // change anything).
    const selRows = await db
      .select()
      .from(fillLotSelections)
      .where(eq(fillLotSelections.exitFillId, exitSelBody.id));
    expect(selRows).toHaveLength(1);

    const [rowNoSel] = await db.select().from(positions).where(eq(positions.id, posNoSel.id));
    const [rowSel] = await db.select().from(positions).where(eq(positions.id, posSel.id));
    expect(rowSel!.lastFlatNetPnl).toBe(rowNoSel!.lastFlatNetPnl);
    expect(rowSel!.lastFlatAt?.toISOString()).toBe(rowNoSel!.lastFlatAt?.toISOString());

    const ledgerNoSel = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.positionId, posNoSel.id));
    const ledgerSel = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.positionId, posSel.id));
    const simplify = (rows: typeof ledgerNoSel) =>
      rows
        .map((r) => ({
          entryType: r.entryType,
          direction: r.direction,
          amount: Number(r.amount),
          currency: r.currency,
        }))
        .sort(
          (a, b) =>
            a.entryType.localeCompare(b.entryType) || a.direction.localeCompare(b.direction),
        );
    expect(simplify(ledgerSel)).toEqual(simplify(ledgerNoSel));
  });
});

/**
 * Edit, clear and guard lot selections on fill edits and removals (tax-lots
 * task 6, design C5 write steps 5-7).
 *
 * Contract per criterion — pre-condition / call / observable result / expected-value source:
 *
 * AC 3.7 (new selection on a quantity edit, success path):
 *   an exit with a stored selection -> PUT the exit with a new quantity and a
 *   new lotSelection that sums to it -> 200, and `fill_lot_selections` holds
 *   exactly the new rows, the old ones gone. Source: design C5 step 5 ("a
 *   selection is checked against the post-edit quantity and replaces the
 *   stored rows"), requirements AC 3.7.
 *
 * AC 3.7 / Error Handling item 3 (quantity edit, no new selection):
 *   an exit with a stored selection -> PUT a new quantity with no
 *   `lotSelection` field -> 409 whose message states both the stored
 *   selection's sum and the new quantity. Source: design C5 step 5 ("a
 *   quantity change on an exit with rows is a ConflictError"), design D12 /
 *   Error Handling item 8 (the same fixed-message 409, not varied by method),
 *   this document's D9 ("the 409 ... always names both ways out").
 *
 * AC 3.8 (null clears the selection):
 *   an exit with a stored selection -> PUT `lotSelection: null` (no quantity
 *   change) -> 200 and zero stored rows for that exit; a further PUT changing
 *   only its quantity, now that no rows remain, succeeds instead of hitting
 *   the AC 3.7 guard above — proving the exit is no longer selection-tracked
 *   and has reverted to FIFO. Source: design C5 step 5 ("null deletes them"),
 *   requirements AC 3.8.
 *
 * AC 3.5 (edit moves an earlier exit's match):
 *   an earlier, unselected FIFO exit has already consumed a lot in full; a
 *   later exit holds a selection on a different lot -> PUT the later exit's
 *   selection to reserve part of the first lot instead -> 409 naming the
 *   earlier exit, and the later exit's stored selection rows are unchanged
 *   (rolled back). Source: design C5 step 4 (`assertLotSelectionsTx` with
 *   `slicesBefore`), Error Handling item 4, mirroring task 5's analogous
 *   create-path case but through an edit.
 *
 * AC 3.6 (entry quantity edit under a claim):
 *   an entry fill is claimed in full by a selected exit -> PUT the entry's
 *   quantity down below the claimed amount -> 409 naming the claiming exit,
 *   and the entry's stored quantity is unchanged. Source: design C5 step 6
 *   ("editFill on an entry with a quantity change calls assertLotSelectionsTx
 *   after the update"), Error Handling item 5, requirements AC 3.6.
 *
 * AC 3.6 (entry removal under a claim):
 *   an entry fill is claimed (in part) by a selected exit -> DELETE the entry
 *   -> 409 naming the claiming exit, and nothing is deleted (fill count and
 *   the selection row are unchanged). Source: design C5 step 7 ("removeFill
 *   on an entry that any selection row names is a ConflictError naming the
 *   claiming exit, checked before the delete"), Error Handling item 5,
 *   requirements AC 3.6.
 *
 * Folded/out-of-scope criteria (recorded, not retested here):
 *   - AC 1.4 ("the lot SHALL follow the edited fill or disappear, subject to
 *     Requirement 3.6") — its unclaimed-entry-edit branch is already asserted
 *     by the existing "updates fill price, quantity, and fees on an open
 *     position" case above (unchanged by this task); its claimed branch IS
 *     Requirement 3.6, covered by the two AC 3.6 cases in this block.
 *   - Error Handling item 8 / design D12 (average-cost user, quantity-change
 *     409) — the task's own D9 fixes the 409's message regardless of method,
 *     with no settings read in the edit path, so the AC 3.7 failure case
 *     above already exercises the one check both methods share; there is no
 *     separate average-cost-only behaviour to assert.
 *   - AC 3.9 (exit removal, and position deletion, clear every selection row)
 *     — the task brief itself calls this "a regression guard" that "holds
 *     through the task 2 foreign keys," and both branches already have a
 *     green, existing assertion: `fill_lot_selections_exit_fill_id_fills_id_fk
 *     is ON DELETE CASCADE` and
 *     `fill_lot_selections_entry_fill_id_fills_id_fk is ON DELETE CASCADE`
 *     (apps/api/src/db/expenses.migration.test.ts:151-162 and :164-175). A
 *     `pg_constraint` check is a stronger guarantee than an API round trip —
 *     Postgres enforces it mechanically — so no new test is added here.
 *   - AC 3.13 (`@swagger` blocks and `tradr-api.json` regeneration) — not
 *     reachable through this file's `authedRequest` seam, as task 5's fold
 *     already recorded; enforced by CI's generated-pages `git diff
 *     --exit-code` gate, not a vitest assertion.
 */
async function addSelectedExit(
  cookie: string,
  positionId: string,
  body: {
    price: string;
    quantity: string;
    fees: string;
    filledAt: string;
    lotSelection: { entryFillId: string; quantity: string }[];
  },
) {
  const res = await authedRequest('POST', `/api/positions/${positionId}/fills`, cookie, {
    type: 'exit',
    ...body,
  });
  expect(res.status).toBe(201);
  return res.json();
}

describe('edit, clear and guard lot selections on fill edits and removals', () => {
  it('replaces the stored rows when an exit edit carries a new selection summing to the new quantity', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const entry1 = await addFill(
      cookie,
      pos.id,
      makeFill({ type: 'entry', quantity: '5', filledAt: '2025-01-01T10:00:00Z' }),
    );
    await openPos(cookie, pos.id);
    const entry2 = await addFill(
      cookie,
      pos.id,
      makeFill({ type: 'entry', quantity: '10', filledAt: '2025-01-02T10:00:00Z' }),
    );
    const exit = await addSelectedExit(cookie, pos.id, {
      price: '160.00',
      quantity: '5',
      fees: '0',
      filledAt: '2025-01-10T10:00:00Z',
      lotSelection: [{ entryFillId: entry1.id, quantity: '5' }],
    });

    const res = await authedRequest('PUT', `/api/positions/${pos.id}/fills/${exit.id}`, cookie, {
      quantity: '8',
      lotSelection: [
        { entryFillId: entry1.id, quantity: '3' },
        { entryFillId: entry2.id, quantity: '5' },
      ],
    });
    expect(res.status).toBe(200);

    const rows = await db
      .select()
      .from(fillLotSelections)
      .where(eq(fillLotSelections.exitFillId, exit.id));
    expect(rows).toHaveLength(2);
    const byEntry = new Map(rows.map((r) => [r.entryFillId, Number(r.quantity)]));
    expect(byEntry.get(entry1.id)).toBe(3);
    expect(byEntry.get(entry2.id)).toBe(5);
  });

  it('rejects a quantity edit on a selected exit that carries no new selection, naming both quantities', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const entry1 = await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '20' }));
    await openPos(cookie, pos.id);
    const exit = await addSelectedExit(cookie, pos.id, {
      price: '160.00',
      quantity: '7',
      fees: '0',
      filledAt: '2025-01-10T10:00:00Z',
      lotSelection: [{ entryFillId: entry1.id, quantity: '7' }],
    });

    const res = await authedRequest('PUT', `/api/positions/${pos.id}/fills/${exit.id}`, cookie, {
      quantity: '9',
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toContain('7');
    expect(body.error.message).toContain('9');
  });

  it('clears the stored selection on a null edit and lets the exit revert to FIFO', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const entry1 = await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos.id);
    const exit = await addSelectedExit(cookie, pos.id, {
      price: '160.00',
      quantity: '4',
      fees: '0',
      filledAt: '2025-01-10T10:00:00Z',
      lotSelection: [{ entryFillId: entry1.id, quantity: '4' }],
    });

    const clearRes = await authedRequest(
      'PUT',
      `/api/positions/${pos.id}/fills/${exit.id}`,
      cookie,
      { lotSelection: null },
    );
    expect(clearRes.status).toBe(200);

    const rows = await db
      .select()
      .from(fillLotSelections)
      .where(eq(fillLotSelections.exitFillId, exit.id));
    expect(rows).toHaveLength(0);

    // Now unselected: a further quantity-only edit must succeed — were the
    // rows still present, this would hit the AC 3.7 guard above and 409.
    const quantityRes = await authedRequest(
      'PUT',
      `/api/positions/${pos.id}/fills/${exit.id}`,
      cookie,
      { quantity: '6' },
    );
    expect(quantityRes.status).toBe(200);
  });

  it("rejects an edit that would change an earlier exit's FIFO match, and rolls back", async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const entry1 = await addFill(
      cookie,
      pos.id,
      makeFill({ type: 'entry', quantity: '5', filledAt: '2025-01-01T10:00:00Z' }),
    );
    await openPos(cookie, pos.id);
    const entry2 = await addFill(
      cookie,
      pos.id,
      makeFill({ type: 'entry', quantity: '5', filledAt: '2025-01-02T10:00:00Z' }),
    );

    // Unselected FIFO exit: consumes entry1 (the oldest lot) in full.
    const exitA = await addFill(
      cookie,
      pos.id,
      makeFill({
        type: 'exit',
        quantity: '5',
        price: '160.00',
        filledAt: '2025-01-05T10:00:00Z',
      }),
    );

    // A later exit, selected on entry2 — no conflict with exitA as created.
    const exitB = await addSelectedExit(cookie, pos.id, {
      price: '161.00',
      quantity: '3',
      fees: '0',
      filledAt: '2025-01-10T10:00:00Z',
      lotSelection: [{ entryFillId: entry2.id, quantity: '3' }],
    });

    // Edit exitB to instead reserve part of entry1 — the lot exitA already
    // consumed in full by FIFO. Same reservation-recompute behaviour task 5
    // proved on create (apps/api/src/features/positions/lots.ts:90-176):
    // exitA's match shifts from {entry1: 5} to {entry1: 2, entry2: 3}.
    const res = await authedRequest('PUT', `/api/positions/${pos.id}/fills/${exitB.id}`, cookie, {
      lotSelection: [{ entryFillId: entry1.id, quantity: '3' }],
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toContain(exitA.id);

    const rows = await db
      .select()
      .from(fillLotSelections)
      .where(eq(fillLotSelections.exitFillId, exitB.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entryFillId).toBe(entry2.id);
    expect(Number(rows[0]!.quantity)).toBe(3);
  });

  it('rejects an entry quantity edit that would leave a claim above the lot, naming the claiming exit', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const entry1 = await addFill(
      cookie,
      pos.id,
      makeFill({ type: 'entry', quantity: '10', filledAt: '2025-01-01T10:00:00Z' }),
    );
    await openPos(cookie, pos.id);
    await addFill(
      cookie,
      pos.id,
      makeFill({ type: 'entry', quantity: '20', filledAt: '2025-01-02T10:00:00Z' }),
    );
    const exit = await addSelectedExit(cookie, pos.id, {
      price: '160.00',
      quantity: '10',
      fees: '0',
      filledAt: '2025-01-10T10:00:00Z',
      lotSelection: [{ entryFillId: entry1.id, quantity: '10' }],
    });

    const res = await authedRequest('PUT', `/api/positions/${pos.id}/fills/${entry1.id}`, cookie, {
      quantity: '5',
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toContain(exit.id);

    const detail = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    const detailBody = await detail.json();
    const unchangedEntry1 = detailBody.fills.find((f: { id: string }) => f.id === entry1.id);
    expect(unchangedEntry1.quantity).toBe(entry1.quantity);
  });

  it('rejects removing an entry fill claimed by a selected exit, naming the exit, and deletes nothing', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const entry1 = await addFill(
      cookie,
      pos.id,
      makeFill({ type: 'entry', quantity: '10', filledAt: '2025-01-01T10:00:00Z' }),
    );
    await openPos(cookie, pos.id);
    await addFill(
      cookie,
      pos.id,
      makeFill({ type: 'entry', quantity: '20', filledAt: '2025-01-02T10:00:00Z' }),
    );
    const exit = await addSelectedExit(cookie, pos.id, {
      price: '160.00',
      quantity: '5',
      fees: '0',
      filledAt: '2025-01-10T10:00:00Z',
      lotSelection: [{ entryFillId: entry1.id, quantity: '5' }],
    });

    const res = await authedRequest(
      'DELETE',
      `/api/positions/${pos.id}/fills/${entry1.id}`,
      cookie,
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toContain(exit.id);

    const detail = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    const detailBody = await detail.json();
    expect(detailBody.fills).toHaveLength(3);

    const rows = await db
      .select()
      .from(fillLotSelections)
      .where(eq(fillLotSelections.exitFillId, exit.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entryFillId).toBe(entry1.id);
  });
});

/**
 * Return the stored selection on fill reads (tax-lots task 7, design C6, this
 * document's D12).
 *
 * Contract per criterion — pre-condition / call / observable result / expected-value source:
 *
 * AC 3.14 (detail read carries the selection, and null elsewhere):
 *   a position with an unselected entry, a selected exit, and a second,
 *   unselected exit -> GET `/api/positions/:id` -> the selected exit's fill
 *   carries `lotSelection` with the stored entryFillId/quantity items, and
 *   both the entry's and the plain exit's fills carry `lotSelection: null`.
 *   Source: design C6 ("sets lotSelection on every fill — the array for a
 *   selected exit, otherwise null"), requirements AC 3.14.
 *
 * AC 3.14 (POST response carries it):
 *   two entry lots open on a position -> POST an exit carrying a
 *   lotSelection -> the 201 response body itself (not a re-fetch) carries
 *   `lotSelection` with the stored items. Source: design C6 ("Create and edit
 *   responses carry the stored value too").
 *
 * AC 3.14 (PUT response carries the change):
 *   an exit with a stored selection -> PUT a new quantity and a new
 *   lotSelection that sums to it -> the 200 response body itself carries the
 *   new `lotSelection`, not the one stored before the edit. Source: design C6
 *   ("Create and edit responses carry the stored value too").
 *
 * AC 3.14 (detail read reflects a clear):
 *   an exit with a stored selection -> PUT `lotSelection: null` -> a
 *   subsequent GET `/api/positions/:id` shows that fill's `lotSelection` as
 *   `null`. Source: design C6, requirements AC 3.8 (the clear) read through
 *   AC 3.14 (the read contract).
 *
 * Folded/out-of-scope criteria (recorded, not retested here):
 *   - AC 3.13 (`@swagger` blocks and `tradr-api.json` regeneration) — not
 *     reachable through this file's `authedRequest` seam, as tasks 5 and 6's
 *     folds already recorded; enforced by CI's generated-pages `git diff
 *     --exit-code` gate, not a vitest assertion.
 */
describe('return the stored selection on fill reads', () => {
  it('carries the selection on the selected exit and null on every other fill, from the detail read', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const entry1 = await addFill(
      cookie,
      pos.id,
      makeFill({ type: 'entry', quantity: '10', filledAt: '2025-01-01T10:00:00Z' }),
    );
    await openPos(cookie, pos.id);
    const selectedExit = await addSelectedExit(cookie, pos.id, {
      price: '160.00',
      quantity: '4',
      fees: '0',
      filledAt: '2025-01-10T10:00:00Z',
      lotSelection: [{ entryFillId: entry1.id, quantity: '4' }],
    });
    const plainExit = await addFill(
      cookie,
      pos.id,
      makeFill({
        type: 'exit',
        quantity: '6',
        price: '161.00',
        filledAt: '2025-01-11T10:00:00Z',
      }),
    );

    const res = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();

    type FillWithSelection = {
      id: string;
      lotSelection: { entryFillId: string; quantity: string }[] | null;
    };
    const byId = new Map<string, FillWithSelection>(
      body.fills.map((f: FillWithSelection) => [f.id, f]),
    );
    expect(byId.get(entry1.id)!.lotSelection).toBeNull();
    expect(byId.get(plainExit.id)!.lotSelection).toBeNull();
    const selected = byId.get(selectedExit.id)!.lotSelection!;
    expect(selected).toHaveLength(1);
    expect(selected[0]!.entryFillId).toBe(entry1.id);
    expect(Number(selected[0]!.quantity)).toBe(4);
  });

  it('carries the stored selection on the POST response of a selected exit', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const entry1 = await addFill(
      cookie,
      pos.id,
      makeFill({ type: 'entry', quantity: '3', filledAt: '2025-01-01T10:00:00Z' }),
    );
    await openPos(cookie, pos.id);
    const entry2 = await addFill(
      cookie,
      pos.id,
      makeFill({ type: 'entry', quantity: '7', filledAt: '2025-01-02T10:00:00Z' }),
    );

    const res = await authedRequest('POST', `/api/positions/${pos.id}/fills`, cookie, {
      type: 'exit',
      price: '160.00',
      quantity: '5',
      fees: '0',
      filledAt: '2025-01-10T10:00:00Z',
      lotSelection: [
        { entryFillId: entry1.id, quantity: '2' },
        { entryFillId: entry2.id, quantity: '3' },
      ],
    });
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.lotSelection).toHaveLength(2);
    const byEntry = new Map(
      body.lotSelection.map((item: { entryFillId: string; quantity: string }) => [
        item.entryFillId,
        Number(item.quantity),
      ]),
    );
    expect(byEntry.get(entry1.id)).toBe(2);
    expect(byEntry.get(entry2.id)).toBe(3);
  });

  it('carries the new selection on the PUT response after a change', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const entry1 = await addFill(
      cookie,
      pos.id,
      makeFill({ type: 'entry', quantity: '5', filledAt: '2025-01-01T10:00:00Z' }),
    );
    await openPos(cookie, pos.id);
    const entry2 = await addFill(
      cookie,
      pos.id,
      makeFill({ type: 'entry', quantity: '10', filledAt: '2025-01-02T10:00:00Z' }),
    );
    const exit = await addSelectedExit(cookie, pos.id, {
      price: '160.00',
      quantity: '5',
      fees: '0',
      filledAt: '2025-01-10T10:00:00Z',
      lotSelection: [{ entryFillId: entry1.id, quantity: '5' }],
    });

    const res = await authedRequest('PUT', `/api/positions/${pos.id}/fills/${exit.id}`, cookie, {
      quantity: '8',
      lotSelection: [
        { entryFillId: entry1.id, quantity: '3' },
        { entryFillId: entry2.id, quantity: '5' },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.lotSelection).toHaveLength(2);
    const byEntry = new Map(
      body.lotSelection.map((item: { entryFillId: string; quantity: string }) => [
        item.entryFillId,
        Number(item.quantity),
      ]),
    );
    expect(byEntry.get(entry1.id)).toBe(3);
    expect(byEntry.get(entry2.id)).toBe(5);
  });

  it('returns null from the detail read after a selection is cleared', async () => {
    const { cookie } = await registerAndGetCookie();
    const account = await createTestAccount(cookie);
    const pos = await createDraftPosition(cookie, account.id);
    const entry1 = await addFill(cookie, pos.id, makeFill({ type: 'entry', quantity: '10' }));
    await openPos(cookie, pos.id);
    const exit = await addSelectedExit(cookie, pos.id, {
      price: '160.00',
      quantity: '4',
      fees: '0',
      filledAt: '2025-01-10T10:00:00Z',
      lotSelection: [{ entryFillId: entry1.id, quantity: '4' }],
    });

    const clearRes = await authedRequest(
      'PUT',
      `/api/positions/${pos.id}/fills/${exit.id}`,
      cookie,
      { lotSelection: null },
    );
    expect(clearRes.status).toBe(200);

    const detail = await authedRequest('GET', `/api/positions/${pos.id}`, cookie);
    const detailBody = await detail.json();
    const clearedExit = detailBody.fills.find((f: { id: string }) => f.id === exit.id);
    expect(clearedExit.lotSelection).toBeNull();
  });
});

/**
 * Entry Greeks capture (design C7; task 11 of option-lifecycle-events).
 * Black-box over `captureEntryGreeks` directly — the house style from
 * `option-roll.test.ts`/`option-settlement.test.ts`: seed via raw inserts and
 * the existing `*Tx` seams, drive the function under test, assert on
 * committed state. The chain path's Unusual Whales client and key lookup are
 * mocked at the module boundary (the `advisor.options-chain.route.test.ts`
 * pattern), so these chain-path cases are deterministic without a live key.
 *
 * Contract block — one entry per success criterion this task covers.
 * Pre-condition → call through the seam → observable result → source of the
 * expected value.
 *
 * A. A Black-Scholes capture stores delta, gamma, theta per day, vega, rho
 *    per percent, the inputs and source black_scholes, equal to the
 *    blackScholes output for that T (AC 6.1)
 *   Pre: an open call leg, one entry fill, a future expiry.
 *   Call: `captureEntryGreeks(db, userId, legId, { source: 'black_scholes',
 *     volatility, spot, rate })`.
 *   Result: the stored row's delta/gamma/thetaPerDay/vegaPerPct/rhoPerPct
 *     equal `blackScholes({ S: spot, K: strike, T, sigma: volatility, r: rate,
 *     q: 0, type })`'s own fields; `source` is `black_scholes`; `volatility`,
 *     `spot`, `rate` equal the given inputs.
 *   Source: design C7 Interfaces/Black-Scholes; requirements AC 6.1. `T` per
 *     design C7: expiry instant (`expiryInstant`, `packages/shared/src/
 *     options.ts:360`) less the first entry fill's `filledAt`, over 365 days.
 *
 * B. A chain capture (client mocked) stores the four Greeks, rho null and
 *    source chain (AC 6.2)
 *   Pre: an open call leg; a mocked Unusual Whales key, expiry breakdown and
 *     option-contracts row for the same contract, carrying delta/gamma/theta/
 *     vega.
 *   Call: `captureEntryGreeks(db, userId, legId, { source: 'chain' })`.
 *   Result: the stored row's delta/gamma/thetaPerDay/vegaPerPct equal the
 *     mocked contract's values; `rhoPerPct` is null; `source` is `chain`.
 *   Source: design C7 Chain / Known limits; requirements AC 6.2.
 *
 * C. No Unusual Whales key is a 409, no write (design C7 Chain)
 *   Pre: an open call leg; the key lookup mocked to resolve no key.
 *   Call: `captureEntryGreeks(db, userId, legId, { source: 'chain' })`.
 *   Result: rejects with `statusCode: 409`; no `position_entry_greeks` row
 *     for the leg.
 *   Source: design C7 Chain ("No key is 409"); _Prompt Success.
 *
 * D. A contract missing a required Greek is a 409, no write (design C7 Chain)
 *   Pre: an open call leg; the mocked contract row omits `vega`.
 *   Call: `captureEntryGreeks(db, userId, legId, { source: 'chain' })`.
 *   Result: rejects with `statusCode: 409`; no row written.
 *   Source: design C7 Chain ("A contract missing delta, gamma, theta or vega
 *     is 409"); _Prompt Success.
 *
 * E. An expired/unlisted contract reads 404 through toHttpError (design C7
 *    Known limits)
 *   Pre: an open call leg; the mocked expiry breakdown carries no expiries at
 *     all, so the requested expiry cannot resolve.
 *   Call: `captureEntryGreeks(db, userId, legId, { source: 'chain' })`.
 *   Result: rejects with `statusCode: 404`; no row written.
 *   Source: design C7 Known limits ("an expired contract answers 404");
 *     `apps/api/src/features/advisor/options-chain.handler.ts:63-86`
 *     (`toHttpError`), `.../tools/market-data.ts:272-297`
 *     (`fetchChainForExpiry`'s `SYMBOL_NOT_FOUND`).
 *
 * F. A second capture replaces the first; nothing recomputes on read (AC 6.3)
 *   Pre: an open call leg already captured once via Black-Scholes.
 *   Call: `captureEntryGreeks` again on the same leg with different
 *     volatility/spot/rate.
 *   Result: exactly one `position_entry_greeks` row for the leg; its Greeks
 *     equal the SECOND call's `blackScholes` output, not the first's — the
 *     stored row is the literal write, read back unmodified, never a
 *     recomputed value.
 *   Source: design C7 Post-condition ("an upsert ... replaces the old row.
 *     Nothing recomputes on read."); requirements AC 6.3.
 *
 * G. Invalid Black-Scholes inputs are a 400, no write (AC 6.4)
 *   Pre: an open call leg with a valid, positive T.
 *   Call: `captureEntryGreeks` with `volatility: -0.1` (fails
 *     `BlackScholesInputSchema`'s `sigma` positivity).
 *   Result: rejects `ValidationError`; no row written.
 *   Source: design C7 Black-Scholes ("must pass BlackScholesInputSchema ...
 *     else 400"); requirements AC 6.4.
 *
 * H. A non-positive T is a 400, no write (AC 6.4)
 *   Pre: a leg whose first entry fill is filled AFTER its own symbol's
 *     expiry, so `T <= 0`.
 *   Call: `captureEntryGreeks` with otherwise-valid Black-Scholes inputs.
 *   Result: rejects `ValidationError`; no row written.
 *   Source: design C7 Black-Scholes ("T must be positive, else 400");
 *     requirements AC 6.4.
 *
 * I. A foreign leg is 404 (NFR Security — scope by user)
 *   Pre: a leg owned by user A.
 *   Call: `captureEntryGreeks(db, userB, legId, ...)`.
 *   Result: rejects `NotFoundError`; no row written.
 *   Source: requirements Non-Functional Requirements > Security ("a foreign id
 *     SHALL read as not found").
 *
 * J. No key material or provider text ever reaches the thrown error (NFR
 *    Security)
 *   Pre: an open call leg; the decrypted key plaintext and the upstream
 *     failure message both carry a distinctive marker string.
 *   Call: `captureEntryGreeks(db, userId, legId, { source: 'chain' })`,
 *     where the option-contracts fetch rejects with that marked message.
 *   Result: the rejection's `message` contains neither marker string; no row
 *     written.
 *   Source: requirements Non-Functional Requirements > Security ("The key
 *     plaintext and the provider's raw message SHALL never be returned or
 *     logged."); `options-chain.handler.ts:63-86` (`toHttpError`'s default
 *     branch never surfaces the raw error).
 *
 * AC 6.5 ("Capture SHALL be optional; no volatility solver is added") is
 * RED-IMPOSSIBLE: it is a negative-existence claim with no seam to call. The
 * design's own input shape (`{ source: 'black_scholes'; volatility; spot;
 * rate; dividendYield? } | { source: 'chain' }`) has no "solve for IV from a
 * price" branch to invoke, before or after this task's implementation exists
 * — there is nothing a red test could observe going from green to red.
 *
 * AC 6.3's "never recomputed on read" clause has no independent seam in this
 * task (no read endpoint is added here): it is covered implicitly by A, B and
 * F reading back the committed row via a direct `db.select()` — the same
 * select a recompute-on-read bug would also have to pass through unchanged.
 */
import Decimal from 'decimal.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { blackScholes, expiryInstant } from '@tradr/shared';

import { db } from '@/db';
import { accounts, positionEntryGreeks, users } from '@/db/schema';
import { captureEntryGreeks } from '@/features/positions/entry-greeks.service';
import { addFillTx, createPositionTx, openPositionTx } from '@/features/positions/positions.service';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { withTransaction } from '@/lib/transaction';

// --- Module mocks (advisor.options-chain.route.test.ts pattern) ------------

const selectUnusualWhalesKeyCiphertext = vi.fn();
const getExpiryBreakdown = vi.fn();
const getOptionContracts = vi.fn();
const createUnusualWhalesClient = vi.fn(() => ({ getExpiryBreakdown, getOptionContracts }));

vi.mock('@/features/advisor/external-keys.query', () => ({
  selectUnusualWhalesKeyCiphertext: (...a: unknown[]) => selectUnusualWhalesKeyCiphertext(...a),
}));
vi.mock('@/lib/encryption', async () => {
  const actual = await vi.importActual<typeof import('@/lib/encryption')>('@/lib/encryption');
  return { ...actual, decrypt: (envelope: string) => envelope.replace(/^enc\(|\)$/g, '') };
});
vi.mock('@/features/advisor/lib/unusual-whales.client', async () => {
  const actual = await vi.importActual<typeof import('@/features/advisor/lib/unusual-whales.client')>(
    '@/features/advisor/lib/unusual-whales.client',
  );
  return { ...actual, createUnusualWhalesClient: () => createUnusualWhalesClient() };
});

beforeEach(() => {
  vi.clearAllMocks();
  createUnusualWhalesClient.mockReturnValue({ getExpiryBreakdown, getOptionContracts });
});

afterEach(() => {
  vi.clearAllMocks();
});

// --- Fixtures ----------------------------------------------------------------

const UNDERLYING = 'AAPL';

let counter = 0;
function uniqueEmail() {
  return `entry-greeks-${Date.now()}-${++counter}@example.com`;
}

function occSymbol(underlying: string, type: 'C' | 'P', strike: number, yymmdd: string) {
  const strikeField = Math.round(strike * 1000)
    .toString()
    .padStart(8, '0');
  return `${underlying}${yymmdd}${type}${strikeField}`;
}

async function seedUserAndAccount() {
  const [user] = await db
    .insert(users)
    .values({ email: uniqueEmail(), passwordHash: 'x'.repeat(60) })
    .returning();
  const [account] = await db
    .insert(accounts)
    .values({ userId: user!.id, name: 'Entry Greeks Account', currency: 'USD' })
    .returning();
  return { userId: user!.id, accountId: account!.id };
}

async function createOptionLeg(params: {
  side: 'long' | 'short';
  symbol: string;
  entryPrice: string;
  entryQty: string;
  filledAt: string;
}) {
  const { userId, accountId } = await seedUserAndAccount();
  const { legId } = await withTransaction(db, async (tx) => {
    const pos = await createPositionTx(tx, userId, {
      accountId,
      symbol: params.symbol,
      side: params.side,
      assetType: 'option',
    });
    await addFillTx(tx, pos!.id, userId, {
      type: 'entry',
      price: params.entryPrice,
      quantity: params.entryQty,
      fees: '0',
      filledAt: params.filledAt,
    });
    await openPositionTx(tx, pos!.id, userId, params.filledAt);
    return { legId: pos!.id as string };
  });
  return { userId, accountId, legId };
}

async function getEntryGreeksRows(legId: string) {
  return db.select().from(positionEntryGreeks).where(eq(positionEntryGreeks.positionId, legId));
}

const FUTURE_EXPIRATION_YYMMDD = '280115';
const FUTURE_EXPIRATION_ISO = '2028-01-15';
const FUTURE_FILLED_AT = '2027-01-15T14:30:00.000Z';
const STRIKE = 150;

function computeT(expirationIso: string, filledAt: string) {
  return (
    (expiryInstant(expirationIso).getTime() - new Date(filledAt).getTime()) /
    (365 * 24 * 60 * 60 * 1000)
  );
}

describe('captureEntryGreeks — a Black-Scholes capture stores values equal to blackScholes for that T (AC 6.1)', () => {
  it('stores delta, gamma, thetaPerDay, vegaPerPct, rhoPerPct equal to blackScholes, plus source and inputs', async () => {
    const symbol = occSymbol(UNDERLYING, 'C', STRIKE, FUTURE_EXPIRATION_YYMMDD);
    const { userId, legId } = await createOptionLeg({
      side: 'long',
      symbol,
      entryPrice: '5.00',
      entryQty: '1',
      filledAt: FUTURE_FILLED_AT,
    });

    const volatility = 0.28;
    const spot = 160;
    const rate = 0.045;

    await captureEntryGreeks(db, userId, legId, {
      source: 'black_scholes',
      volatility,
      spot,
      rate,
    });

    const T = computeT(FUTURE_EXPIRATION_ISO, FUTURE_FILLED_AT);
    expect(T).toBeGreaterThan(0);
    const expected = blackScholes({
      S: spot,
      K: STRIKE,
      T,
      sigma: volatility,
      r: rate,
      q: 0,
      type: 'call',
    });

    const rows = await getEntryGreeksRows(legId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.source).toBe('black_scholes');
    expect(new Decimal(row.delta).equals(new Decimal(expected.delta))).toBe(true);
    expect(new Decimal(row.gamma).equals(new Decimal(expected.gamma))).toBe(true);
    expect(new Decimal(row.thetaPerDay).equals(new Decimal(expected.thetaPerDay))).toBe(true);
    expect(new Decimal(row.vegaPerPct).equals(new Decimal(expected.vegaPerPct))).toBe(true);
    expect(new Decimal(row.rhoPerPct!).equals(new Decimal(expected.rhoPerPct))).toBe(true);
    expect(new Decimal(row.volatility!).equals(new Decimal(volatility))).toBe(true);
    expect(new Decimal(row.spot!).equals(new Decimal(spot))).toBe(true);
    expect(new Decimal(row.rate!).equals(new Decimal(rate))).toBe(true);
  });
});

describe('captureEntryGreeks — a chain capture (client mocked) stores the four Greeks, rho null and source chain (AC 6.2)', () => {
  it('stores delta, gamma, thetaPerDay, vegaPerPct from the mocked contract, rhoPerPct null, source chain', async () => {
    const symbol = occSymbol(UNDERLYING, 'C', STRIKE, FUTURE_EXPIRATION_YYMMDD);
    const { userId, legId } = await createOptionLeg({
      side: 'long',
      symbol,
      entryPrice: '5.00',
      entryQty: '1',
      filledAt: FUTURE_FILLED_AT,
    });

    selectUnusualWhalesKeyCiphertext.mockResolvedValue({
      encryptedKey: 'enc(test-key-plaintext)',
      keyVersion: 1,
    });
    getExpiryBreakdown.mockResolvedValue({ data: [{ expires: FUTURE_EXPIRATION_ISO }] });
    getOptionContracts.mockResolvedValue({
      data: [
        {
          option_symbol: symbol,
          delta: 0.52,
          gamma: 0.013,
          theta: -0.045,
          vega: 0.21,
          nbbo_bid: '4.9',
          nbbo_ask: '5.1',
        },
      ],
    });

    await captureEntryGreeks(db, userId, legId, { source: 'chain' });

    const rows = await getEntryGreeksRows(legId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.source).toBe('chain');
    expect(new Decimal(row.delta).equals(new Decimal(0.52))).toBe(true);
    expect(new Decimal(row.gamma).equals(new Decimal(0.013))).toBe(true);
    expect(new Decimal(row.thetaPerDay).equals(new Decimal(-0.045))).toBe(true);
    expect(new Decimal(row.vegaPerPct).equals(new Decimal(0.21))).toBe(true);
    expect(row.rhoPerPct).toBeNull();
  });
});

describe('captureEntryGreeks — no Unusual Whales key is a 409, no write', () => {
  it('rejects with statusCode 409 and writes nothing', async () => {
    const symbol = occSymbol(UNDERLYING, 'C', STRIKE, FUTURE_EXPIRATION_YYMMDD);
    const { userId, legId } = await createOptionLeg({
      side: 'long',
      symbol,
      entryPrice: '5.00',
      entryQty: '1',
      filledAt: FUTURE_FILLED_AT,
    });

    selectUnusualWhalesKeyCiphertext.mockResolvedValue(null);

    await expect(captureEntryGreeks(db, userId, legId, { source: 'chain' })).rejects.toMatchObject(
      { statusCode: 409 },
    );

    expect(await getEntryGreeksRows(legId)).toHaveLength(0);
  });
});

describe('captureEntryGreeks — a contract missing a required Greek is a 409, no write', () => {
  it('rejects with statusCode 409 when the contract has no vega', async () => {
    const symbol = occSymbol(UNDERLYING, 'C', STRIKE, FUTURE_EXPIRATION_YYMMDD);
    const { userId, legId } = await createOptionLeg({
      side: 'long',
      symbol,
      entryPrice: '5.00',
      entryQty: '1',
      filledAt: FUTURE_FILLED_AT,
    });

    selectUnusualWhalesKeyCiphertext.mockResolvedValue({
      encryptedKey: 'enc(test-key-plaintext)',
      keyVersion: 1,
    });
    getExpiryBreakdown.mockResolvedValue({ data: [{ expires: FUTURE_EXPIRATION_ISO }] });
    getOptionContracts.mockResolvedValue({
      data: [
        {
          option_symbol: symbol,
          delta: 0.52,
          gamma: 0.013,
          theta: -0.045,
          // vega omitted
        },
      ],
    });

    await expect(captureEntryGreeks(db, userId, legId, { source: 'chain' })).rejects.toMatchObject(
      { statusCode: 409 },
    );

    expect(await getEntryGreeksRows(legId)).toHaveLength(0);
  });
});

describe('captureEntryGreeks — an expired/unlisted contract reads 404 through toHttpError', () => {
  it('rejects with statusCode 404 when the expiry breakdown has no matching expiry', async () => {
    const symbol = occSymbol(UNDERLYING, 'C', STRIKE, FUTURE_EXPIRATION_YYMMDD);
    const { userId, legId } = await createOptionLeg({
      side: 'long',
      symbol,
      entryPrice: '5.00',
      entryQty: '1',
      filledAt: FUTURE_FILLED_AT,
    });

    selectUnusualWhalesKeyCiphertext.mockResolvedValue({
      encryptedKey: 'enc(test-key-plaintext)',
      keyVersion: 1,
    });
    getExpiryBreakdown.mockResolvedValue({ data: [] });

    await expect(captureEntryGreeks(db, userId, legId, { source: 'chain' })).rejects.toMatchObject(
      { statusCode: 404 },
    );

    expect(await getEntryGreeksRows(legId)).toHaveLength(0);
  });
});

describe('captureEntryGreeks — a second capture replaces the first, never recomputed on read (AC 6.3)', () => {
  it('leaves exactly one row, holding the second call\'s blackScholes values', async () => {
    const symbol = occSymbol(UNDERLYING, 'C', STRIKE, FUTURE_EXPIRATION_YYMMDD);
    const { userId, legId } = await createOptionLeg({
      side: 'long',
      symbol,
      entryPrice: '5.00',
      entryQty: '1',
      filledAt: FUTURE_FILLED_AT,
    });

    await captureEntryGreeks(db, userId, legId, {
      source: 'black_scholes',
      volatility: 0.28,
      spot: 160,
      rate: 0.045,
    });

    const secondVolatility = 0.35;
    const secondSpot = 155;
    const secondRate = 0.05;
    await captureEntryGreeks(db, userId, legId, {
      source: 'black_scholes',
      volatility: secondVolatility,
      spot: secondSpot,
      rate: secondRate,
    });

    const T = computeT(FUTURE_EXPIRATION_ISO, FUTURE_FILLED_AT);
    const expectedSecond = blackScholes({
      S: secondSpot,
      K: STRIKE,
      T,
      sigma: secondVolatility,
      r: secondRate,
      q: 0,
      type: 'call',
    });

    const rows = await getEntryGreeksRows(legId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(new Decimal(row.delta).equals(new Decimal(expectedSecond.delta))).toBe(true);
    expect(new Decimal(row.gamma).equals(new Decimal(expectedSecond.gamma))).toBe(true);
    expect(new Decimal(row.vegaPerPct).equals(new Decimal(expectedSecond.vegaPerPct))).toBe(true);
  });
});

describe('captureEntryGreeks — invalid Black-Scholes inputs are a 400, no write (AC 6.4)', () => {
  it('rejects ValidationError for a non-positive volatility and writes nothing', async () => {
    const symbol = occSymbol(UNDERLYING, 'C', STRIKE, FUTURE_EXPIRATION_YYMMDD);
    const { userId, legId } = await createOptionLeg({
      side: 'long',
      symbol,
      entryPrice: '5.00',
      entryQty: '1',
      filledAt: FUTURE_FILLED_AT,
    });

    await expect(
      captureEntryGreeks(db, userId, legId, {
        source: 'black_scholes',
        volatility: -0.1,
        spot: 160,
        rate: 0.045,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await getEntryGreeksRows(legId)).toHaveLength(0);
  });
});

describe('captureEntryGreeks — a non-positive T is a 400, no write (AC 6.4)', () => {
  it('rejects ValidationError when the first entry fill postdates the symbol expiry', async () => {
    // Expiry 2026-01-15, but the entry fill lands months later — T <= 0.
    const symbol = occSymbol(UNDERLYING, 'C', STRIKE, '260115');
    const { userId, legId } = await createOptionLeg({
      side: 'long',
      symbol,
      entryPrice: '5.00',
      entryQty: '1',
      filledAt: '2026-06-01T00:00:00.000Z',
    });

    await expect(
      captureEntryGreeks(db, userId, legId, {
        source: 'black_scholes',
        volatility: 0.3,
        spot: 150,
        rate: 0.045,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await getEntryGreeksRows(legId)).toHaveLength(0);
  });
});

describe('captureEntryGreeks — a foreign leg is 404 (NFR Security)', () => {
  it('rejects NotFoundError when the leg belongs to a different user and writes nothing', async () => {
    const symbol = occSymbol(UNDERLYING, 'C', STRIKE, FUTURE_EXPIRATION_YYMMDD);
    const { legId } = await createOptionLeg({
      side: 'long',
      symbol,
      entryPrice: '5.00',
      entryQty: '1',
      filledAt: FUTURE_FILLED_AT,
    });
    const { userId: otherUserId } = await seedUserAndAccount();

    await expect(
      captureEntryGreeks(db, otherUserId, legId, {
        source: 'black_scholes',
        volatility: 0.3,
        spot: 150,
        rate: 0.045,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(await getEntryGreeksRows(legId)).toHaveLength(0);
  });
});

describe('captureEntryGreeks — no key material or provider text ever reaches the thrown error (NFR Security)', () => {
  it('keeps the decrypted key and the raw provider failure out of the rejection message', async () => {
    const symbol = occSymbol(UNDERLYING, 'C', STRIKE, FUTURE_EXPIRATION_YYMMDD);
    const { userId, legId } = await createOptionLeg({
      side: 'long',
      symbol,
      entryPrice: '5.00',
      entryQty: '1',
      filledAt: FUTURE_FILLED_AT,
    });

    const KEY_MARKER = 'SECRET_PLAINTEXT_KEY_42';
    const PROVIDER_MARKER = 'RAW_PROVIDER_DETAIL_99';

    selectUnusualWhalesKeyCiphertext.mockResolvedValue({
      encryptedKey: `enc(${KEY_MARKER})`,
      keyVersion: 1,
    });
    getExpiryBreakdown.mockResolvedValue({ data: [{ expires: FUTURE_EXPIRATION_ISO }] });
    getOptionContracts.mockRejectedValue(new Error(`${PROVIDER_MARKER} leaked from upstream`));

    let caught: unknown;
    try {
      await captureEntryGreeks(db, userId, legId, { source: 'chain' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).not.toContain(KEY_MARKER);
    expect(message).not.toContain(PROVIDER_MARKER);

    expect(await getEntryGreeksRows(legId)).toHaveLength(0);
  });
});

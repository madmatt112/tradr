import { describe, expect, it } from 'vitest';

import app from '@/app';

let testCounter = 0;
const testRunId = Date.now();
function uniqueEmail() {
  return `calc-test${testRunId}-${++testCounter}@example.com`;
}

let ipCounter = 300;
function uniqueIp() {
  return `10.3.0.${++ipCounter}`;
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

const zeroFeeSchedule = {
  stockPerShareCommission: '0.005',
  stockMinPerFill: '1',
  stockMaxPerFill: '0',
  optionsPerContractCommission: '0.65',
  optionsPerContractExchangeFee: '0',
  optionsMinPerFill: '0',
  optionsMaxPerFill: '0',
};

describe('POST /api/calculator', () => {
  it('returns 200 with expected output for valid long stock input', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/calculator', cookie, {
      entryPrice: '50',
      stopLoss: '48',
      dollarRisk: '1000',
      direction: 'long',
      mode: 'stock',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.positionSize).toBe(500);
    expect(body.perUnitRisk).toBe('2.00');
    expect(body.actualDollarRisk).toBe('1000.00');
    expect(body.totalPositionValue).toBe('25000.00');
  });

  it('returns 200 with 100x-multiplied values for options mode', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/calculator', cookie, {
      entryPrice: '50',
      stopLoss: '48',
      dollarRisk: '1000',
      direction: 'long',
      mode: 'options',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.positionSize).toBe(5);
    expect(body.perUnitRisk).toBe('2.00');
    expect(body.actualDollarRisk).toBe('1000.00');
    expect(body.totalPositionValue).toBe('25000.00');
  });

  it('returns 200 with perUnitReward and riskRewardRatio when target provided', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/calculator', cookie, {
      entryPrice: '50',
      stopLoss: '48',
      targetPrice: '55',
      dollarRisk: '1000',
      direction: 'long',
      mode: 'stock',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.perUnitReward).toBe('5.00');
    expect(body.riskRewardRatio).toBe('2.50');
    expect(typeof body.perUnitReward).toBe('string');
    expect(typeof body.riskRewardRatio).toBe('string');
  });

  it('returns 200 with estimatedFees and adjusted fields when feeSchedule provided', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/calculator', cookie, {
      entryPrice: '50',
      stopLoss: '48',
      targetPrice: '55',
      dollarRisk: '1000',
      direction: 'long',
      mode: 'stock',
      feeSchedule: zeroFeeSchedule,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.positionSize).toBe(500);
    expect(body.actualDollarRisk).toBe('1000.00');
    expect(body.estimatedFees).toBe('5.00');
    expect(body.feeToRiskPercent).toBe('0.50');
    expect(body.adjustedDollarRisk).toBe('1005.00');
    expect(body.breakeven).toBe('50.01');
    expect(body.adjustedRiskRewardRatio).toBe('2.48');
  });

  it('returns 400 when required field is missing', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/calculator', cookie, {
      entryPrice: '50',
      stopLoss: '48',
      direction: 'long',
      mode: 'stock',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when entryPrice is a number instead of a string', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/calculator', cookie, {
      entryPrice: 50,
      stopLoss: '48',
      dollarRisk: '1000',
      direction: 'long',
      mode: 'stock',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 with exact contract message when stop is on the wrong side for long', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/calculator', cookie, {
      entryPrice: '50',
      stopLoss: '52',
      dollarRisk: '1000',
      direction: 'long',
      mode: 'stock',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe('Stop loss must be below entry for long positions');
  });

  it('returns 400 when both feeSchedule and manualFees are provided', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/calculator', cookie, {
      entryPrice: '50',
      stopLoss: '48',
      dollarRisk: '1000',
      direction: 'long',
      mode: 'stock',
      feeSchedule: zeroFeeSchedule,
      manualFees: '5',
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 for unauthenticated requests', async () => {
    const res = await app.request('/api/calculator', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': uniqueIp(),
      },
      body: JSON.stringify({
        entryPrice: '50',
        stopLoss: '48',
        dollarRisk: '1000',
        direction: 'long',
        mode: 'stock',
      }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 200 with positionSize 0 and omits all optional fields when dollar risk is too small', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/calculator', cookie, {
      entryPrice: '50',
      stopLoss: '48',
      targetPrice: '55',
      dollarRisk: '1',
      direction: 'long',
      mode: 'stock',
      feeSchedule: zeroFeeSchedule,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.positionSize).toBe(0);
    expect(body.perUnitRisk).toBe('2.00');
    expect(body.actualDollarRisk).toBe('0.00');
    expect(body.totalPositionValue).toBe('0.00');
    expect(body.perUnitReward).toBeUndefined();
    expect(body.riskRewardRatio).toBeUndefined();
    expect(body.estimatedFees).toBeUndefined();
    expect(body.feeToRiskPercent).toBeUndefined();
    expect(body.adjustedDollarRisk).toBeUndefined();
    expect(body.breakeven).toBeUndefined();
    expect(body.adjustedRiskRewardRatio).toBeUndefined();
  });

  it('returns 200 where a percent basis matches the equivalent dollar-risk request on the sizing fields', async () => {
    const { cookie } = await registerAndGetCookie();
    const base = {
      entryPrice: '50',
      stopLoss: '48',
      direction: 'long',
      mode: 'stock',
    };

    const dollarRes = await authedRequest('POST', '/api/calculator', cookie, {
      ...base,
      dollarRisk: '1000',
    });
    expect(dollarRes.status).toBe(200);
    const dollarBody = await dollarRes.json();

    // 2% of 50000 = 1000, the same full-precision dollar risk.
    const percentRes = await authedRequest('POST', '/api/calculator', cookie, {
      ...base,
      balance: '50000',
      riskPercent: '2',
    });
    expect(percentRes.status).toBe(200);
    const percentBody = await percentRes.json();

    // Assert the sizing fields individually (not whole-body equality — the
    // percent response additionally carries derivedDollarRisk).
    expect(percentBody.positionSize).toBe(dollarBody.positionSize);
    expect(percentBody.perUnitRisk).toBe(dollarBody.perUnitRisk);
    expect(percentBody.actualDollarRisk).toBe(dollarBody.actualDollarRisk);
    expect(percentBody.totalPositionValue).toBe(dollarBody.totalPositionValue);
    expect(percentBody.positionSize).toBe(500);
    expect(percentBody.derivedDollarRisk).toBe('1000.00');
    expect(dollarBody.derivedDollarRisk).toBeUndefined();
  });

  it('returns 400 when both risk bases are supplied', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/calculator', cookie, {
      entryPrice: '50',
      stopLoss: '48',
      dollarRisk: '1000',
      balance: '50000',
      riskPercent: '2',
      direction: 'long',
      mode: 'stock',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when riskPercent is out of the (0,100] range', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/calculator', cookie, {
      entryPrice: '50',
      stopLoss: '48',
      balance: '50000',
      riskPercent: '150',
      direction: 'long',
      mode: 'stock',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for NaN / Infinity / blank / out-of-domain balance', async () => {
    const { cookie } = await registerAndGetCookie();
    const badBalances = ['abc', 'Infinity', '   ', '999999999999999999'];
    for (const balance of badBalances) {
      const res = await authedRequest('POST', '/api/calculator', cookie, {
        entryPrice: '50',
        stopLoss: '48',
        balance,
        riskPercent: '2',
        direction: 'long',
        mode: 'stock',
      });
      expect(res.status).toBe(400);
    }
  });

  it('returns 200 nothing-to-size-against for negative or zero balance (not a 400)', async () => {
    const { cookie } = await registerAndGetCookie();
    for (const balance of ['-500', '0']) {
      const res = await authedRequest('POST', '/api/calculator', cookie, {
        entryPrice: '50',
        stopLoss: '48',
        balance,
        riskPercent: '2',
        direction: 'long',
        mode: 'stock',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.positionSize).toBe(0);
      expect(body.sizingStatus).toBe('nothing-to-size-against');
      expect(body.derivedDollarRisk).toBeUndefined();
    }
  });

  it('returns 400 with BOTH the percent-range and the exactly-one-basis root issue', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/calculator', cookie, {
      entryPrice: '50',
      stopLoss: '48',
      riskPercent: '150',
      balance: '',
      direction: 'long',
      mode: 'stock',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    // Percent range error is present...
    expect(body.error.details.riskPercent).toBe('Must be a positive number up to 100');
    // ...alongside the root exactly-one-basis issue (empty is treated as not supplied).
    expect(body.error.details._root).toBe(
      'Provide exactly one risk basis: a dollar risk, or a balance and risk percent.',
    );
    // The message must read correctly for the neither/incomplete shape — never "not both".
    expect(body.error.details._root).not.toContain('not both');
  });

  it('returns 200 positionSize 0 + exceeds-maximum discriminator (derivedDollarRisk echoed)', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/calculator', cookie, {
      entryPrice: '50',
      stopLoss: '48',
      balance: '250000000',
      riskPercent: '100',
      direction: 'long',
      mode: 'stock',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.positionSize).toBe(0);
    expect(body.sizingStatus).toBe('exceeds-maximum');
    expect(body.derivedDollarRisk).toBe('250000000.00');
  });

  it('returns 200 positionSize 0 + buying-power-zero discriminator (derivedDollarRisk echoed)', async () => {
    const { cookie } = await registerAndGetCookie();
    // derived $50 sizes ≥ 1 unit at $1 risk, but floor(50 / 100) = 0 units affordable.
    const res = await authedRequest('POST', '/api/calculator', cookie, {
      entryPrice: '100',
      stopLoss: '99',
      balance: '50',
      riskPercent: '100',
      direction: 'long',
      mode: 'stock',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.positionSize).toBe(0);
    expect(body.sizingStatus).toBe('buying-power-zero');
    expect(body.derivedDollarRisk).toBe('50.00');
  });

  it('returns 200 with a capped positionSize and buyingPowerLimited when the cap binds', async () => {
    const { cookie } = await registerAndGetCookie();
    // derived $5000 → 5000 shares by risk, but the balance funds only floor(10000/100) = 100.
    const res = await authedRequest('POST', '/api/calculator', cookie, {
      entryPrice: '100',
      stopLoss: '99',
      balance: '10000',
      riskPercent: '50',
      direction: 'long',
      mode: 'stock',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.positionSize).toBe(100);
    expect(body.buyingPowerLimited).toBe(true);
    expect(body.derivedDollarRisk).toBe('5000.00');
    // Capped actual dollar risk is below the derived target.
    expect(body.actualDollarRisk).toBe('100.00');
  });
});

// ---------------------------------------------------------------------------
// Buying-power basis — the stored preference
// ---------------------------------------------------------------------------

describe('GET/PUT /api/users/me/buying-power-basis', () => {
  async function getBasis(cookie: string) {
    const res = await authedRequest('GET', '/api/users/me/buying-power-basis', cookie);
    expect(res.status).toBe(200);
    return (await res.json()).basis;
  }

  it('defaults a brand-new user to cash', async () => {
    // The default is load-bearing, not cosmetic: 'balance' would let the
    // calculator size a position the account cannot fund.
    const { cookie } = await registerAndGetCookie();
    expect(await getBasis(cookie)).toBe('cash');
  });

  it('round-trips a change to balance and back', async () => {
    const { cookie } = await registerAndGetCookie();

    const toBalance = await authedRequest('PUT', '/api/users/me/buying-power-basis', cookie, {
      basis: 'balance',
    });
    expect(toBalance.status).toBe(200);
    expect((await toBalance.json()).basis).toBe('balance');
    expect(await getBasis(cookie)).toBe('balance');

    const toCash = await authedRequest('PUT', '/api/users/me/buying-power-basis', cookie, {
      basis: 'cash',
    });
    expect(toCash.status).toBe(200);
    expect(await getBasis(cookie)).toBe('cash');
  });

  it('rejects a value outside the enum', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('PUT', '/api/users/me/buying-power-basis', cookie, {
      basis: 'equity',
    });
    expect(res.status).toBe(400);
    // The rejected write must not have landed.
    expect(await getBasis(cookie)).toBe('cash');
  });

  it('rejects a missing body field', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('PUT', '/api/users/me/buying-power-basis', cookie, {});
    expect(res.status).toBe(400);
  });

  it('requires authentication on both verbs', async () => {
    const get = await app.request('/api/users/me/buying-power-basis', {
      headers: { 'X-Forwarded-For': uniqueIp() },
    });
    expect(get.status).toBe(401);

    const put = await app.request('/api/users/me/buying-power-basis', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() },
      body: JSON.stringify({ basis: 'balance' }),
    });
    expect(put.status).toBe(401);
  });

  it('is scoped per user', async () => {
    const a = await registerAndGetCookie();
    const b = await registerAndGetCookie();

    await authedRequest('PUT', '/api/users/me/buying-power-basis', a.cookie, {
      basis: 'balance',
    });

    expect(await getBasis(a.cookie)).toBe('balance');
    expect(await getBasis(b.cookie)).toBe('cash');
  });
});

describe('POST /api/calculator — buyingPower', () => {
  it('caps against buyingPower while the risk budget stays on balance', async () => {
    const { cookie } = await registerAndGetCookie();
    // $5,000 equity, $4,000 deployed ⇒ $1,000 cash. Budget 1% = $50 → 25
    // shares; cap = floor(1000 / 50) = 20 binds.
    const res = await authedRequest('POST', '/api/calculator', cookie, {
      entryPrice: '50',
      stopLoss: '48',
      balance: '5000',
      buyingPower: '1000',
      riskPercent: '1',
      direction: 'long',
      mode: 'stock',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.positionSize).toBe(20);
    expect(body.buyingPowerLimited).toBe(true);
    expect(body.derivedDollarRisk).toBe('50.00');
  });

  it('falls back to balance when buyingPower is omitted', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/calculator', cookie, {
      entryPrice: '50',
      stopLoss: '48',
      balance: '5000',
      riskPercent: '1',
      direction: 'long',
      mode: 'stock',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.positionSize).toBe(25);
    expect(body.buyingPowerLimited).toBeUndefined();
  });

  it('reports buying-power-zero for a fully-deployed account, not a 400', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/calculator', cookie, {
      entryPrice: '50',
      stopLoss: '48',
      balance: '5000',
      buyingPower: '0',
      riskPercent: '1',
      direction: 'long',
      mode: 'stock',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.positionSize).toBe(0);
    expect(body.sizingStatus).toBe('buying-power-zero');
  });

  it('accepts a negative buyingPower and zeroes the size', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/calculator', cookie, {
      entryPrice: '50',
      stopLoss: '48',
      balance: '5000',
      buyingPower: '-500',
      riskPercent: '1',
      direction: 'long',
      mode: 'stock',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.positionSize).toBe(0);
    expect(body.sizingStatus).toBe('buying-power-zero');
  });

  it('400s on an unparseable buyingPower', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/calculator', cookie, {
      entryPrice: '50',
      stopLoss: '48',
      balance: '5000',
      buyingPower: 'lots',
      riskPercent: '1',
      direction: 'long',
      mode: 'stock',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/calculator — buyingPower on the dollar basis', () => {
  const dollarTrade = {
    entryPrice: '50',
    stopLoss: '48',
    dollarRisk: '1000',
    direction: 'long',
    mode: 'stock',
  };

  it('caps a dollar-basis size and flags it', async () => {
    const { cookie } = await registerAndGetCookie();
    // 1000 / 2 = 500 shares uncapped; floor(10000 / 50) = 200 binds.
    const res = await authedRequest('POST', '/api/calculator', cookie, {
      ...dollarTrade,
      buyingPower: '10000',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.positionSize).toBe(200);
    expect(body.buyingPowerLimited).toBe(true);
    // Percent-only echo stays absent even though the cap fired.
    expect(body.derivedDollarRisk).toBeUndefined();
  });

  it('leaves the dollar basis uncapped when buyingPower is omitted', async () => {
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/calculator', cookie, dollarTrade);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.positionSize).toBe(500);
    expect(body.buyingPowerLimited).toBeUndefined();
  });

  it('returns buying-power-zero on the dollar basis as a 200, not a 500', async () => {
    // Guards the `to2dp(null!)` crash: the percent path echoes derivedDollarRisk
    // on this outcome, and there is none to echo here.
    const { cookie } = await registerAndGetCookie();
    const res = await authedRequest('POST', '/api/calculator', cookie, {
      ...dollarTrade,
      entryPrice: '100',
      buyingPower: '50',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.positionSize).toBe(0);
    expect(body.sizingStatus).toBe('buying-power-zero');
    expect(body.derivedDollarRisk).toBeUndefined();
  });
});

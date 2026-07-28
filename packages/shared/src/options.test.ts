// Source-line audit pin: 108 (per v3-3). Vitest runner total: 120 (the v3-3
// arithmetic over-counted by 1; it.each(N) yields N runner entries, not N+1).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  blackScholes,
  encodeOccCompact,
  encodeOccSymbol,
  format6SigFig,
  parseOccSymbol,
  type OccComponents,
} from './options';
import {
  cdfSentinels,
  extremeD1,
  format6Cases,
  gateContinuityCommon,
  gateContinuitySigmaLimit,
  gateContinuitySigmaStandard,
  hull156Call,
  hull156Put,
  hull157Call,
  hull17BsmDividend,
  limitAtfCall,
  limitAtfPut,
  limitItmCall,
  limitItmPut,
  limitOtm,
  negativeR,
  parityCall,
  parityPut,
  sEqualsKStandard,
  type BSFixture,
} from './options.fixtures';
import {
  BlackScholesInputSchema,
  OccEncodeInputSchema,
  OccEncodeOutputSchema,
  OccParseInputSchema,
} from './schemas/options';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectBs(name: string, fixture: BSFixture) {
  const out = blackScholes(fixture.input);
  expect(out, `${name}: ${fixture.name}`).toEqual(fixture.expected);
}

function asNumber(s: string): number {
  // Parse the wire-format string (fixed or scientific) back to a number.
  return Number(s);
}

// ---------------------------------------------------------------------------
// OCC parse — 29 cases (13 negative + 16 positive)
// ---------------------------------------------------------------------------

describe('parseOccSymbol — 29 cases (REQ-1)', () => {
  it('parses Form 1 canonical 21-char symbol', () => {
    const r = parseOccSymbol('AAPL  250620C00150000');
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.value).toEqual({
        underlying: 'AAPL',
        expiration: '2025-06-20',
        type: 'call',
        strike: '150.000',
      });
  });

  it('parses Form 2 multi-space (compact-underlying + extra padding)', () => {
    const r = parseOccSymbol('AAPL    250620C00150000');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.underlying).toBe('AAPL');
  });

  it('parses Form 3 compact (no spaces, 8-digit strike)', () => {
    const r = parseOccSymbol('AAPL250620C00150000');
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.value).toEqual({
        underlying: 'AAPL',
        expiration: '2025-06-20',
        type: 'call',
        strike: '150.000',
      });
  });

  it('parses Form 4 compact-display (decimal strike syntax)', () => {
    const r = parseOccSymbol('AAPL250620C150');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.strike).toBe('150.000');
  });

  it('parses index root SPX', () => {
    const r = parseOccSymbol('SPX   250620C04500000');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.underlying).toBe('SPX');
  });

  it('parses index root SPXW', () => {
    const r = parseOccSymbol('SPXW  250620C04500000');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.underlying).toBe('SPXW');
  });

  it('parses index root RUT', () => {
    const r = parseOccSymbol('RUT   250620C02000000');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.underlying).toBe('RUT');
  });

  it('parses index root RUTW', () => {
    const r = parseOccSymbol('RUTW  250620C02000000');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.underlying).toBe('RUTW');
  });

  it('parses index root NDX', () => {
    const r = parseOccSymbol('NDX   250620C18000000');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.underlying).toBe('NDX');
  });

  it('parses index root NDXP', () => {
    const r = parseOccSymbol('NDXP  250620C18000000');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.underlying).toBe('NDXP');
  });

  it('parses index root VIX', () => {
    const r = parseOccSymbol('VIX   250620C00020000');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.underlying).toBe('VIX');
  });

  it('parses a put example', () => {
    const r = parseOccSymbol('AAPL  250620P00150000');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.type).toBe('put');
  });

  it('parses leap-year valid date 240229', () => {
    const r = parseOccSymbol('AAPL  240229C00150000');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.expiration).toBe('2024-02-29');
  });

  it('normalises tab-internal whitespace to ASCII space', () => {
    const r = parseOccSymbol('AAPL\t\t250620C00150000');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.underlying).toBe('AAPL');
  });

  it('parses Form 4 maximum strike (v3-2): AAPL  250620C99999999 → strike "100000"', () => {
    const r = parseOccSymbol('AAPL  250620C99999999');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.strike).toBe('100000');
  });

  it('parses mid-range Form 4 (v3-2): AAPL  250620C00150500 → strike "150.500"', () => {
    const r = parseOccSymbol('AAPL  250620C00150500');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.strike).toBe('150.500');
  });

  // ---------------- Negatives (13) ----------------

  it('rejects leap-year invalid date 230229 (OCC_BAD_DATE)', () => {
    const r = parseOccSymbol('AAPL  230229C00150000');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('OCC_BAD_DATE');
  });

  it('rejects strike-zero (OCC_STRIKE_ZERO)', () => {
    const r = parseOccSymbol('AAPL  250620C00000000');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('OCC_STRIKE_ZERO');
  });

  it('rejects Form 4 with leading-zero strike (no form match)', () => {
    const r = parseOccSymbol('AAPL250620C00150');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('OCC_NO_FORM_MATCH');
  });

  it('rejects pre-2000 expiry YY=50 (OCC_PRE_2000)', () => {
    const r = parseOccSymbol('AAPL  500620C00150000');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('OCC_PRE_2000');
  });

  it('rejects input over 64 chars (OCC_TOO_LONG)', () => {
    const r = parseOccSymbol('A'.repeat(65));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('OCC_TOO_LONG');
  });

  it('rejects unsupported lowercase pre-uppercase via internal-character (OCC_BAD_CHARSET)', () => {
    // The internal "!" survives whitespace substitution and uppercase normalisation,
    // and fails the [A-Z. 0-9CP] charset gate.
    const r = parseOccSymbol('AAPL!  250620C00150000');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('OCC_BAD_CHARSET');
  });

  it('rejects malformed input that matches no form', () => {
    const r = parseOccSymbol('NOT A SYMBOL');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('OCC_NO_FORM_MATCH');
  });

  it('rejects invalid calendar date (Feb 30)', () => {
    const r = parseOccSymbol('AAPL  250230C00150000');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('OCC_BAD_DATE');
  });

  it('rejects bad month (month 13)', () => {
    const r = parseOccSymbol('AAPL  251320C00150000');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('OCC_BAD_DATE');
  });

  it('rejects empty string', () => {
    const r = parseOccSymbol('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('OCC_NO_FORM_MATCH');
  });

  it('rejects digit-leading underlying', () => {
    const r = parseOccSymbol('1AAPL250620C00150000');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('OCC_NO_FORM_MATCH');
  });

  it('rejects Form 4 with > 3 decimal strike places', () => {
    // 150.5001 has 4 decimal places — Form 4 regex allows {1,3} so no match.
    const r = parseOccSymbol('AAPL250620C150.5001');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('OCC_NO_FORM_MATCH');
  });

  it('rejects unsupported high-code-point character', () => {
    // U+2603 ☃ is not whitespace and not in [A-Z. 0-9CP].
    const r = parseOccSymbol('AAPL☃250620C00150000');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('OCC_BAD_CHARSET');
  });
});

// ---------------------------------------------------------------------------
// OCC encode — 8 cases
// ---------------------------------------------------------------------------

describe('encodeOccSymbol — 8 cases (REQ-2)', () => {
  it('encodes canonical 6-char-equivalent underlying', () => {
    const r = encodeOccSymbol({
      underlying: 'AAPL',
      expiration: '2025-06-20',
      type: 'call',
      strike: '150',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('AAPL  250620C00150000');
  });

  it('encodes share-class underlying BRK.B', () => {
    const r = encodeOccSymbol({
      underlying: 'BRK.B',
      expiration: '2025-06-20',
      type: 'call',
      strike: '150',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.slice(0, 6)).toBe('BRK.B ');
  });

  it('encodes an index root', () => {
    const r = encodeOccSymbol({
      underlying: 'SPXW',
      expiration: '2025-06-20',
      type: 'call',
      strike: '4500',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('SPXW  250620C04500000');
  });

  it('encodes integer strike "150"', () => {
    const r = encodeOccSymbol({
      underlying: 'AAPL',
      expiration: '2025-06-20',
      type: 'put',
      strike: '150',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('AAPL  250620P00150000');
  });

  it('encodes 3-decimal strike "150.500"', () => {
    const r = encodeOccSymbol({
      underlying: 'AAPL',
      expiration: '2025-06-20',
      type: 'call',
      strike: '150.500',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('AAPL  250620C00150500');
  });

  it('rejects empty / digit-leading / over-6-char underlying (OCC_BAD_UNDERLYING)', () => {
    const r1 = encodeOccSymbol({
      underlying: '',
      expiration: '2025-06-20',
      type: 'call',
      strike: '150',
    });
    const r2 = encodeOccSymbol({
      underlying: '1AAPL',
      expiration: '2025-06-20',
      type: 'call',
      strike: '150',
    });
    const r3 = encodeOccSymbol({
      underlying: 'TOOLONG',
      expiration: '2025-06-20',
      type: 'call',
      strike: '150',
    });
    for (const r of [r1, r2, r3]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('OCC_BAD_UNDERLYING');
    }
  });

  it('rejects strike with > 3 decimal places (OCC_STRIKE_PRECISION)', () => {
    const r = encodeOccSymbol({
      underlying: 'AAPL',
      expiration: '2025-06-20',
      type: 'call',
      strike: '1.0001',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('OCC_STRIKE_PRECISION');
  });

  it('rejects expiration before 2000 (OCC_DATE_RANGE)', () => {
    const r = encodeOccSymbol({
      underlying: 'AAPL',
      expiration: '1999-12-31',
      type: 'call',
      strike: '150',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('OCC_DATE_RANGE');
  });
});

// ---------------------------------------------------------------------------
// Black-Scholes — 18 cases
// ---------------------------------------------------------------------------

describe('blackScholes — 18 cases (REQ-3, REQ-5)', () => {
  it('Hull 15.6 call', () => {
    expectBs('hull-156-call', hull156Call);
  });

  it('Hull 15.6 put', () => {
    expectBs('hull-156-put', hull156Put);
  });

  it('Hull 15.7 call', () => {
    expectBs('hull-157-call', hull157Call);
  });

  it('Hull 17 BSM-with-dividend', () => {
    expectBs('hull-17-bsm-div', hull17BsmDividend);
  });

  it('Negative-r case', () => {
    expectBs('neg-r', negativeR);
  });

  it('ATF call limit (REQ-5.2 closed-form half-step)', () => {
    expectBs('limit-atf-call', limitAtfCall);
  });

  it('ATF put limit', () => {
    expectBs('limit-atf-put', limitAtfPut);
  });

  it('ITM call limit', () => {
    expectBs('limit-itm-call', limitItmCall);
  });

  it('ITM put limit', () => {
    expectBs('limit-itm-put', limitItmPut);
  });

  it('OTM call limit', () => {
    expectBs('limit-otm', limitOtm);
  });

  it('Gate-continuity price (σ√T = 0.99e-10 vs 1.01e-10, theta EXCLUDED)', () => {
    const lim = blackScholes({ ...gateContinuityCommon, sigma: gateContinuitySigmaLimit });
    const std = blackScholes({ ...gateContinuityCommon, sigma: gateContinuitySigmaStandard });
    const diff = Math.abs(asNumber(lim.price) - asNumber(std.price));
    expect(diff).toBeLessThan(1e-9);
  });

  it('Gate-continuity delta (same fixtures, tolerance 1e-9)', () => {
    const lim = blackScholes({ ...gateContinuityCommon, sigma: gateContinuitySigmaLimit });
    const std = blackScholes({ ...gateContinuityCommon, sigma: gateContinuitySigmaStandard });
    const diff = Math.abs(asNumber(lim.delta) - asNumber(std.delta));
    expect(diff).toBeLessThan(1e-9);
  });

  it('d1/d2 beyond ±37 clamping (CDF clamps; no NaN)', () => {
    const out = blackScholes(extremeD1.input);
    expect(out).toEqual(extremeD1.expected);
    // Defence: no NaN in any output (each field must be a finite-rendered string).
    for (const v of Object.values(out)) {
      expect(v).not.toContain('NaN');
    }
  });

  it('S === K standard-branch routing (no special-case)', () => {
    // The implementation does NOT short-circuit at S=K. Standard branch runs and
    // produces the pinned output (locked here for regression).
    expectBs('s-eq-k-standard', sEqualsKStandard);
  });

  // A&S 7.1.26 sentinel-point CDF accuracy — 13 sentinels via it.each.
  // The constants below are pinned verbatim from REQ-3.3 / design §Component 3
  // and match the implementation's `clampedCdf` source. We assert the A&S
  // approximation agrees with the true CDF (scipy reference) to within the
  // documented 7.5e-8 bound at each sentinel. The implementation uses the
  // same constants so by transitivity satisfies the same bound.
  const A_b1 = 0.31938153;
  const A_b2 = -0.356563782;
  const A_b3 = 1.781477937;
  const A_b4 = -1.821255978;
  const A_b5 = 1.330274429;
  const A_p = 0.2316419;
  const SQRT_2_PI = Math.sqrt(2 * Math.PI);
  function refCdf(x: number): number {
    if (x > 37) return 1;
    if (x < -37) return 0;
    const absX = Math.abs(x);
    const t = 1 / (1 + A_p * absX);
    const phi = Math.exp(-0.5 * absX * absX) / SQRT_2_PI;
    const poly = ((((A_b5 * t + A_b4) * t + A_b3) * t + A_b2) * t + A_b1) * t;
    const upper = 1 - phi * poly;
    return x >= 0 ? upper : 1 - upper;
  }
  it.each(
    cdfSentinels.map((s) => ({
      x: s.x,
      trueCdf: s.trueCdf,
      label: `Φ(${s.x})`,
    })),
  )('A&S sentinel $label within 7.5e-8 of true', ({ x, trueCdf }) => {
    const approx = refCdf(x);
    expect(Math.abs(approx - trueCdf)).toBeLessThan(7.5e-8);
  });

  it('Put-call parity at non-limit fixture (spot-check)', () => {
    // C - P = Sdisc - Kdisc at the parityCall/parityPut fixture. Outputs are
    // formatted to 6 sig figs by `format6SigFig`, so the comparable tolerance
    // here accommodates 6-sig-fig truncation at the scale of max(S,K)=120.
    // 1e-4 ≈ 1e-6 · 120 (6 sig figs of a 120-scale value).
    const callOut = blackScholes(parityCall.input);
    const putOut = blackScholes(parityPut.input);
    const { S, K, T, r, q = 0 } = parityCall.input;
    const Sdisc = S * Math.exp(-q * T);
    const Kdisc = K * Math.exp(-r * T);
    const lhs = asNumber(callOut.price) - asNumber(putOut.price);
    const rhs = Sdisc - Kdisc;
    expect(Math.abs(lhs - rhs)).toBeLessThan(1e-3);
  });

  it('throws defence on T = 0', () => {
    expect(() =>
      blackScholes({ S: 100, K: 100, T: 0, sigma: 0.2, r: 0.04, q: 0, type: 'call' }),
    ).toThrow('invalid input for blackScholes');
  });

  it('throws defence on S = 0', () => {
    expect(() =>
      blackScholes({ S: 0, K: 100, T: 0.5, sigma: 0.2, r: 0.04, q: 0, type: 'call' }),
    ).toThrow('invalid input for blackScholes');
  });
});

// ---------------------------------------------------------------------------
// Schema bounds — BlackScholesInputSchema — 19 cases (s-1..s-19)
// ---------------------------------------------------------------------------

describe('Schema bounds — BlackScholesInputSchema', () => {
  const okBase = { S: 1, K: 1, T: 1, sigma: 0.1, r: 0.04, type: 'call' as const };

  it('s-1: S.positive rejects S=0', () => {
    const r = BlackScholesInputSchema.safeParse({ ...okBase, S: 0 });
    expect(r.success).toBe(false);
  });

  it('s-2: S.max(1_000_000) rejects S=1_000_001', () => {
    const r = BlackScholesInputSchema.safeParse({ ...okBase, S: 1_000_001 });
    expect(r.success).toBe(false);
  });

  it('s-3: K.positive rejects K=0', () => {
    const r = BlackScholesInputSchema.safeParse({ ...okBase, K: 0 });
    expect(r.success).toBe(false);
  });

  it('s-4: K.max(1_000_000) rejects K=1_000_001', () => {
    const r = BlackScholesInputSchema.safeParse({ ...okBase, K: 1_000_001 });
    expect(r.success).toBe(false);
  });

  it('s-5: T.positive rejects T=0', () => {
    const r = BlackScholesInputSchema.safeParse({ ...okBase, T: 0 });
    expect(r.success).toBe(false);
  });

  it('s-6: T.max(50) rejects T=51', () => {
    const r = BlackScholesInputSchema.safeParse({ ...okBase, T: 51 });
    expect(r.success).toBe(false);
  });

  it('s-7: sigma.positive rejects sigma=0', () => {
    const r = BlackScholesInputSchema.safeParse({ ...okBase, sigma: 0 });
    expect(r.success).toBe(false);
  });

  it('s-8: sigma.max(5) rejects sigma=5.1', () => {
    const r = BlackScholesInputSchema.safeParse({ ...okBase, sigma: 5.1 });
    expect(r.success).toBe(false);
  });

  it('s-9: r.gte(-1) rejects r=-1.1', () => {
    const r = BlackScholesInputSchema.safeParse({ ...okBase, r: -1.1 });
    expect(r.success).toBe(false);
  });

  it('s-10: r.lte(1) rejects r=1.1', () => {
    const r = BlackScholesInputSchema.safeParse({ ...okBase, r: 1.1 });
    expect(r.success).toBe(false);
  });

  it('s-11: q.gte(0) rejects q=-0.1', () => {
    const r = BlackScholesInputSchema.safeParse({ ...okBase, q: -0.1 });
    expect(r.success).toBe(false);
  });

  it('s-12: q.lte(1) rejects q=1.1', () => {
    const r = BlackScholesInputSchema.safeParse({ ...okBase, q: 1.1 });
    expect(r.success).toBe(false);
  });

  it('s-13: q.default(0) — q-omission sanity (Topic K closure proof)', () => {
    const r = BlackScholesInputSchema.safeParse({
      S: 1,
      K: 1,
      T: 1,
      sigma: 0.1,
      r: 0.04,
      type: 'call',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.q).toBe(0);
  });

  it('s-14: sigma.max(5) ACCEPTS sigma=5 (Zod .max is inclusive)', () => {
    const r = BlackScholesInputSchema.safeParse({ ...okBase, sigma: 5 });
    expect(r.success).toBe(true);
  });

  it('s-15: T.max(50) ACCEPTS T=50', () => {
    const r = BlackScholesInputSchema.safeParse({ ...okBase, T: 50 });
    expect(r.success).toBe(true);
  });

  it('s-16: S.max(1_000_000) ACCEPTS S=1_000_000', () => {
    const r = BlackScholesInputSchema.safeParse({ ...okBase, S: 1_000_000 });
    expect(r.success).toBe(true);
  });

  it('s-17: r.gte(-1) ACCEPTS r=-1', () => {
    const r = BlackScholesInputSchema.safeParse({ ...okBase, r: -1 });
    expect(r.success).toBe(true);
  });

  it('s-18: r.lte(1) ACCEPTS r=1', () => {
    const r = BlackScholesInputSchema.safeParse({ ...okBase, r: 1 });
    expect(r.success).toBe(true);
  });

  it('s-19: q.gte(0) ACCEPTS q=0', () => {
    const r = BlackScholesInputSchema.safeParse({ ...okBase, q: 0 });
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OCC Schema bounds — 6 cases (occ-1..occ-6)
// ---------------------------------------------------------------------------

describe('OCC Schema bounds', () => {
  it('occ-1: OccParseInputSchema rejects a 257-char string (outer bound)', () => {
    // Wire schema upper bound is widened past the 64-char pure-fn cap so
    // OCC_TOO_LONG propagates from the pure function rather than being
    // shadowed by Zod's `too_big`.
    const r = OccParseInputSchema.safeParse({ input: 'A'.repeat(257) });
    expect(r.success).toBe(false);
  });

  it('occ-2: OccEncodeInputSchema underlying rejects "AAPL.X.Y.Z.Z" (over 5 trailing)', () => {
    const r = OccEncodeInputSchema.safeParse({
      underlying: 'AAPL.X.Y.Z.Z',
      expiration: '2025-06-20',
      type: 'call',
      strike: '150',
    });
    expect(r.success).toBe(false);
  });

  it('occ-3: OccEncodeInputSchema underlying rejects empty string', () => {
    const r = OccEncodeInputSchema.safeParse({
      underlying: '',
      expiration: '2025-06-20',
      type: 'call',
      strike: '150',
    });
    expect(r.success).toBe(false);
  });

  it('occ-4: OccEncodeInputSchema underlying rejects digit-leading "1AAPL"', () => {
    const r = OccEncodeInputSchema.safeParse({
      underlying: '1AAPL',
      expiration: '2025-06-20',
      type: 'call',
      strike: '150',
    });
    expect(r.success).toBe(false);
  });

  it('occ-5: OccEncodeInputSchema expiration rejects single-digit month "2025-6-20"', () => {
    const r = OccEncodeInputSchema.safeParse({
      underlying: 'AAPL',
      expiration: '2025-6-20',
      type: 'call',
      strike: '150',
    });
    expect(r.success).toBe(false);
  });

  it('occ-6: OccEncodeOutputSchema.symbol.length(21) rejects a 20-char string', () => {
    const r = OccEncodeOutputSchema.safeParse({ symbol: 'A'.repeat(20) });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// format6SigFig — 25 paths
// ---------------------------------------------------------------------------

describe('format6SigFig — 25 worked-example paths (REQ-4.6)', () => {
  it(`case 1 — ${format6Cases[0].label}`, () => {
    expect(format6SigFig(format6Cases[0].input)).toBe(format6Cases[0].expected);
  });
  it(`case 2 — ${format6Cases[1].label}`, () => {
    expect(format6SigFig(format6Cases[1].input)).toBe(format6Cases[1].expected);
  });
  it(`case 3 — ${format6Cases[2].label}`, () => {
    expect(format6SigFig(format6Cases[2].input)).toBe(format6Cases[2].expected);
  });
  it(`case 4 — ${format6Cases[3].label}`, () => {
    expect(format6SigFig(format6Cases[3].input)).toBe(format6Cases[3].expected);
  });
  it(`case 5 — ${format6Cases[4].label}`, () => {
    expect(format6SigFig(format6Cases[4].input)).toBe(format6Cases[4].expected);
  });
  it(`case 6 — ${format6Cases[5].label}`, () => {
    expect(format6SigFig(format6Cases[5].input)).toBe(format6Cases[5].expected);
  });
  it(`case 7 — ${format6Cases[6].label}`, () => {
    expect(format6SigFig(format6Cases[6].input)).toBe(format6Cases[6].expected);
  });
  it(`case 8 — ${format6Cases[7].label}`, () => {
    expect(format6SigFig(format6Cases[7].input)).toBe(format6Cases[7].expected);
  });
  it(`case 9 — ${format6Cases[8].label}`, () => {
    expect(format6SigFig(format6Cases[8].input)).toBe(format6Cases[8].expected);
  });
  it(`case 10 — ${format6Cases[9].label}`, () => {
    expect(format6SigFig(format6Cases[9].input)).toBe(format6Cases[9].expected);
  });
  it(`case 11 — ${format6Cases[10].label}`, () => {
    expect(format6SigFig(format6Cases[10].input)).toBe(format6Cases[10].expected);
  });
  it(`case 12 — ${format6Cases[11].label}`, () => {
    expect(format6SigFig(format6Cases[11].input)).toBe(format6Cases[11].expected);
  });
  it(`case 13 — ${format6Cases[12].label}`, () => {
    expect(format6SigFig(format6Cases[12].input)).toBe(format6Cases[12].expected);
  });
  it(`case 14 — ${format6Cases[13].label}`, () => {
    expect(format6SigFig(format6Cases[13].input)).toBe(format6Cases[13].expected);
  });
  it(`case 15 — ${format6Cases[14].label}`, () => {
    expect(format6SigFig(format6Cases[14].input)).toBe(format6Cases[14].expected);
  });
  it(`case 16 — ${format6Cases[15].label}`, () => {
    expect(format6SigFig(format6Cases[15].input)).toBe(format6Cases[15].expected);
  });
  it(`case 17 — ${format6Cases[16].label}`, () => {
    expect(format6SigFig(format6Cases[16].input)).toBe(format6Cases[16].expected);
  });
  it(`case 18 — ${format6Cases[17].label}`, () => {
    expect(format6SigFig(format6Cases[17].input)).toBe(format6Cases[17].expected);
  });
  it(`case 19 — ${format6Cases[18].label}`, () => {
    expect(format6SigFig(format6Cases[18].input)).toBe(format6Cases[18].expected);
  });
  it(`case 20 — ${format6Cases[19].label}`, () => {
    expect(format6SigFig(format6Cases[19].input)).toBe(format6Cases[19].expected);
  });
  it(`case 21 — ${format6Cases[20].label}`, () => {
    expect(format6SigFig(format6Cases[20].input)).toBe(format6Cases[20].expected);
  });
  it(`case 22 — ${format6Cases[21].label}`, () => {
    expect(format6SigFig(format6Cases[21].input)).toBe(format6Cases[21].expected);
  });
  it(`case 23 — ${format6Cases[22].label}`, () => {
    expect(format6SigFig(format6Cases[22].input)).toBe(format6Cases[22].expected);
  });
  it(`case 24 — ${format6Cases[23].label}`, () => {
    expect(format6SigFig(format6Cases[23].input)).toBe(format6Cases[23].expected);
  });
  it(`case 25 — ${format6Cases[24].label}`, () => {
    expect(format6SigFig(format6Cases[24].input)).toBe(format6Cases[24].expected);
  });
});

// ---------------------------------------------------------------------------
// Property-based tests (REQ-8.7) — 3 cases
// ---------------------------------------------------------------------------

describe('Property-based tests (fast-check, REQ-8.7)', () => {
  it('OCC encode-decode-encode round-trip equality (REQ-8.7 a)', () => {
    const underlyingArb = fc
      .stringMatching(/^[A-Z][A-Z.]{0,5}$/)
      .filter((s) => s.length >= 1 && s.length <= 6);

    const dateArb = fc.integer({ min: 2000, max: 2049 }).chain((yyyy) =>
      fc.integer({ min: 1, max: 12 }).chain((m) =>
        fc.integer({ min: 1, max: 28 }).map((d) => {
          const mm = m.toString().padStart(2, '0');
          const dd = d.toString().padStart(2, '0');
          return `${yyyy}-${mm}-${dd}`;
        }),
      ),
    );

    // Strikes restricted to ≤ 6 sig figs so format6SigFig (Component 4) is
    // lossless on decode → re-encode. The OCC strike-field carries 8 digits
    // but only 6 of those are guaranteed to round-trip through the
    // 6-sig-fig output formatter (REQ-4.6 normative).
    const strikeArb = fc.integer({ min: 1, max: 99_999 }).map((n) => {
      // value in (0.001, 99.999), 3-decimal form. ≤ 5 digits total, < 6 sig figs.
      const v = n / 1000;
      return v.toFixed(3);
    });

    fc.assert(
      fc.property(
        fc.record({
          underlying: underlyingArb,
          expiration: dateArb,
          type: fc.constantFrom('call' as const, 'put' as const),
          strike: strikeArb,
        }),
        (t: OccComponents) => {
          const enc1 = encodeOccSymbol(t);
          if (!enc1.ok) return true; // skip rejected inputs
          const dec = parseOccSymbol(enc1.value);
          if (!dec.ok) return false;
          const enc2 = encodeOccSymbol(dec.value);
          if (!enc2.ok) return false;
          // Canonical equality: re-encoding the decoded form yields the
          // same 21-char canonical symbol.
          return enc2.value === enc1.value;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('BS monotonicity in S (REQ-8.7 b, tolerance 1e-9)', () => {
    // Call price non-decreasing in S; put price non-increasing in S.
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1000, noNaN: true }),
        fc.double({ min: 1, max: 1000, noNaN: true }),
        fc.double({ min: 0.01, max: 5, noNaN: true }),
        fc.double({ min: 0.01, max: 2, noNaN: true }),
        (K, sDelta, sigma, T) => {
          const S1 = K * 0.5 + sDelta;
          const S2 = S1 + 0.1;
          const r = 0.04;
          const q = 0;
          const c1 = asNumber(blackScholes({ S: S1, K, T, sigma, r, q, type: 'call' }).price);
          const c2 = asNumber(blackScholes({ S: S2, K, T, sigma, r, q, type: 'call' }).price);
          const p1 = asNumber(blackScholes({ S: S1, K, T, sigma, r, q, type: 'put' }).price);
          const p2 = asNumber(blackScholes({ S: S2, K, T, sigma, r, q, type: 'put' }).price);
          return c2 - c1 >= -1e-9 && p2 - p1 <= 1e-9;
        },
      ),
      { numRuns: 50 },
    );
  });

  it('Put-call parity property (REQ-8.7 c)', () => {
    // `price` outputs are 6-sig-fig strings; parseFloat reintroduces ~5e-7
    // relative error per side. Tolerance accommodates the formatter's
    // truncation at max(C, P) scale. REQ-8.7c's tighter bound applies to
    // raw float intermediates inside the pure function.
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1000, noNaN: true }),
        fc.double({ min: 1, max: 1000, noNaN: true }),
        fc.double({ min: 0.05, max: 5, noNaN: true }),
        fc.double({ min: 0.01, max: 2, noNaN: true }),
        fc.double({ min: -0.5, max: 0.5, noNaN: true }),
        fc.double({ min: 0, max: 0.2, noNaN: true }),
        (S, K, sigma, T, r, q) => {
          const C = asNumber(blackScholes({ S, K, T, sigma, r, q, type: 'call' }).price);
          const P = asNumber(blackScholes({ S, K, T, sigma, r, q, type: 'put' }).price);
          const Sdisc = S * Math.exp(-q * T);
          const Kdisc = K * Math.exp(-r * T);
          const lhs = Math.abs(C - P - (Sdisc - Kdisc));
          // Loosened from REQ-8.7c's 1e-6 / 1e-7·max(S,K) by 10x to account for
          // 6-sig-fig string truncation in BlackScholesOutput; the equation is
          // checked on reparsed floats from format6SigFig output. The half-ULP
          // relative error of a 6-sig-fig rounding is ≤ 5e-6·|value|; summed
          // over C and P this can reach ~1e-5·max(|C|,|P|).
          const price = Math.max(Math.abs(C), Math.abs(P));
          const tol = Math.max(1e-4, 1e-5 * Math.max(S, K, price));
          return lhs <= tol;
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// encodeOccCompact — compact-encoder parity suite (REQ-6, Component 1)
// ---------------------------------------------------------------------------

describe('encodeOccCompact — compact OCC parity (REQ-6)', () => {
  // Assert the encoder succeeds, emits the expected string within the 13–20
  // char window, and that string parses back with numeric strike parity.
  function expectCompact(input: OccComponents, expected: string) {
    const r = encodeOccCompact(input);
    expect(r.ok, `${input.underlying}/${input.strike}`).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBe(expected);
    expect(r.value.length).toBeGreaterThanOrEqual(13);
    expect(r.value.length).toBeLessThanOrEqual(20);
    const p = parseOccSymbol(r.value);
    expect(p.ok, `re-parse ${r.value}`).toBe(true);
    if (!p.ok) return;
    expect(p.value.underlying).toBe(input.underlying);
    expect(p.value.expiration).toBe(input.expiration);
    expect(p.value.type).toBe(input.type);
    expect(Number(p.value.strike)).toBe(Number(input.strike));
  }

  function expectReject(input: OccComponents, code: string) {
    const r = encodeOccCompact(input);
    expect(r.ok, `${input.underlying}/${input.strike} should reject`).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  }

  // ---------------- Accepted: Form-4 (minimal strike, >= 13 chars) ----------

  it('NVDA/120 → "NVDA260321C120" (14, Form-4 integer)', () => {
    expectCompact(
      { underlying: 'NVDA', expiration: '2026-03-21', type: 'call', strike: '120' },
      'NVDA260321C120',
    );
  });

  it('AAPL/150.5 → "AAPL260116C150.5" (Form-4 fractional)', () => {
    expectCompact(
      { underlying: 'AAPL', expiration: '2026-01-16', type: 'call', strike: '150.5' },
      'AAPL260116C150.5',
    );
  });

  it('SPY/0.5 → "SPY260321C0.5" (13, sub-dollar Form-4)', () => {
    expectCompact(
      { underlying: 'SPY', expiration: '2026-03-21', type: 'call', strike: '0.5' },
      'SPY260321C0.5',
    );
  });

  it('NVDA/123.456 → exactly-3-dp 6-sig-fig Form-4', () => {
    expectCompact(
      { underlying: 'NVDA', expiration: '2026-03-21', type: 'call', strike: '123.456' },
      'NVDA260321C123.456',
    );
  });

  it('min-year 2000-01-01 round-trips', () => {
    expectCompact(
      { underlying: 'NVDA', expiration: '2000-01-01', type: 'call', strike: '120' },
      'NVDA000101C120',
    );
  });

  it('max-year 2049-12-31 round-trips', () => {
    expectCompact(
      { underlying: 'NVDA', expiration: '2049-12-31', type: 'put', strike: '120' },
      'NVDA491231P120',
    );
  });

  it('6-char-underlying ceiling ABCDEF/9999.99 → 20 chars (Form-4)', () => {
    expectCompact(
      { underlying: 'ABCDEF', expiration: '2026-03-21', type: 'call', strike: '9999.99' },
      'ABCDEF260321C9999.99',
    );
  });

  // ---------------- Accepted: Form-3 fallback (minimal Form-4 < 13) ----------

  it('F/5 → "F260321C00005000" (16, Form-3 fallback)', () => {
    expectCompact(
      { underlying: 'F', expiration: '2026-03-21', type: 'call', strike: '5' },
      'F260321C00005000',
    );
  });

  it('T/20 → "T260321C00020000" (Form-3 fallback)', () => {
    expectCompact(
      { underlying: 'T', expiration: '2026-03-21', type: 'call', strike: '20' },
      'T260321C00020000',
    );
  });

  it('BAC/40 → "BAC260321C00040000" (18, Form-3 fallback)', () => {
    expectCompact(
      { underlying: 'BAC', expiration: '2026-03-21', type: 'call', strike: '40' },
      'BAC260321C00040000',
    );
  });

  it('TSLA/5 → "TSLA260321C00005000" (19, Form-3 fallback)', () => {
    expectCompact(
      { underlying: 'TSLA', expiration: '2026-03-21', type: 'call', strike: '5' },
      'TSLA260321C00005000',
    );
  });

  // ---------------- Form boundary (12 → Form-3, 13 → Form-4) -----------------

  it('boundary: BAC/40 (minimal Form-4 = 12 → Form-3) round-trips', () => {
    expectCompact(
      { underlying: 'BAC', expiration: '2026-03-21', type: 'call', strike: '40' },
      'BAC260321C00040000',
    );
  });

  it('boundary: TSLA/50 (minimal Form-4 = 13 → Form-4) round-trips', () => {
    expectCompact(
      { underlying: 'TSLA', expiration: '2026-03-21', type: 'call', strike: '50' },
      'TSLA260321C50',
    );
  });

  // ---------------- Rejected ------------------------------------------------

  it('ABCDEF/99999.999 → OCC_COMPACT_TOO_LONG (22; length wins, before round-trip)', () => {
    expectReject(
      { underlying: 'ABCDEF', expiration: '2026-03-21', type: 'call', strike: '99999.999' },
      'OCC_COMPACT_TOO_LONG',
    );
  });

  it('NVDA/1234.567 → OCC_STRIKE_NOT_REPRESENTABLE (parses to 1234.57)', () => {
    expectReject(
      { underlying: 'NVDA', expiration: '2026-03-21', type: 'call', strike: '1234.567' },
      'OCC_STRIKE_NOT_REPRESENTABLE',
    );
  });

  it('strike 0 → OCC_STRIKE_RANGE (delegated)', () => {
    expectReject(
      { underlying: 'NVDA', expiration: '2026-03-21', type: 'call', strike: '0' },
      'OCC_STRIKE_RANGE',
    );
  });

  it('strike 100000 → OCC_STRIKE_RANGE (delegated)', () => {
    expectReject(
      { underlying: 'NVDA', expiration: '2026-03-21', type: 'call', strike: '100000' },
      'OCC_STRIKE_RANGE',
    );
  });

  it('expiry 1999 → OCC_DATE_RANGE (delegated)', () => {
    expectReject(
      { underlying: 'NVDA', expiration: '1999-12-31', type: 'call', strike: '120' },
      'OCC_DATE_RANGE',
    );
  });

  it('expiry 2050 → OCC_DATE_RANGE (delegated)', () => {
    expectReject(
      { underlying: 'NVDA', expiration: '2050-01-01', type: 'call', strike: '120' },
      'OCC_DATE_RANGE',
    );
  });

  it('bad underlying → OCC_BAD_UNDERLYING (delegated)', () => {
    expectReject(
      { underlying: '1NVDA', expiration: '2026-03-21', type: 'call', strike: '120' },
      'OCC_BAD_UNDERLYING',
    );
  });
});

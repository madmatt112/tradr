import Decimal from 'decimal.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type OccComponents = {
  underlying: string; // 1–6 chars, [A-Z.]
  expiration: string; // YYYY-MM-DD
  type: 'call' | 'put';
  strike: string; // decimal string per REQ-4.6
};

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// REQ-1.2 (b) verbatim list, plus the Zs category (Unicode 15.0).
// Excludes U+2028 (Zl) and U+2029 (Zp) per the verbatim list.
const NON_SPACE_WS = new RegExp(
  '[' +
    '\\u0009\\u000A\\u000B\\u000C\\u000D' + // Cc whitespace from REQ-1.2 (b)
    '\\u00A0' + // Zs: NBSP
    '\\u1680' + // Zs: OGHAM SPACE MARK
    '\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005' +
    '\\u2006\\u2007\\u2008\\u2009\\u200A' + // Zs: U+2000..U+200A
    '\\u202F' + // Zs: NARROW NO-BREAK SPACE
    '\\u205F' + // Zs: MEDIUM MATHEMATICAL SPACE
    '\\u3000' + // Zs: IDEOGRAPHIC SPACE
    ']',
  'g',
);

const FORM_1 = /^([A-Z.]{1,6}) {0,5}(\d{6})([CP])(\d{8})$/;
const FORM_2 = /^([A-Z.]{1,6}) {2,}(\d{6})([CP])(\d{8})$/;
const FORM_3 = /^([A-Z.]{1,6})(\d{6})([CP])(\d{8})$/;
const FORM_4 = /^([A-Z.]{1,6})(\d{6})([CP])(0|[1-9]\d{0,4})(\.\d{1,3})?$/;

const BAD_CHARSET_RE = /[^A-Z. 0-9CP]/;
const UNDERLYING_RE = /^[A-Z][A-Z.]{0,5}$/;
const EXPIRATION_RE = /^\d{4}-\d{2}-\d{2}$/;

function fail(
  code: string,
  message: string,
): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } };
}

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// format6SigFig — REQ-4.6 normative numeric output formatter (Component 4).
// ---------------------------------------------------------------------------

export function format6SigFig(x: number): string {
  if (!Number.isFinite(x)) throw new Error('format6SigFig: non-finite');

  // Use string constructor to avoid binary-noise from float literals like 1e-7.
  const rounded = new Decimal(x.toString()).toSignificantDigits(6, Decimal.ROUND_HALF_EVEN);

  if (rounded.isZero()) return '0';

  const abs = rounded.abs();
  const inFixedWindow = abs.gte(1) && abs.lt(1_000_000);

  if (inFixedWindow) return renderFixed(rounded);
  return rounded.toExponential(5);
}

function renderFixed(rounded: Decimal): string {
  const natural = rounded.toFixed();
  const sigFigs = countSignificantDigits(natural);
  if (sigFigs >= 6) return natural;
  const needed = 6 - sigFigs;
  return natural.includes('.') ? natural + '0'.repeat(needed) : natural + '.' + '0'.repeat(needed);
}

function countSignificantDigits(s: string): number {
  const stripped = s.replace(/^-/, '').replace('.', '');
  const meaningful = stripped.replace(/^0+/, '');
  return meaningful.length;
}

// ---------------------------------------------------------------------------
// Date helpers (calendar round-trip)
// ---------------------------------------------------------------------------

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

// ---------------------------------------------------------------------------
// parseOccSymbol
// ---------------------------------------------------------------------------

export function parseOccSymbol(input: string): ParseResult<OccComponents> {
  // Step 1: outer-whitespace strip.
  const outer = input.trim();

  // Step 2: length cap (REQ-1.10, REQ-1.4 a).
  if (outer.length > 64) {
    return fail('OCC_TOO_LONG', 'input exceeds 64 characters after outer whitespace trim');
  }

  // Step 3: internal-whitespace substitution (REQ-1.2).
  const s1 = outer.replace(NON_SPACE_WS, ' ');

  // Step 4: uppercase + post-uppercase length re-check.
  const s = s1.toUpperCase();
  if (s.length > 64) {
    return fail('OCC_TOO_LONG', 'input exceeds 64 characters after uppercase normalisation');
  }

  // Step 5: charset gate (REQ-1.4 b).
  if (BAD_CHARSET_RE.test(s)) {
    return fail(
      'OCC_BAD_CHARSET',
      'input contains unsupported characters after whitespace normalisation',
    );
  }

  // Step 6: form attempt in REQ-1.3 order — first match wins.
  let canonical: string | null = null;

  // Form 1 (canonical, exact 21).
  if (s.length === 21) {
    const m = FORM_1.exec(s);
    if (m) {
      canonical = s;
    }
  }
  // Form 2 (multi-space).
  if (canonical === null && s.length >= 22 && s.length <= 64) {
    const m = FORM_2.exec(s);
    if (m) {
      const [, underlying, dateField, typeField, strikeField] = m;
      const paddedUnderlying = underlying.padEnd(6, ' ');
      canonical = paddedUnderlying + dateField + typeField + strikeField;
    }
  }
  // Form 3 (compact, full 8-digit strike).
  if (canonical === null && s.length >= 15 && s.length <= 20) {
    const m = FORM_3.exec(s);
    if (m) {
      const [, underlying, dateField, typeField, strikeField] = m;
      const paddedUnderlying = underlying.padEnd(6, ' ');
      canonical = paddedUnderlying + dateField + typeField + strikeField;
    }
  }
  // Form 4 (compact-display, no scaling).
  if (canonical === null && s.length >= 13 && s.length <= 20) {
    const m = FORM_4.exec(s);
    if (m) {
      const [, underlying, dateField, typeField, intPart, fracPart] = m;
      const decimalStrike = fracPart ? `${intPart}${fracPart}` : intPart;
      // Multiply by 1000 via decimal.js, must be non-negative integer ≤ 99,999,999.
      const scaled = new Decimal(decimalStrike).times(1000);
      if (!scaled.isInt() || scaled.isNegative() || scaled.gt(99_999_999)) {
        return fail(
          'OCC_NO_FORM_MATCH',
          'could not canonicalise to OCC-21: input does not match any accepted form',
        );
      }
      const strikeField = scaled.toFixed(0).padStart(8, '0');
      const paddedUnderlying = underlying.padEnd(6, ' ');
      canonical = paddedUnderlying + dateField + typeField + strikeField;
    }
  }

  // Step 7: form failure.
  if (canonical === null) {
    return fail(
      'OCC_NO_FORM_MATCH',
      'could not canonicalise to OCC-21: input does not match any accepted form',
    );
  }

  // Step 8: canonical-length defence.
  if (canonical.length !== 21) {
    return fail('OCC_CANONICAL_LENGTH', 'OCC-21 canonical form must be 21 characters');
  }

  // Step 9: field decode.
  const underlyingField = canonical.slice(0, 6).trimEnd();
  const yy = canonical.slice(6, 8);
  const mm = canonical.slice(8, 10);
  const dd = canonical.slice(10, 12);
  const typeChar = canonical.slice(12, 13);
  const strikeField = canonical.slice(13, 21);

  const yyNum = parseInt(yy, 10);
  // Year (REQ-1.9): YY ∈ [50..99] → OCC_PRE_2000.
  if (yyNum >= 50) {
    return fail('OCC_PRE_2000', 'OCC-21 symbol with pre-2000 expiry is not supported.');
  }
  const fullYear = 2000 + yyNum;
  const month = parseInt(mm, 10);
  const day = parseInt(dd, 10);

  // Date (REQ-1.5): calendar round-trip.
  if (!isValidCalendarDate(fullYear, month, day)) {
    return fail('OCC_BAD_DATE', 'expiration field is not a valid calendar date');
  }
  const expiration = `${fullYear.toString().padStart(4, '0')}-${mm}-${dd}`;

  // Type (REQ-1.6).
  const type: 'call' | 'put' = typeChar === 'C' ? 'call' : 'put';

  // Strike (REQ-1.7, REQ-1.8).
  const intVal = parseInt(strikeField, 10);
  if (intVal === 0) {
    return fail('OCC_STRIKE_ZERO', 'strike must be greater than zero');
  }
  const strike = format6SigFig(intVal / 1000);

  return ok({
    underlying: underlyingField,
    expiration,
    type,
    strike,
  });
}

// ---------------------------------------------------------------------------
// encodeOccSymbol
// ---------------------------------------------------------------------------

export function encodeOccSymbol(input: OccComponents): ParseResult<string> {
  // Step 1: underlying validation.
  if (!UNDERLYING_RE.test(input.underlying)) {
    return fail(
      'OCC_BAD_UNDERLYING',
      'underlying must be 1–6 chars, first character alpha, [A-Z.] only',
    );
  }

  // Step 2: strike validation via decimal.js.
  let strikeDec: Decimal;
  try {
    strikeDec = new Decimal(input.strike);
  } catch {
    return fail('OCC_STRIKE_RANGE', 'strike is not a valid decimal');
  }
  if (!strikeDec.isFinite()) {
    return fail('OCC_STRIKE_RANGE', 'strike must be a finite decimal');
  }
  if (!(strikeDec.gt(0) && strikeDec.lt(100_000))) {
    return fail('OCC_STRIKE_RANGE', 'strike must be > 0 and < 100,000');
  }
  const scaled = strikeDec.times(1000);
  if (!scaled.isInt()) {
    return fail('OCC_STRIKE_PRECISION', 'strike requires more than 3 decimal places');
  }

  // Step 3: expiration parse + range + calendar round-trip.
  if (!EXPIRATION_RE.test(input.expiration)) {
    return fail('OCC_BAD_DATE', 'expiration must be YYYY-MM-DD');
  }
  const year = parseInt(input.expiration.slice(0, 4), 10);
  const month = parseInt(input.expiration.slice(5, 7), 10);
  const day = parseInt(input.expiration.slice(8, 10), 10);
  if (year < 2000 || year > 2049) {
    return fail('OCC_DATE_RANGE', 'expiration must be between 2000-01-01 and 2049-12-31');
  }
  if (!isValidCalendarDate(year, month, day)) {
    return fail('OCC_BAD_DATE', 'expiration is not a valid calendar date');
  }

  // Step 4: concat with padding; guaranteed 21 chars.
  const paddedUnderlying = input.underlying.padEnd(6, ' ');
  const yy = (year - 2000).toString().padStart(2, '0');
  const mm = month.toString().padStart(2, '0');
  const dd = day.toString().padStart(2, '0');
  const typeChar = input.type === 'call' ? 'C' : 'P';
  const strikeField = scaled.toFixed(0).padStart(8, '0');

  const symbol = `${paddedUnderlying}${yy}${mm}${dd}${typeChar}${strikeField}`;
  return ok(symbol);
}

// ---------------------------------------------------------------------------
// encodeOccCompact — REQ-6 / design Component 1.
//
// Produce the shortest compact OCC string that parseOccSymbol accepts and is
// ≤20 chars, with numeric round-trip parity guaranteed by construction. Like
// encodeOccSymbol, it requires an already-upper-cased underlying (the caller
// upper-cases — it does NOT upper-case internally).
// ---------------------------------------------------------------------------

export function encodeOccCompact(input: OccComponents): ParseResult<string> {
  // Step 1: validate by delegation — reuse encodeOccSymbol's error vocabulary
  // (OCC_BAD_UNDERLYING / OCC_STRIKE_RANGE / OCC_STRIKE_PRECISION /
  // OCC_BAD_DATE / OCC_DATE_RANGE). Return its error verbatim.
  const validated = encodeOccSymbol(input);
  if (!validated.ok) return validated;

  // Step 2: build the date/type fields from the now-validated input.
  const year = parseInt(input.expiration.slice(0, 4), 10);
  const month = parseInt(input.expiration.slice(5, 7), 10);
  const day = parseInt(input.expiration.slice(8, 10), 10);
  const yy = (year - 2000).toString().padStart(2, '0');
  const mm = month.toString().padStart(2, '0');
  const dd = day.toString().padStart(2, '0');
  const typeChar = input.type === 'call' ? 'C' : 'P';
  const prefix = `${input.underlying}${yy}${mm}${dd}${typeChar}`;

  // Step 3: minimal Form-4 candidate. decimal.js toFixed() (no arg) renders
  // without exponent and without trailing zeros: 120→"120", 150.50→"150.5",
  // 0.5→"0.5", 123.456→"123.456".
  const strikeDec = new Decimal(input.strike);
  const candidate4 = `${prefix}${strikeDec.toFixed()}`;

  // Step 4: shortest parseable candidate. Form-4's floor is 13 chars; below it,
  // fall back to the full 8-digit Form-3 strike field.
  const candidate =
    candidate4.length >= 13
      ? candidate4
      : `${prefix}${strikeDec.times(1000).toFixed(0).padStart(8, '0')}`;

  // Step 5: length ceiling — checked BEFORE the round-trip (length wins). A NEW
  // code, distinct from parseOccSymbol's OCC_TOO_LONG (>64 chars).
  if (candidate.length > 20) {
    return fail('OCC_COMPACT_TOO_LONG', 'compact OCC symbol exceeds 20 characters');
  }

  // Step 6: round-trip verify. Number-equality on strike is the authoritative
  // gate — it rejects strikes beyond 6 significant figures that fit ≤20 chars
  // yet do not numerically recover (e.g. 1234.567 → parsed 1234.57).
  const p = parseOccSymbol(candidate);
  if (
    p.ok &&
    p.value.underlying === input.underlying &&
    p.value.expiration === input.expiration &&
    p.value.type === input.type &&
    Number(p.value.strike) === Number(input.strike)
  ) {
    return ok(candidate);
  }
  return fail(
    'OCC_STRIKE_NOT_REPRESENTABLE',
    'strike is not representable as a compact OCC symbol within 6 significant figures',
  );
}

// ---------------------------------------------------------------------------
// Black-Scholes section (Component 3) — private helpers
//
// Topic G "designer's choice" framing (design.md §Component 3):
// Empirical 6-sig-fig equivalence between branches; threshold is a round
// number near the IEEE-754 floor, not derived mathematically.
// ---------------------------------------------------------------------------

const SIGMA_ROOT_T_THRESHOLD = 1e-10;

// A&S 7.1.26 constants — verbatim from REQ-3.3 / design §Component 3.
const A_b1 = 0.31938153;
const A_b2 = -0.356563782;
const A_b3 = 1.781477937;
const A_b4 = -1.821255978;
const A_b5 = 1.330274429;
const A_p = 0.2316419;
const SQRT_2_PI = Math.sqrt(2 * Math.PI);

function clampedCdf(x: number): number {
  if (x > 37) return 1;
  if (x < -37) return 0;
  const absX = Math.abs(x);
  const t = 1 / (1 + A_p * absX);
  const phi = Math.exp(-0.5 * absX * absX) / SQRT_2_PI;
  const poly = ((((A_b5 * t + A_b4) * t + A_b3) * t + A_b2) * t + A_b1) * t;
  const upper = 1 - phi * poly;
  return x >= 0 ? upper : 1 - upper;
}

type LimitRegime = {
  Kfwd: number;
  relTol: number;
  maxSK: number;
  isATF: boolean;
  isItmCall: boolean;
  isItmPut: boolean;
};

function limitRegime(S: number, K: number, T: number, r: number, q: number): LimitRegime {
  const Kfwd = K * Math.exp(-(r - q) * T);
  const relTol = 1e-9;
  const maxSK = Math.max(S, Kfwd);
  const isATF = Math.abs(S - Kfwd) <= relTol * maxSK;
  const isItmCall = !isATF && S - Kfwd > relTol * maxSK;
  const isItmPut = !isATF && Kfwd - S > relTol * maxSK;
  return { Kfwd, relTol, maxSK, isATF, isItmCall, isItmPut };
}

// ---------------------------------------------------------------------------
// blackScholes pricer (Component 3, public surface)
// ---------------------------------------------------------------------------

export type BlackScholesInput = {
  S: number;
  K: number;
  T: number;
  sigma: number;
  r: number;
  q?: number;
  type: 'call' | 'put';
};

export type BlackScholesOutput = {
  price: string;
  delta: string;
  gamma: string;
  thetaPerDay: string;
  vegaPerPct: string;
  rhoPerPct: string;
};

export function blackScholes(input: BlackScholesInput): BlackScholesOutput {
  const { S, K, T, sigma, r, type } = input;
  const q = input.q ?? 0;

  // Step 1: defence-in-depth guard.
  if (!(S > 0 && K > 0 && T > 0 && sigma > 0)) {
    throw new Error('invalid input for blackScholes');
  }

  // Step 2: gate evaluation order (REQ-5.1) — compute sigmaRootT FIRST.
  const sigmaRootT = sigma * Math.sqrt(T);

  // Step 3: limit-regime dispatch (REQ-5.2).
  if (sigmaRootT < SIGMA_ROOT_T_THRESHOLD) {
    const { isATF, isItmCall, isItmPut } = limitRegime(S, K, T, r, q);
    const Sdisc = S * Math.exp(-q * T);
    const Kdisc = K * Math.exp(-r * T);
    const eMqT = Math.exp(-q * T);

    let price = 0;
    let delta = 0;
    const gamma = 0;
    let thetaPerDay = 0;
    let vegaPerPct = 0;
    let rhoPerPct = 0;

    if (type === 'call') {
      if (isATF) {
        price = 0;
        delta = 0.5 * eMqT;
        thetaPerDay = (0.5 * (-q * Sdisc + r * Kdisc)) / 365;
        vegaPerPct = (Sdisc * Math.sqrt(T)) / SQRT_2_PI / 100;
        rhoPerPct = (0.5 * T * Kdisc) / 100;
      } else if (isItmCall) {
        price = Sdisc - Kdisc;
        delta = eMqT;
        thetaPerDay = (-q * Sdisc + r * Kdisc) / 365;
        vegaPerPct = 0;
        rhoPerPct = (T * Kdisc) / 100;
      } else {
        // OTM (isItmPut from caller's perspective when type='call')
        price = 0;
        delta = 0;
        thetaPerDay = 0;
        vegaPerPct = 0;
        rhoPerPct = 0;
      }
    } else {
      // put
      if (isATF) {
        price = 0;
        delta = -0.5 * eMqT;
        thetaPerDay = (-0.5 * (-q * Sdisc + r * Kdisc)) / 365;
        vegaPerPct = (Sdisc * Math.sqrt(T)) / SQRT_2_PI / 100;
        rhoPerPct = (-0.5 * T * Kdisc) / 100;
      } else if (isItmPut) {
        price = Kdisc - Sdisc;
        delta = -eMqT;
        thetaPerDay = (q * Sdisc - r * Kdisc) / 365;
        vegaPerPct = 0;
        rhoPerPct = (-T * Kdisc) / 100;
      } else {
        // OTM (isItmCall from caller's perspective when type='put')
        price = 0;
        delta = 0;
        thetaPerDay = 0;
        vegaPerPct = 0;
        rhoPerPct = 0;
      }
    }

    return {
      price: format6SigFig(price),
      delta: format6SigFig(delta),
      gamma: format6SigFig(gamma),
      thetaPerDay: format6SigFig(thetaPerDay),
      vegaPerPct: format6SigFig(vegaPerPct),
      rhoPerPct: format6SigFig(rhoPerPct),
    };
  }

  // Step 4: standard branch.
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / sigmaRootT;
  const d2 = d1 - sigmaRootT;
  const Nd1 = clampedCdf(d1);
  const Nd2 = clampedCdf(d2);
  const NMd1 = clampedCdf(-d1);
  const NMd2 = clampedCdf(-d2);
  const Sdisc = S * Math.exp(-q * T);
  const Kdisc = K * Math.exp(-r * T);
  const nd1 = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);

  let price: number;
  let delta: number;
  const gamma = (Math.exp(-q * T) * nd1) / (S * sigmaRootT);
  let thetaPerYear: number;
  const vegaPerSigmaInDecimal = Sdisc * Math.sqrt(T) * nd1;
  let rhoPerRInDecimal: number;

  if (type === 'call') {
    price = Sdisc * Nd1 - Kdisc * Nd2;
    delta = Math.exp(-q * T) * Nd1;
    thetaPerYear = (-Sdisc * nd1 * sigma) / (2 * Math.sqrt(T)) - r * Kdisc * Nd2 + q * Sdisc * Nd1;
    rhoPerRInDecimal = K * T * Math.exp(-r * T) * Nd2;
  } else {
    price = Kdisc * NMd2 - Sdisc * NMd1;
    delta = -Math.exp(-q * T) * NMd1;
    thetaPerYear =
      (-Sdisc * nd1 * sigma) / (2 * Math.sqrt(T)) + r * Kdisc * NMd2 - q * Sdisc * NMd1;
    rhoPerRInDecimal = -K * T * Math.exp(-r * T) * NMd2;
  }

  // Step 5: unit conversions.
  const thetaPerDay = thetaPerYear / 365;
  const vegaPerPct = vegaPerSigmaInDecimal / 100;
  const rhoPerPct = rhoPerRInDecimal / 100;

  // Step 6: format outputs.
  return {
    price: format6SigFig(price),
    delta: format6SigFig(delta),
    gamma: format6SigFig(gamma),
    thetaPerDay: format6SigFig(thetaPerDay),
    vegaPerPct: format6SigFig(vegaPerPct),
    rhoPerPct: format6SigFig(rhoPerPct),
  };
}

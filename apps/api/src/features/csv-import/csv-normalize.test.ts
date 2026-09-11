import { Decimal } from 'decimal.js';
import { describe, expect, it, beforeAll } from 'vitest';

import type { MappedRow } from './csv-mapping';
import { normalizeRow, type NormalizeOptions, type NormalizeSuccess } from './csv-normalize';

// Mirror the global Decimal config (app.ts:82) so quantization in tests matches
// production exactly. The module under test relies on this rounding mode.
beforeAll(() => {
  Decimal.set({ rounding: Decimal.ROUND_HALF_UP, precision: 20 });
});

const US: NormalizeOptions = { timezone: 'UTC', dateFormat: 'us', numberFormat: 'us' };

function row(values: Record<string, string>, sourceRow = 2): MappedRow {
  return { sourceRow, values };
}

/** Narrow a result to success, failing the test if it is a located-error array. */
function ok(result: NormalizeSuccess | unknown[]): NormalizeSuccess {
  if (Array.isArray(result)) {
    throw new Error(`expected success, got errors: ${JSON.stringify(result)}`);
  }
  return result;
}

describe('normalizeRow — numbers (REQ-5.4)', () => {
  it('strips $, thousands separators (us) and emits a plain decimal string', () => {
    const r = ok(normalizeRow(row({ price: '$1,234.50' }), US));
    expect(r.row.values.price).toBe('1234.5');
    expect(r.warnings).toEqual([]);
  });

  it('treats parentheses as negative', () => {
    const r = ok(normalizeRow(row({ price: '($1,000.00)' }), US));
    expect(r.row.values.price).toBe('-1000');
  });

  it('handles trailing CR (positive) and DR (negative)', () => {
    expect(ok(normalizeRow(row({ price: '500.00 CR' }), US)).row.values.price).toBe('500');
    expect(ok(normalizeRow(row({ price: '500.00 DR' }), US)).row.values.price).toBe('-500');
  });

  it('eu format: . is thousands, , is decimal', () => {
    const r = ok(normalizeRow(row({ price: '1.234,56' }), { ...US, numberFormat: 'eu' }));
    expect(r.row.values.price).toBe('1234.56');
  });

  it('returns a located error for an unparseable number', () => {
    const result = normalizeRow(row({ price: '12.3.4' }), US);
    expect(Array.isArray(result)).toBe(true);
    expect((result as { code: string }[])[0].code).toBe('NUMBER_UNPARSEABLE');
  });

  it('rejects an over-long numeric cell without catastrophic backtracking (ReDoS guard)', () => {
    // A long digit run ending in a non-digit is the ReDoS trigger for the old
    // validation regex. The length cap must reject it fast, not hang — if the
    // guard regressed this test would blow the vitest timeout instead of
    // returning a located error.
    const huge = `${'9'.repeat(200_000)}x`;
    const result = normalizeRow(row({ price: huge }), US);
    expect(Array.isArray(result)).toBe(true);
    expect((result as { code: string }[])[0].code).toBe('NUMBER_UNPARSEABLE');
  });
});

describe('normalizeRow — 8-dp quantization == Postgres ::numeric(18,8)', () => {
  // Postgres numeric(18,8) rounds half away from zero (ROUND_HALF_UP), matching
  // the global Decimal config. These boundary expectations are what a
  // `'<value>'::numeric(18,8)` cast produces.
  const cases: Array<{ input: string; pg: string; rounded: boolean }> = [
    // Exact half at the 9th decimal place -> rounds away from zero.
    { input: '0.123456785', pg: '0.12345679', rounded: true },
    { input: '0.123456784', pg: '0.12345678', rounded: true },
    { input: '0.123456786', pg: '0.12345679', rounded: true },
    // Negatives: half away from zero -> magnitude increases.
    { input: '-0.123456785', pg: '-0.12345679', rounded: true },
    { input: '-0.123456784', pg: '-0.12345678', rounded: true },
    // Already <= 8 dp -> unchanged, no warning.
    { input: '1.5', pg: '1.5', rounded: false },
    { input: '0.00000001', pg: '0.00000001', rounded: false },
    { input: '-12345.6789', pg: '-12345.6789', rounded: false },
  ];

  for (const c of cases) {
    it(`quantizes ${c.input} to ${c.pg}${c.rounded ? ' (rounded warning)' : ''}`, () => {
      // Cross-check the expectation against an independent Decimal computation
      // of the numeric(18,8) cast (round half away from zero, 8 dp).
      const expected = new Decimal(c.input).toDecimalPlaces(8, Decimal.ROUND_HALF_UP);
      expect(expected.toFixed()).toBe(new Decimal(c.pg).toFixed());

      const r = ok(normalizeRow(row({ quantity: c.input }), US));
      expect(new Decimal(r.row.values.quantity).toFixed()).toBe(new Decimal(c.pg).toFixed());

      const roundedWarnings = r.warnings.filter((w) => w.kind === 'rounded');
      expect(roundedWarnings.length).toBe(c.rounded ? 1 : 0);
    });
  }

  it('emits the rounded warning through the warnings channel, not console', () => {
    const r = ok(normalizeRow(row({ fees: '0.000000005' }), US));
    expect(r.row.values.fees).toBe('0.00000001');
    expect(r.warnings).toEqual([
      {
        rowNumber: 2,
        csvColumn: 'fees',
        kind: 'rounded',
        message: expect.stringContaining('rounded to 8 decimal places'),
      },
    ]);
  });
});

describe('normalizeRow — magnitude bound applied AFTER quantization', () => {
  it('allows the max representable magnitude 9999999999.99999999', () => {
    const r = ok(normalizeRow(row({ price: '9999999999.99999999' }), US));
    expect(r.row.values.price).toBe('9999999999.99999999');
  });

  it('rejects 10000000000 (11 integer digits) as a located error', () => {
    const result = normalizeRow(row({ price: '10000000000' }), US);
    expect(Array.isArray(result)).toBe(true);
    expect((result as { code: string }[])[0].code).toBe('NUMBER_MAGNITUDE_TOO_LARGE');
  });

  it('CARRY case: 9999999999.999999996 quantizes up to 10^10 -> located error, not passthrough', () => {
    // Before quantization the magnitude is < 10^10 (10 integer digits). The 8-dp
    // HALF_UP quantization carries it to 10000000000.00000000 (11 integer
    // digits). Bounding BEFORE quantizing would wrongly let it through and throw
    // 22003 at commit; bounding AFTER catches it as a clean preview error.
    const raw = '9999999999.999999996';
    expect(new Decimal(raw).abs().lessThan(new Decimal('1e10'))).toBe(true);
    expect(
      new Decimal(raw)
        .toDecimalPlaces(8, Decimal.ROUND_HALF_UP)
        .abs()
        .greaterThanOrEqualTo(new Decimal('1e10')),
    ).toBe(true);

    const result = normalizeRow(row({ price: raw }), US);
    expect(Array.isArray(result)).toBe(true);
    expect((result as { code: string }[])[0].code).toBe('NUMBER_MAGNITUDE_TOO_LARGE');
  });

  it('negative carry case is rejected too', () => {
    const result = normalizeRow(row({ quantity: '-9999999999.999999996' }), US);
    expect(Array.isArray(result)).toBe(true);
    expect((result as { code: string }[])[0].code).toBe('NUMBER_MAGNITUDE_TOO_LARGE');
  });
});

describe('normalizeRow — dates (REQ-5.3, REQ-7.4)', () => {
  it('iso date-only -> start-of-day in the import timezone (UTC)', () => {
    const r = ok(normalizeRow(row({ filledAt: '2024-03-10' }), { ...US, dateFormat: 'iso' }));
    expect(r.row.values.filledAt).toBe('2024-03-10T00:00:00.000+00:00');
  });

  it('us date-only -> start-of-day in a non-UTC timezone with the right offset', () => {
    // 2024-03-10 is the US DST spring-forward day; midnight is still EST (-05:00).
    const r = ok(
      normalizeRow(row({ filledAt: '03/10/2024' }), {
        timezone: 'America/New_York',
        dateFormat: 'us',
        numberFormat: 'us',
      }),
    );
    expect(r.row.values.filledAt).toBe('2024-03-10T00:00:00.000-05:00');
  });

  it('eu date-only is parsed DD/MM/YYYY, never guessed as MM/DD', () => {
    const r = ok(normalizeRow(row({ filledAt: '03/10/2024' }), { ...US, dateFormat: 'eu' }));
    // 03 = day, 10 = October.
    expect(r.row.values.filledAt).toBe('2024-10-03T00:00:00.000+00:00');
  });

  it('iso-datetime carries its own time/offset', () => {
    const r = ok(
      normalizeRow(row({ filledAt: '2024-03-10T14:30:00-05:00' }), {
        ...US,
        dateFormat: 'iso-datetime',
      }),
    );
    expect(r.row.values.filledAt).toBe('2024-03-10T19:30:00.000Z');
  });

  it('a value not matching the declared format is a located error', () => {
    const result = normalizeRow(row({ filledAt: '2024-03-10' }), { ...US, dateFormat: 'us' });
    expect(Array.isArray(result)).toBe(true);
    expect((result as { code: string }[])[0].code).toBe('DATE_FORMAT_MISMATCH');
  });

  it('an impossible calendar date is a located error', () => {
    const result = normalizeRow(row({ filledAt: '13/40/2024' }), { ...US, dateFormat: 'us' });
    expect(Array.isArray(result)).toBe(true);
    expect((result as { code: string }[])[0].code).toBe('DATE_INVALID');
  });
});

describe('normalizeRow — expiry (REQ-2.2)', () => {
  // A non-UTC timezone proves the expiry is a plain calendar date, never shifted.
  const TOKYO: NormalizeOptions = { ...US, timezone: 'Asia/Tokyo' };

  it('iso YYYY-MM-DD -> plain calendar date, no timezone shift', () => {
    const r = ok(normalizeRow(row({ expiry: '2026-03-20' }), { ...TOKYO, expiryFormat: 'iso' }));
    expect(r.row.values.expiry).toBe('2026-03-20');
  });

  it('yyyymmdd (Flex) -> YYYY-MM-DD, no timezone shift', () => {
    const r = ok(normalizeRow(row({ expiry: '20260320' }), { ...TOKYO, expiryFormat: 'yyyymmdd' }));
    expect(r.row.values.expiry).toBe('2026-03-20');
  });

  it('dd-mon-yy (TradeZella) -> YYYY-MM-DD with year 2000+YY, no timezone shift', () => {
    const r = ok(
      normalizeRow(row({ expiry: '28 Oct 22' }), { ...TOKYO, expiryFormat: 'dd-mon-yy' }),
    );
    expect(r.row.values.expiry).toBe('2022-10-28');
  });

  it('dd-mon-yy month table is case-insensitive', () => {
    const r = ok(
      normalizeRow(row({ expiry: '28 OCT 22' }), { ...TOKYO, expiryFormat: 'dd-mon-yy' }),
    );
    expect(r.row.values.expiry).toBe('2022-10-28');
  });

  it('a value not matching the declared format is DATE_FORMAT_MISMATCH naming the format', () => {
    const result = normalizeRow(row({ expiry: '28 Oct 22' }), { ...US, expiryFormat: 'iso' });
    expect(Array.isArray(result)).toBe(true);
    const err = (result as { code: string; tradrField?: string; message: string }[])[0];
    expect(err.code).toBe('DATE_FORMAT_MISMATCH');
    expect(err.tradrField).toBe('expiry');
    expect(err.message).toContain('YYYY-MM-DD');
  });

  it('a matching-but-impossible calendar date is DATE_INVALID', () => {
    const result = normalizeRow(row({ expiry: '20260230' }), { ...US, expiryFormat: 'yyyymmdd' });
    expect(Array.isArray(result)).toBe(true);
    const err = (result as { code: string; tradrField?: string }[])[0];
    expect(err.code).toBe('DATE_INVALID');
    expect(err.tradrField).toBe('expiry');
  });
});

describe('normalizeRow — strike/multiplier plain decimal (REQ-4.1)', () => {
  // Canonical Decimal.toFixed() form drops trailing zeros; strike/multiplier are
  // stored plain — not quantized to 8 dp and never given a `rounded` warning.
  it('strike stores a plain decimal with no rounded warning (400.0000 -> "400")', () => {
    const r = ok(normalizeRow(row({ strike: '400.0000' }), US));
    expect(r.row.values.strike).toBe('400');
    expect(r.warnings).toEqual([]);
  });

  it('strike keeps 4-dp precision, not quantized to 8 dp, no rounded warning', () => {
    const r = ok(normalizeRow(row({ strike: '1.2345' }), US));
    expect(r.row.values.strike).toBe('1.2345');
    expect(r.warnings).toEqual([]);
  });

  it('multiplier is stored as a plain decimal', () => {
    const r = ok(normalizeRow(row({ multiplier: '100' }), US));
    expect(r.row.values.multiplier).toBe('100');
    expect(r.warnings).toEqual([]);
  });

  it('a non-numeric strike is a located NUMBER_UNPARSEABLE with tradrField set', () => {
    const result = normalizeRow(row({ strike: 'abc' }), US);
    expect(Array.isArray(result)).toBe(true);
    const err = (result as { code: string; tradrField?: string }[])[0];
    expect(err.code).toBe('NUMBER_UNPARSEABLE');
    expect(err.tradrField).toBe('strike');
  });
});

describe('normalizeRow — sign conventions (seam 1, REQ-3.2, REQ-1.7)', () => {
  // The stored quantity is the magnitude (canonical toFixed form, no trailing
  // zeros); direction is carried by an added/verified `action`.
  it('signedQuantity: a negative quantity stores the magnitude and derives action=sell', () => {
    const r = ok(normalizeRow(row({ quantity: '-100' }), { ...US, signedQuantity: true }));
    expect(r.row.values.quantity).toBe('100');
    expect(r.row.values.action).toBe('sell');
  });

  it('signedQuantity: a positive quantity derives action=buy', () => {
    const r = ok(normalizeRow(row({ quantity: '100' }), { ...US, signedQuantity: true }));
    expect(r.row.values.quantity).toBe('100');
    expect(r.row.values.action).toBe('buy');
  });

  it('signedQuantity: a sign contradicting a mapped action is QUANTITY_SIGN_CONTRADICTION', () => {
    const result = normalizeRow(row({ quantity: '-100', action: 'buy' }), {
      ...US,
      signedQuantity: true,
    });
    expect(Array.isArray(result)).toBe(true);
    const err = (result as { code: string; tradrField?: string; message: string }[])[0];
    expect(err.code).toBe('QUANTITY_SIGN_CONTRADICTION');
    expect(err.tradrField).toBe('quantity');
    expect(err.message).toContain('-100');
  });

  it('signedQuantity: a type-mapped row (no action) sets action from the sign, type untouched', () => {
    const r = ok(
      normalizeRow(row({ quantity: '-100', type: 'exit' }), { ...US, signedQuantity: true }),
    );
    expect(r.row.values.action).toBe('sell');
    expect(r.row.values.type).toBe('exit');
  });

  it('signedFees: a negative fee stores the magnitude (a cost either way)', () => {
    const r = ok(normalizeRow(row({ fees: '-0.65' }), { ...US, signedFees: true }));
    expect(r.row.values.fees).toBe('0.65');
  });

  it('undeclared: a negative quantity passes through unchanged (refused downstream)', () => {
    const r = ok(normalizeRow(row({ quantity: '-100' }), US));
    expect(r.row.values.quantity).toBe('-100');
    expect(r.row.values.action).toBeUndefined();
  });
});

describe('normalizeRow — passthrough + multi-error collection', () => {
  it('passes enum/text fields through unchanged', () => {
    const r = ok(
      normalizeRow(
        row({ symbol: 'AAPL', side: 'long', type: 'entry', notes: 'hello', assetType: 'stock' }),
        US,
      ),
    );
    expect(r.row.values).toMatchObject({
      symbol: 'AAPL',
      side: 'long',
      type: 'entry',
      notes: 'hello',
      assetType: 'stock',
    });
  });

  it('collects all field errors for a row', () => {
    const result = normalizeRow(row({ price: 'abc', filledAt: 'nope' }), {
      ...US,
      dateFormat: 'iso',
    });
    expect(Array.isArray(result)).toBe(true);
    const codes = (result as { code: string }[]).map((e) => e.code).sort();
    expect(codes).toContain('NUMBER_UNPARSEABLE');
    expect(codes).toContain('DATE_FORMAT_MISMATCH');
  });

  it('reports an invalid import timezone as a located error', () => {
    const result = normalizeRow(row({ filledAt: '2024-03-10' }), {
      timezone: 'Not/AZone',
      dateFormat: 'iso',
      numberFormat: 'us',
    });
    expect(Array.isArray(result)).toBe(true);
    expect((result as { code: string }[])[0].code).toBe('INVALID_TIMEZONE');
  });
});

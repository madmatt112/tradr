import { Decimal } from 'decimal.js';

import type { DateFormat, LocatedError, LocatedWarning, NumberFormat } from '@tradr/shared';

import type { MappedRow } from './csv-mapping';

/**
 * Normalizer — pure leaf module (no HTTP, no DB).
 *
 * Turns a {@link MappedRow}'s broker/locale representation into Tradr canonical
 * values (REQ-5.1), implementing design Component 3:
 *
 *  - Dates ({@link DateFormat}) are normalized to ISO-8601 with offset. The
 *    declared format is honored exactly and NEVER guessed (REQ-5.3); a date-only
 *    value becomes start-of-day in the import timezone (REQ-7.4), never silently
 *    UTC-midnight and never silently MM/DD vs DD/MM.
 *  - Numbers ({@link NumberFormat}, default `us`) are normalized to a plain
 *    decimal string (REQ-5.4): `$`, thousands separators, parentheses-negatives
 *    and trailing CR/DR are stripped.
 *  - `price`/`quantity`/`fees` are quantized to EXACTLY 8 decimal places via
 *    `new Decimal(v).toDecimalPlaces(8, ROUND_HALF_UP)` — bit-identical to a
 *    Postgres `::numeric(18,8)` cast and the global Decimal config (`app.ts:82`)
 *    — and the magnitude bound is applied AFTER quantization (a carry can push a
 *    value into a new integer digit), so a quantized magnitude >= 10^10 is a
 *    located error, never passed through to fail with `22003` at commit.
 *
 * Normalization succeeds with zero-or-more accompanying located WARNINGS (e.g. a
 * per-cell `rounded` warning when >8 dp were truncated), surfaced via the
 * returned warnings channel — never `console`. It fails with located errors.
 */

/** Options for {@link normalizeRow}. */
export interface NormalizeOptions {
  /** IANA timezone for date-only start-of-day resolution (REQ-7.4). */
  timezone: string;
  /** Declared date format; never guessed (REQ-5.3). */
  dateFormat: DateFormat;
  /** Declared number format; defaults to `us` upstream (REQ-5.4). */
  numberFormat: NumberFormat;
}

/**
 * One normalized row: Tradr field -> canonical value. Numeric fields hold a
 * plain decimal string quantized to 8 dp; `filledAt`/`entryDate`/`exitDate` hold
 * ISO-8601 with offset; enum/text fields pass through unchanged.
 */
export interface NormalizedRow {
  /** 1-based source row number; the header counts as row 1. */
  sourceRow: number;
  /** Tradr field -> normalized value. */
  values: Record<string, string>;
}

/** Result of a successful normalization: the row plus any located warnings. */
export interface NormalizeSuccess {
  row: NormalizedRow;
  warnings: LocatedWarning[];
}

/** Numeric fields quantized to the `numeric(18,8)` column scale (Component 3). */
const NUMERIC_FIELDS = ['price', 'quantity', 'fees', 'entryPrice', 'exitPrice'] as const;
/** Quantity fields are numeric too but separated only for readability. */
const QUANTITY_FIELDS = ['entryQuantity', 'exitQuantity'] as const;
/** Every field that must be quantized + magnitude-bounded. */
const QUANTIZED_FIELDS: readonly string[] = [...NUMERIC_FIELDS, ...QUANTITY_FIELDS];

/** Date fields normalized to ISO-8601 with offset (REQ-5.3). */
const DATE_FIELDS: readonly string[] = ['filledAt', 'entryDate', 'exitDate'];

/** Pass-through (already canonical) fields. */
const ENUM_OR_TEXT_FIELDS: readonly string[] = [
  'symbol',
  'assetType',
  'side',
  'type',
  'action',
  'notes',
];

/** Scale of `fills.price`/`quantity`/`fees` (`positions.schema.ts:60-62`). */
const COLUMN_SCALE = 8;
/**
 * Exclusive magnitude bound for `numeric(18,8)`: precision 18 - scale 8 = 10
 * integer digits, so the largest storable magnitude is `9999999999.99999999`
 * (< 10^10). A quantized magnitude >= 10^10 throws `22003` at commit.
 */
const MAGNITUDE_BOUND = new Decimal('1e10');

/**
 * Normalize one mapped row to Tradr canonical values (design Component 3).
 *
 * Returns either `{ row, warnings }` on success (warnings may be empty) or a
 * non-empty `LocatedError[]` on failure. All errors for the row are collected so
 * the preview can show them together (REQ-5.6).
 */
export function normalizeRow(
  mappedRow: MappedRow,
  opts: NormalizeOptions,
): NormalizeSuccess | LocatedError[] {
  const { sourceRow } = mappedRow;
  const out: Record<string, string> = {};
  const warnings: LocatedWarning[] = [];
  const errors: LocatedError[] = [];

  for (const [field, raw] of Object.entries(mappedRow.values)) {
    if (QUANTIZED_FIELDS.includes(field)) {
      const result = normalizeNumber(raw, opts.numberFormat);
      if ('error' in result) {
        errors.push({
          rowNumber: sourceRow,
          tradrField: field,
          code: result.error,
          message: result.message,
        });
        continue;
      }
      // Quantize to the column scale BEFORE the magnitude bound (order matters:
      // quantization can carry into a new integer digit).
      const quantized = result.value.toDecimalPlaces(COLUMN_SCALE, Decimal.ROUND_HALF_UP);
      if (!quantized.equals(result.value)) {
        warnings.push({
          rowNumber: sourceRow,
          csvColumn: field,
          kind: 'rounded',
          message: `Value "${raw}" for field "${field}" was rounded to 8 decimal places.`,
        });
      }
      // Magnitude bound applied to the QUANTIZED value (incl. carry-induced).
      if (quantized.abs().greaterThanOrEqualTo(MAGNITUDE_BOUND)) {
        errors.push({
          rowNumber: sourceRow,
          tradrField: field,
          code: 'NUMBER_MAGNITUDE_TOO_LARGE',
          message: `Value "${raw}" for field "${field}" exceeds the maximum representable magnitude.`,
        });
        continue;
      }
      out[field] = quantized.toFixed();
    } else if (DATE_FIELDS.includes(field)) {
      const result = normalizeDate(raw, opts.dateFormat, opts.timezone);
      if ('error' in result) {
        errors.push({
          rowNumber: sourceRow,
          tradrField: field,
          code: result.error,
          message: result.message,
        });
        continue;
      }
      out[field] = result.value;
    } else if (ENUM_OR_TEXT_FIELDS.includes(field)) {
      out[field] = raw;
    } else {
      // Unknown field: pass through unchanged rather than drop it.
      out[field] = raw;
    }
  }

  if (errors.length > 0) return errors;
  return { row: { sourceRow, values: out }, warnings };
}

// ---------------------------------------------------------------------------
// Numbers (REQ-5.4)
// ---------------------------------------------------------------------------

type NumberResult = { value: Decimal } | { error: string; message: string };

// A legitimate number cell is short; bound the raw length before any regex or
// replace runs so an oversized cell can't drive the validation regex below into
// super-linear backtracking (ReDoS).
const MAX_NUMERIC_INPUT_LEN = 64;

/**
 * Normalize a broker/locale number to a {@link Decimal} (REQ-5.4). Strips `$`,
 * thousands separators, surrounding parentheses (-> negative) and trailing
 * CR/DR; `eu` treats `,` as the decimal point. Returns a located error for any
 * value that does not parse — never a silently mis-parsed amount.
 */
function normalizeNumber(raw: string, format: NumberFormat): NumberResult {
  const original = raw;
  if (raw.length > MAX_NUMERIC_INPUT_LEN) {
    return {
      error: 'NUMBER_UNPARSEABLE',
      message: `Value "${raw.slice(0, 32)}…" is too long to be a valid ${format} number.`,
    };
  }
  let s = raw.trim();
  if (s === '') {
    return { error: 'NUMBER_EMPTY', message: 'Empty numeric value.' };
  }

  // Parentheses -> negative (accounting notation), possibly with $ inside.
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1).trim();
  }

  // Trailing CR (credit, positive) / DR (debit, negative).
  const tail = s.slice(-2).toUpperCase();
  if (tail === 'DR') {
    negative = !negative;
    s = s.slice(0, -2).trim();
  } else if (tail === 'CR') {
    s = s.slice(0, -2).trim();
  }

  // Leading sign.
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) {
    s = s.slice(1).trim();
  }

  // Currency symbol.
  s = s.replace(/\$/g, '').trim();

  // Separators: in `us`, `,` is the thousands sep and `.` the decimal; in `eu`,
  // `.` is the thousands sep and `,` the decimal.
  if (format === 'eu') {
    s = s.replace(/\./g, '').replace(/,/g, '.');
  } else {
    s = s.replace(/,/g, '');
  }

  if (s === '' || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) {
    return {
      error: 'NUMBER_UNPARSEABLE',
      message: `Value "${original}" is not a valid ${format} number.`,
    };
  }

  let value: Decimal;
  try {
    value = new Decimal(s);
  } catch {
    return {
      error: 'NUMBER_UNPARSEABLE',
      message: `Value "${original}" is not a valid ${format} number.`,
    };
  }
  if (negative) value = value.negated();
  return { value };
}

// ---------------------------------------------------------------------------
// Dates (REQ-5.3, REQ-7.4)
// ---------------------------------------------------------------------------

type DateResult = { value: string } | { error: string; message: string };

const EXPECTED: Record<DateFormat, string> = {
  iso: 'YYYY-MM-DD',
  us: 'MM/DD/YYYY',
  eu: 'DD/MM/YYYY',
  'iso-datetime': 'ISO-8601 datetime',
};

/**
 * Normalize a broker date to ISO-8601 with offset (REQ-5.3). The declared format
 * is honored exactly and never guessed; a value not matching it is a located
 * error naming the expected format. A date-only value becomes start-of-day in
 * the import timezone (REQ-7.4); `iso-datetime` carries its own time/offset.
 */
function normalizeDate(raw: string, format: DateFormat, timezone: string): DateResult {
  const s = raw.trim();
  const expectedMsg = `expected format ${EXPECTED[format]}`;

  if (format === 'iso-datetime') {
    const ms = Date.parse(s);
    if (Number.isNaN(ms)) {
      return {
        error: 'DATE_UNPARSEABLE',
        message: `Value "${raw}" is not a valid datetime (${expectedMsg}).`,
      };
    }
    return { value: new Date(ms).toISOString() };
  }

  let year: number;
  let month: number;
  let day: number;
  if (format === 'iso') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m)
      return {
        error: 'DATE_FORMAT_MISMATCH',
        message: `Value "${raw}" does not match ${expectedMsg}.`,
      };
    year = Number(m[1]);
    month = Number(m[2]);
    day = Number(m[3]);
  } else {
    // us = MM/DD/YYYY, eu = DD/MM/YYYY — never guessed.
    const m = /^(\d{1,2})[/](\d{1,2})[/](\d{4})$/.exec(s);
    if (!m)
      return {
        error: 'DATE_FORMAT_MISMATCH',
        message: `Value "${raw}" does not match ${expectedMsg}.`,
      };
    year = Number(m[3]);
    if (format === 'us') {
      month = Number(m[1]);
      day = Number(m[2]);
    } else {
      day = Number(m[1]);
      month = Number(m[2]);
    }
  }

  if (!isRealDate(year, month, day)) {
    return {
      error: 'DATE_INVALID',
      message: `Value "${raw}" is not a real calendar date (${expectedMsg}).`,
    };
  }

  const iso = startOfDayIso(year, month, day, timezone);
  if (iso === null) {
    return {
      error: 'INVALID_TIMEZONE',
      message: `Import timezone "${timezone}" is not a valid IANA timezone.`,
    };
  }
  return { value: iso };
}

/** True iff (year, month, day) is a real Gregorian calendar date. */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/**
 * Start-of-day (00:00:00.000) for a calendar date in the given IANA timezone,
 * formatted as ISO-8601 with offset (e.g. `2024-03-10T00:00:00.000-05:00`).
 * Returns `null` if the timezone is invalid. Resolves the wall-clock-to-instant
 * mapping via the offset `Intl` reports for that local time.
 */
function startOfDayIso(year: number, month: number, day: number, timezone: string): string | null {
  const offsetMin = timezoneOffsetMinutes(year, month, day, timezone);
  if (offsetMin === null) return null;
  // The wall-clock components are exactly local midnight; the offset pins the
  // instant. (00:00:00 local + offset = the UTC instant Postgres stores.)
  const yyyy = String(year).padStart(4, '0');
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T00:00:00.000${formatOffset(offsetMin)}`;
}

/**
 * Offset, in minutes east of UTC, of local midnight for the given date in the
 * given IANA timezone. Returns `null` for an invalid timezone.
 */
function timezoneOffsetMinutes(
  year: number,
  month: number,
  day: number,
  timezone: string,
): number | null {
  let dtf: Intl.DateTimeFormat;
  try {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return null;
  }
  // Interpret midnight UTC of the date, read what wall-clock the tz shows, and
  // derive the offset. Two passes converge DST-safely for a start-of-day query.
  const asUtcMidnight = Date.UTC(year, month - 1, day, 0, 0, 0);
  const guess = wallClockUtcMs(dtf, asUtcMidnight);
  const offset = (guess - asUtcMidnight) / 60_000;
  // Re-evaluate at the candidate local-midnight instant to settle DST edges.
  const candidate = asUtcMidnight - offset * 60_000;
  const guess2 = wallClockUtcMs(dtf, candidate);
  return Math.round((guess2 - candidate) / 60_000);
}

/**
 * Given a UTC instant, return the UTC-ms value of the wall-clock the timezone
 * shows at that instant (used to derive the offset).
 */
function wallClockUtcMs(dtf: Intl.DateTimeFormat, instantMs: number): number {
  const parts = dtf.formatToParts(new Date(instantMs));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
}

/** Format a minutes-east-of-UTC offset as `+HH:MM` / `-HH:MM` (`Z` -> `+00:00`). */
function formatOffset(offsetMin: number): string {
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

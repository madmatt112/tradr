import { Decimal } from 'decimal.js';

import {
  encodeOccCompact,
  parseOccSymbol,
  type ContractForm,
  type LocatedError,
  type LocatedWarning,
  type NumberFormat,
  type OccComponents,
} from '@tradr/shared';

import { normalizeNumber, type NormalizedRow } from './csv-normalize';

/**
 * Contract resolution — pure leaf module (no HTTP, no DB, no config).
 *
 * Turns every option row's contract into the compact OCC symbol through the one
 * shared encoder ({@link encodeOccCompact}), refuses what the ×100 model cannot
 * represent, and checks stock rows for contradictions. Implements design
 * Component 4 (REQ-1.3, 2.1, 2.4–2.6, 3.5, 4.1–4.4).
 *
 * The one-encoder/one-parser rule is absolute: this module never re-implements
 * an OCC rule. It calls {@link parseOccSymbol} / {@link encodeOccCompact} and
 * surfaces their `code` and `message` verbatim, located to the row and the field
 * the code concerns. It never stores the parser's 21-char canonical form — the
 * compact form is re-encoded from the parsed components.
 */

/** Options for {@link resolveContracts}. */
export interface ContractOptions {
  /** Declared contract form; option rows with none set are refused. */
  contractForm?: ContractForm;
  /** Number format for the descriptor's strike token. */
  numberFormat: NumberFormat;
  /** Tradr field -> CSV column name, to set `csvColumn` on located errors. */
  columns: Record<string, string>;
}

/** Result of {@link resolveContracts}: surviving rows plus located diagnostics. */
export interface ResolveResult {
  rows: NormalizedRow[];
  errors: LocatedError[];
  warnings: LocatedWarning[];
}

/** Composed-form contract cells; a populated one on a stock row is a contradiction. */
const CONTRACT_FIELDS = ['expiry', 'strike', 'right'] as const;

/**
 * IBKR lifecycle codes Tradr cannot yet import, mapped to the kind named in the
 * refusal message (REQ-4.2). `A` is an assignment; `EX`/`AEX`/`MEX` an exercise;
 * `EP`/`GEA` an expiration or assignment. Other codes (`O`, `C`, `P`, …) import.
 */
const EVENT_KIND: Record<string, string> = {
  A: 'assignment',
  EX: 'exercise',
  AEX: 'exercise',
  MEX: 'exercise',
  EP: 'expiration or assignment',
  GEA: 'expiration or assignment',
};

/**
 * Resolve every row's contract (design Component 4). Rewrites `values.symbol` to
 * the compact OCC symbol on option rows; drops any row that errors; stock rows
 * pass through unchanged. Errors and warnings are located to the row and, where a
 * column was mapped, to its `csvColumn`.
 *
 * PRECONDITION: every row has a non-empty trimmed `symbol` — Component 5 excludes
 * mapping-errored rows (including a missing required `symbol`) before this stage,
 * and `applyMapping` never stores an empty cell. This module is therefore only
 * unit-tested on rows whose `symbol` is present.
 */
export function resolveContracts(rows: NormalizedRow[], opts: ContractOptions): ResolveResult {
  const outRows: NormalizedRow[] = [];
  const errors: LocatedError[] = [];
  const warnings: LocatedWarning[] = [];

  for (const row of rows) {
    const { sourceRow, values } = row;
    const rowErrors: LocatedError[] = [];

    // Locate an error to the row and, when the field was mapped, its column.
    const push = (tradrField: string, code: string, message: string): void => {
      const error: LocatedError = { rowNumber: sourceRow, tradrField, code, message };
      const column = opts.columns[tradrField];
      if (column !== undefined) error.csvColumn = column;
      rowErrors.push(error);
    };

    // (1) Stock row: no contract to resolve. Under `composed` a populated
    // contract cell contradicts the asset type; under the other forms nothing
    // applies. Either way the stock row passes through unchanged.
    if (values.assetType === 'stock') {
      if (opts.contractForm === 'composed') {
        const populated = CONTRACT_FIELDS.find((f) => values[f] !== undefined);
        if (populated) {
          push(
            populated,
            'CONTRACT_FIELD_ON_STOCK',
            `Row ${sourceRow} is a stock row but carries an option ${populated} of "${values[populated]}"; remove the contract field or set the asset type to option.`,
          );
        }
      }
      if (rowErrors.length > 0) {
        errors.push(...rowErrors);
        continue;
      }
      outRows.push(row);
      continue;
    }

    // Option row from here on.

    // (2) No contract form declared (reachable only from an API client — the UI
    // always sends a form).
    if (opts.contractForm === undefined) {
      push(
        'symbol',
        'CONTRACT_FORM_MISSING',
        `Row ${sourceRow} is an option row but the mapping declares no contract form.`,
      );
      errors.push(...rowErrors);
      continue;
    }

    // (3) Multiplier (REQ-4.1): Tradr represents only 100-share contracts.
    if (values.multiplier !== undefined && !new Decimal(values.multiplier).equals(100)) {
      push(
        'multiplier',
        'OPTION_MULTIPLIER_UNSUPPORTED',
        `Tradr represents only 100-share option contracts; row ${sourceRow} declares a multiplier of ${values.multiplier}.`,
      );
    }

    // (4) Lifecycle event (REQ-4.2). The `;` delimiter for multiple IBKR
    // Notes/Codes in one cell is INFERRED: the Flex fields page does not state
    // how codes share a cell. It degrades safely — a single-code cell yields one
    // token and still matches; a code missed by a wrong delimiter merely imports
    // the contract at ×100 (the residual), never a crash.
    if (values.eventCode !== undefined) {
      const tokens = values.eventCode.split(';').map((t) => t.trim().toUpperCase());
      const kind = tokens.map((t) => EVENT_KIND[t]).find((k) => k !== undefined);
      if (kind !== undefined) {
        push(
          'eventCode',
          'OPTION_EVENT_NOT_SUPPORTED',
          `Row ${sourceRow} carries a ${kind} event ("${values.eventCode}") and cannot be imported until option lifecycle events are supported; close or remove the contract by hand.`,
        );
      }
    }

    // Route an encoder error to the field its code concerns (design step 6). The
    // located value is `values[field]` — the offending underlying, strike, expiry
    // or compact-symbol underlying — which names it for the user.
    const routeEncodeError = (
      error: { code: string; message: string },
      fields: { underlying: string; strike: string; date: string },
    ): void => {
      let field: string;
      switch (error.code) {
        case 'OCC_BAD_UNDERLYING':
          field = fields.underlying;
          break;
        case 'OCC_STRIKE_RANGE':
        case 'OCC_STRIKE_PRECISION':
        case 'OCC_STRIKE_NOT_REPRESENTABLE':
          field = fields.strike;
          break;
        case 'OCC_BAD_DATE':
        case 'OCC_DATE_RANGE':
          field = fields.date;
          break;
        default:
          // OCC_COMPACT_TOO_LONG, and any other encoder/parser code.
          field = 'symbol';
          break;
      }
      push(
        field,
        error.code,
        `Row ${sourceRow} · field ${field} "${values[field] ?? ''}": ${error.message}`,
      );
    };

    // (5) Resolve the contract by form; (6) locate any encoder error.
    let compact: string | undefined;
    if (opts.contractForm === 'occ-symbol') {
      // Outer trim only, so OCC padding survives (the parser normalises internal
      // whitespace itself). Every encode/parse error locates to `symbol`.
      const parsed = parseOccSymbol(values.symbol.trim().toUpperCase());
      if (!parsed.ok) {
        push(
          'symbol',
          parsed.error.code,
          `Row ${sourceRow} · symbol "${values.symbol}": ${parsed.error.message}`,
        );
      } else {
        const encoded = encodeOccCompact(parsed.value);
        if (!encoded.ok) {
          routeEncodeError(encoded.error, {
            underlying: 'symbol',
            strike: 'symbol',
            date: 'symbol',
          });
        } else {
          compact = encoded.value;
        }
      }
    } else if (opts.contractForm === 'composed') {
      const underlyingFromSymbol = values.underlying === undefined;
      const underlyingField = underlyingFromSymbol ? 'symbol' : 'underlying';
      const underlying = (values.underlying ?? values.symbol).trim().toUpperCase();
      // One error per missing cell so the user sees all of them (REQ-2.6).
      for (const field of CONTRACT_FIELDS) {
        if (values[field] === undefined) {
          push(
            field,
            'CONTRACT_FIELD_MISSING',
            `Row ${sourceRow} is an option row missing its ${field}.`,
          );
        }
      }
      if (
        values.expiry !== undefined &&
        values.strike !== undefined &&
        values.right !== undefined
      ) {
        const components: OccComponents = {
          underlying,
          expiration: values.expiry,
          type: values.right as 'call' | 'put',
          strike: values.strike,
        };
        const encoded = encodeOccCompact(components);
        if (!encoded.ok) {
          routeEncodeError(encoded.error, {
            underlying: underlyingField,
            strike: 'strike',
            date: 'expiry',
          });
        } else {
          compact = encoded.value;
        }
      }
    } else {
      // descriptor form
      const decoded = decodeDescriptor(values.descriptor, opts.numberFormat);
      if (!decoded.ok) {
        if (decoded.reason === 'mini') {
          push(
            'descriptor',
            'OPTION_MULTIPLIER_UNSUPPORTED',
            `Row ${sourceRow} · descriptor "${values.descriptor}" is a mini (non-100-share) contract, which Tradr does not represent.`,
          );
        } else {
          push(
            'descriptor',
            'CONTRACT_DESCRIPTOR_UNPARSEABLE',
            `Row ${sourceRow} · descriptor "${decoded.detail}" could not be parsed as a Tradervue option descriptor.`,
          );
        }
      } else {
        const underlying = values.symbol.trim().toUpperCase();
        if (decoded.derived) {
          const warning: LocatedWarning = {
            rowNumber: sourceRow,
            kind: 'derived_expiry',
            message: `Row ${sourceRow}: the expiry for "${values.descriptor}" was derived as ${decoded.expiration} (the third Friday of the month). Tradervue's monthly form names no day, so this may differ from the broker's OCC expiration date, and a re-import of the same contract from an OCC symbol may not be detected as a duplicate.`,
          };
          const column = opts.columns.descriptor;
          if (column !== undefined) warning.csvColumn = column;
          warnings.push(warning);
        }
        const components: OccComponents = {
          underlying,
          expiration: decoded.expiration,
          type: decoded.type,
          strike: decoded.strike,
        };
        const encoded = encodeOccCompact(components);
        if (!encoded.ok) {
          // The underlying came from `symbol`; the strike/date from `descriptor`.
          routeEncodeError(encoded.error, {
            underlying: 'symbol',
            strike: 'descriptor',
            date: 'descriptor',
          });
        } else {
          compact = encoded.value;
        }
      }
    }

    // (7) Any error in steps 2–6 drops the row (the preview is non-committable
    // regardless); otherwise the compact symbol replaces `values.symbol`.
    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      continue;
    }
    outRows.push({ sourceRow, values: { ...values, symbol: compact as string } });
  }

  return { rows: outRows, errors, warnings };
}

// ---------------------------------------------------------------------------
// Tradervue descriptor grammar
// ---------------------------------------------------------------------------

/** Length cap before the regex runs (the `MAX_NUMERIC_INPUT_LEN` ReDoS posture). */
const DESCRIPTOR_MAX_LEN = 64;

/** `MON[DD] YY STRIKE CALL|PUT [M]` — day group optional, trailing `M` = mini. */
const DESCRIPTOR_RE = /^([A-Z]{3})(\d{1,2})?\s+(\d{2})\s+(\S+)\s+(CALL|PUT)(\s+M)?$/;

/** Month abbreviation -> 1-based month; an unknown token is unparseable. */
const DESCRIPTOR_MONTHS: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

/**
 * Third Friday of the month, per the design's derivation:
 * `first = 1 + ((5 − dow(1st)) + 7) % 7; third = first + 14`, with `dow` (0 = Sun)
 * read from `Date.UTC`.
 *
 * Tradervue's monthly descriptor form names no day; the standard monthly OCC
 * contract expires on the third Friday. This is a modern-convention derivation:
 * monthly contracts before February 2015 technically expired the *following
 * Saturday*, so the committed 2012 sample encodes `SPY120120C125` (the Friday)
 * where a broker's OCC string would read `SPY120121C125` (the Saturday). The
 * `derived_expiry` warning flags exactly this mismatch to the user.
 */
function thirdFriday(year: number, month: number): number {
  const dow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const first = 1 + ((5 - dow + 7) % 7);
  return first + 14;
}

/**
 * Decode a Tradervue option descriptor `MON[DD] YY STRIKE CALL|PUT [M]` to its
 * OCC components, or a reason it cannot be. The strike token is parsed under the
 * declared {@link NumberFormat}. Calendar validity of an explicit day is left to
 * the encoder's `OCC_BAD_DATE`; a monthly form (no day) derives the third Friday
 * and flags `derived: true`. A trailing `M` (mini) is refused before any decode.
 * Exported for the unit tests.
 */
export function decodeDescriptor(
  cell: string,
  numberFormat: NumberFormat,
):
  | { ok: true; expiration: string; type: 'call' | 'put'; strike: string; derived: boolean }
  | { ok: false; reason: 'mini' | 'unparseable'; detail: string } {
  const s = cell.trim().toUpperCase();
  if (s.length > DESCRIPTOR_MAX_LEN) {
    return { ok: false, reason: 'unparseable', detail: `${s.slice(0, 32)}…` };
  }

  const match = DESCRIPTOR_RE.exec(s);
  if (!match) return { ok: false, reason: 'unparseable', detail: s };

  const [, monthToken, dayToken, yearToken, strikeToken, rightToken, mini] = match;

  // A mini contract is a non-100-share contract: refuse before any decode.
  if (mini !== undefined) return { ok: false, reason: 'mini', detail: s };

  const month = DESCRIPTOR_MONTHS[monthToken];
  if (month === undefined) return { ok: false, reason: 'unparseable', detail: monthToken };

  const year = 2000 + Number(yearToken);
  const day = dayToken !== undefined ? Number(dayToken) : thirdFriday(year, month);
  const derived = dayToken === undefined;

  const strike = normalizeNumber(strikeToken, numberFormat);
  if ('error' in strike) return { ok: false, reason: 'unparseable', detail: strikeToken };

  const expiration = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(
    day,
  ).padStart(2, '0')}`;
  const type: 'call' | 'put' = rightToken === 'CALL' ? 'call' : 'put';

  return { ok: true, expiration, type, strike: strike.value.toFixed(), derived };
}

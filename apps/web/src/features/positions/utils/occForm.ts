import { encodeOccCompact, parseOccSymbol, type ParseResult } from '@tradr/shared';

/** Raw, editable contract inputs as they live in the create/edit form. */
export interface OptionContractInputs {
  underlying: string;
  /** YYYY-MM-DD, straight from an `<input type="date">`. */
  expiry: string;
  type: 'call' | 'put';
  strike: string;
}

/**
 * Encode the form inputs into a compact OCC symbol. Upper-cases the underlying
 * (Req 1.4) and trims, then defers to the shared `encodeOccCompact` — the single
 * authoritative gate. Does NOT re-implement OCC bounds here. Pure.
 */
export function encodeContract(i: OptionContractInputs): ParseResult<string> {
  return encodeOccCompact({
    underlying: i.underlying.trim().toUpperCase(),
    expiration: i.expiry,
    type: i.type,
    strike: i.strike.trim(),
  });
}

/**
 * Decode a stored OCC symbol into editable form inputs for prefill. Returns null
 * when the symbol is not a parseable OCC symbol (legacy / free-text rows). The
 * strike is normalised via `Number(...).toString()` so the box shows `120` / `0.5`,
 * never `120.000` / `5.00000e-1`. Pure.
 */
export function decodeContract(symbol: string): OptionContractInputs | null {
  const parsed = parseOccSymbol(symbol);
  if (!parsed.ok) return null;

  return {
    underlying: parsed.value.underlying,
    expiry: parsed.value.expiration,
    type: parsed.value.type,
    strike: Number(parsed.value.strike).toString(),
  };
}

/**
 * Map an encoder error code to the form field it should attach to. Unknown codes
 * (and `OCC_COMPACT_TOO_LONG`, a cross-field condition) fall through to `'form'`.
 */
export function occErrorField(code: string): 'underlying' | 'strike' | 'expiry' | 'form' {
  switch (code) {
    case 'OCC_BAD_UNDERLYING':
      return 'underlying';
    case 'OCC_STRIKE_RANGE':
    case 'OCC_STRIKE_PRECISION':
    case 'OCC_STRIKE_NOT_REPRESENTABLE':
      return 'strike';
    case 'OCC_BAD_DATE':
    case 'OCC_DATE_RANGE':
      return 'expiry';
    default:
      return 'form';
  }
}

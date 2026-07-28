import { Skeleton } from '@/components/ui/skeleton';
import { EM_DASH, moneyDirection } from '@/lib/format';
import { cn } from '@/lib/utils';

export type NumericKind = 'money' | 'percent' | 'signed' | 'decimal' | 'integer';

export interface NumericProps {
  /** The figure to render. `null` ⇒ the absent state (em-dash). */
  value: number | string | null;
  /** Formatting family. Defaults to `'decimal'`. Greeks stay on `format6SigFig` and are NOT routed here. */
  kind?: NumericKind;
  /** ISO 4217 code, required when `kind='money'`. */
  currency?: string;
  /** Per-metric precision override. Defaults per `kind` (money 2, percent 1, integer 0, otherwise 2). */
  precision?: number;
  /**
   * `'auto'` derives gain/loss/flat from the sign and applies the money-direction
   * encoding (leading sign + color). `'none'` is a neutral figure (counts, ids) —
   * no leading sign-coloring.
   */
  direction?: 'auto' | 'none';
  /** `'value'` (default) or `'loading'`. The absent state is inferred from `value === null`. */
  state?: 'value' | 'loading';
  className?: string;
  'aria-label'?: string;
}

/**
 * The fixed-width leading slot. The sign lives here in EVERY state so the digit
 * string always starts at the same x — the load-bearing half of decimal alignment
 * (the other half is one precision per column + `text-right` on the column
 * wrapper). `inline-block` + a `min-w` in `ch` reserves the width without a
 * measured layout (jsdom-safe). This class is intentionally identical across all
 * four states — the reserved-slot invariant the tests assert.
 */
const SLOT_CLASS = 'inline-block min-w-[1.25ch] text-right';

function defaultPrecision(kind: NumericKind): number {
  switch (kind) {
    case 'money':
      return 2;
    case 'percent':
      return 1;
    case 'integer':
      return 0;
    // 'signed' | 'decimal' — profit factor / generic figures
    default:
      return 2;
  }
}

/**
 * Format the digit body WITHOUT a sign — the sign is rendered separately in the
 * reserved slot so it never shifts the digits. For money we use `formatToParts`
 * to lift the `minusSign`/`plusSign` part out of the (suffix-less) currency
 * string, keeping `{symbol + digits}` right-aligned. Other kinds drop the sign
 * by formatting the magnitude.
 */
function formatBody(
  magnitude: number,
  kind: NumericKind,
  currency: string | undefined,
  precision: number,
): string {
  if (kind === 'money') {
    const parts = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency ?? 'USD',
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    }).formatToParts(magnitude);
    // Drop the sign parts — the leading slot owns the sign.
    return parts
      .filter((p) => p.type !== 'minusSign' && p.type !== 'plusSign')
      .map((p) => p.value)
      .join('');
  }

  const body = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  }).format(magnitude);

  return kind === 'percent' ? `${body}%` : body;
}

/**
 * Numeric — the single DOM enforcement point for financial figures (Requirement 4).
 *
 * FOUR STATES, with the leading-sign slot reserved in ALL FOUR (R4.2):
 *   - absent (`value === null`): em-dash, muted, slot reserved (empty).
 *   - flat (`0`): the literal `0.00` (per precision), `text-flat`, slot reserved
 *     (empty) — never the em-dash.
 *   - value: leading `+`/`−` sign (always on) + `text-gain`/`text-loss`, tabular
 *     digits.
 *   - loading: a `Skeleton` sized to the slot + digit width (no layout jump, R4.4).
 *
 * The always-on non-color channel is the leading SIGN (`+`/`−`); paired with the
 * gain/loss color it keeps the direction readable without color (the colorblind
 * gate). There is no decorative directional glyph.
 */
export function Numeric({
  value,
  kind = 'decimal',
  currency,
  precision,
  direction = 'auto',
  state = 'value',
  className,
  'aria-label': ariaLabel,
}: NumericProps) {
  const fractionDigits = precision ?? defaultPrecision(kind);

  // Loading — slot + digits sized so the column does not collapse (R4.4).
  if (state === 'loading') {
    return <Numeric.Skeleton className={className} />;
  }

  // Resolve to a number for direction; tolerate string input (decimal strings).
  const numeric = value === null ? null : typeof value === 'string' ? Number(value) : value;
  const dir = numeric === null || Number.isNaN(numeric) ? 'absent' : moneyDirection(numeric);

  // Absent — em-dash, slot reserved, no glyph (R3.4: absent is null only).
  if (dir === 'absent') {
    return (
      <span
        className={cn('tabular-nums text-muted-foreground', className)}
        aria-label={ariaLabel}
        data-testid="numeric"
        data-state="absent"
      >
        <span className={SLOT_CLASS} data-testid="numeric-slot" aria-hidden="true" />
        {EM_DASH}
      </span>
    );
  }

  const magnitude = Math.abs(numeric as number);
  const body = formatBody(magnitude, kind, currency, fractionDigits);

  // Flat — literal zero, bare body, never the em-dash (R3.4 / C6). The slot stays
  // width-reserved but empty (no sign for zero).
  if (dir === 'flat') {
    return (
      <span
        className={cn('tabular-nums text-flat', className)}
        aria-label={ariaLabel}
        data-testid="numeric"
        data-state="flat"
      >
        <span className={SLOT_CLASS} data-testid="numeric-slot" aria-hidden="true" />
        {body}
      </span>
    );
  }

  // Value — leading sign (always on) + gain/loss color.
  const neutral = direction === 'none';
  const sign = neutral ? '' : dir === 'gain' ? '+' : '−'; // U+2212 MINUS SIGN
  const colorClass = neutral ? '' : dir === 'gain' ? 'text-gain' : 'text-loss';

  return (
    <span
      className={cn('tabular-nums', colorClass, className)}
      aria-label={ariaLabel}
      data-testid="numeric"
      data-state={neutral ? 'neutral' : dir}
    >
      <span className={SLOT_CLASS} data-testid="numeric-slot">
        {sign}
      </span>
      {body}
    </span>
  );
}

/**
 * Numeric.Skeleton — the cell-shaped loading variant. Sized to the reserved slot +
 * a digit-width body so a numeric column does not collapse while loading (R4.4).
 * Carries the same reserved leading slot so there is no layout jump on resolve.
 */
function NumericSkeleton({ className }: { className?: string }) {
  return (
    <span className={cn('tabular-nums', className)} data-testid="numeric" data-state="loading">
      <span className={SLOT_CLASS} data-testid="numeric-slot" aria-hidden="true" />
      <Skeleton className="inline-block h-4 w-12 align-middle" data-testid="numeric-skeleton" />
    </span>
  );
}

Numeric.Skeleton = NumericSkeleton;

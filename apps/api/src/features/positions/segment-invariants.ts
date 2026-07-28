import Decimal from 'decimal.js';

// --- Cross-fill lifecycle invariants (design.md §Component 5) ---
//
// Single source of truth for the trade-validation invariants that were
// previously inline in `positions.service.ts` (evaluated against SQL
// aggregates). Extracted into pure predicates over an in-memory fill set so
// both the live services and the write-free CSV-import preview dry-run apply
// the SAME checks without forking.
//
// Pure module — NO HTTP/DB imports.

/**
 * An entry's running total plus a proposed new exit quantity would exceed the
 * available entry quantity. Decimal-exact (mirrors the live
 * `sumFillQuantityByType` comparison in `addFill`).
 */
export function exitWouldExceedEntry(
  entryTotal: string,
  exitTotal: string,
  newExitQty: string,
): boolean {
  const newExitTotal = new Decimal(exitTotal).plus(new Decimal(newExitQty));
  return newExitTotal.greaterThan(new Decimal(entryTotal));
}

/** A position has at least one entry fill (required to open). */
export function hasAtLeastOneEntry(entryCount: number): boolean {
  return entryCount > 0;
}

/**
 * Entry and exit totals reconcile (segment is flat). DECIMAL-EQUAL — a
 * deliberate, safe *widening* of the live raw-string `!==` close check
 * (`positions.service.ts` close reconcile): `"100"` and `"100.00000000"` are
 * string-unequal but decimal-equal. This is the correct semantics and the one
 * the import preview needs (its totals are sums of independently-normalized
 * strings of possibly different scale).
 */
export function reconciles(entryTotal: string, exitTotal: string): boolean {
  return new Decimal(entryTotal).equals(new Decimal(exitTotal));
}

/** Close timestamp is not before the open timestamp. */
export function closeNotBeforeOpen(
  openedAt: string | Date | null,
  closedAt: string | Date,
): boolean {
  if (openedAt === null) return true;
  return new Date(closedAt).getTime() >= new Date(openedAt).getTime();
}

/** Option quantity is a whole number of contracts. */
export function isWholeContracts(quantity: string): boolean {
  return new Decimal(quantity).isInteger();
}

// --- Composite (the preview calls this) ---

export interface InMemoryFill {
  type: 'entry' | 'exit';
  quantity: string;
  filledAt?: string | Date | null;
}

export interface ValidateSegmentOptions {
  assetType: 'stock' | 'option';
  closes: boolean;
  openedAt?: string | Date | null;
  closedAt?: string | Date | null;
}

export interface InvariantError {
  /** Index into the fills array, or null for a whole-segment error. */
  fillIndex: number | null;
  code:
    | 'EXIT_EXCEEDS_ENTRY'
    | 'EXIT_BEFORE_ENTRY'
    | 'OPTION_FRACTIONAL_QUANTITY'
    | 'SEGMENT_NOT_RECONCILED'
    | 'CLOSE_BEFORE_OPEN';
  message: string;
  /** Residual quantity for a whole-segment reconciliation failure. */
  residual?: string;
}

/**
 * Walk an ordered fill set applying the granular predicates incrementally:
 *  - whole-contracts (options) per fill;
 *  - an exit is never first / never exceeds the running entry total;
 *  - if `closes`, the whole-segment reconcile + close-not-before-open checks.
 *
 * The fills MUST already be in the segment's canonical (post-reorder) order —
 * the segmenter produces this order, and the commit replays it verbatim, so the
 * incremental checks here agree with the live services' per-fill checks.
 */
export function validateSegmentInvariants(
  fills: InMemoryFill[],
  opts: ValidateSegmentOptions,
): InvariantError[] {
  const errors: InvariantError[] = [];

  let entryTotal = new Decimal(0);
  let exitTotal = new Decimal(0);
  let entryCount = 0;

  fills.forEach((fill, index) => {
    if (opts.assetType === 'option' && !isWholeContracts(fill.quantity)) {
      errors.push({
        fillIndex: index,
        code: 'OPTION_FRACTIONAL_QUANTITY',
        message: 'Option quantity must be a whole number',
      });
    }

    if (fill.type === 'entry') {
      entryTotal = entryTotal.plus(new Decimal(fill.quantity));
      entryCount += 1;
    } else {
      // An exit before any entry can never reconcile and mirrors the live
      // "cannot add exit fill to a draft position" guard.
      if (!hasAtLeastOneEntry(entryCount)) {
        errors.push({
          fillIndex: index,
          code: 'EXIT_BEFORE_ENTRY',
          message: 'Cannot exit before an entry fill',
        });
      } else if (exitWouldExceedEntry(entryTotal.toString(), exitTotal.toString(), fill.quantity)) {
        errors.push({
          fillIndex: index,
          code: 'EXIT_EXCEEDS_ENTRY',
          message: 'Exit quantity would exceed available entry quantity',
        });
      }
      exitTotal = exitTotal.plus(new Decimal(fill.quantity));
    }
  });

  if (opts.closes) {
    if (!reconciles(entryTotal.toString(), exitTotal.toString())) {
      const residual = entryTotal.minus(exitTotal).toString();
      errors.push({
        fillIndex: null,
        code: 'SEGMENT_NOT_RECONCILED',
        message: 'Position must be fully exited to close (exit quantity ≠ entry quantity)',
        residual,
      });
    }

    if (
      opts.openedAt !== undefined &&
      opts.closedAt !== undefined &&
      opts.closedAt !== null &&
      !closeNotBeforeOpen(opts.openedAt ?? null, opts.closedAt)
    ) {
      errors.push({
        fillIndex: null,
        code: 'CLOSE_BEFORE_OPEN',
        message: 'Close date cannot precede open date',
      });
    }
  }

  return errors;
}

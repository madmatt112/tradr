import { Decimal } from 'decimal.js';

import { parseOccSymbol, type LocatedWarning } from '@tradr/shared';

import type { NormalizedRow } from './csv-normalize';

/**
 * Lifecycle lift — pure leaf module (no I/O, no clock). Runs between
 * `resolveContracts` and `segment` (design C12): lifts option rows a prior
 * step has tagged `lifecycleOutcome` out of the segmenter's input, consumes
 * the coded stock row a broker reports alongside an assignment or exercise,
 * and warns on one it cannot match.
 */

/** IBKR lifecycle codes this task classifies, keyed by token (design C12 table). */
const CODE_KIND: Record<string, 'assigned' | 'exercised' | 'unsupported'> = {
  A: 'assigned',
  EX: 'exercised',
  AEX: 'exercised',
  MEX: 'exercised',
  EP: 'unsupported',
  GEA: 'unsupported',
};

/**
 * Classify an `eventCode` cell, splitting on the `;` delimiter csv-contract
 * uses for multiple IBKR Notes/Codes in one cell. `unsupported` wins over
 * `assigned`/`exercised` when a cell carries both. Returns `undefined` for a
 * cell with no recognised lifecycle code (AC 10.1).
 */
export function classifyEventCode(
  cell: string,
): 'assigned' | 'exercised' | 'unsupported' | undefined {
  const kinds = cell
    .split(';')
    .map((token) => CODE_KIND[token.trim().toUpperCase()])
    .filter((kind): kind is 'assigned' | 'exercised' | 'unsupported' => kind !== undefined);
  if (kinds.includes('unsupported')) {
    return 'unsupported';
  }
  return kinds[0];
}

/** One lifted lifecycle event, lined up with the row that tagged it. */
export interface LifecycleEvent {
  rowNumber: number;
  outcome: 'assigned' | 'exercised' | 'unsupported';
  symbol: string;
  quantity: string;
  date: string;
  fee: string;
}

/** Result of {@link liftLifecycleEvents}: surviving rows, lifted events and located warnings. */
export interface LiftResult {
  rows: NormalizedRow[];
  events: LifecycleEvent[];
  warnings: LocatedWarning[];
}

/** The UTC calendar day (`YYYY-MM-DD`) an ISO timestamp falls on. */
function utcDay(isoDateTime: string): string {
  return new Date(isoDateTime).toISOString().slice(0, 10);
}

/**
 * A coded stock row matches an event when it names the same underlying, falls
 * on the same UTC day, carries contracts × 100 shares, and prices at the
 * option's strike (design D16).
 */
function matches(
  event: LifecycleEvent,
  eventStrike: Decimal,
  eventUnderlying: string,
  stock: NormalizedRow,
): boolean {
  if (stock.values.symbol.trim().toUpperCase() !== eventUnderlying) {
    return false;
  }
  if (utcDay(stock.values.filledAt) !== utcDay(event.date)) {
    return false;
  }
  if (!new Decimal(stock.values.quantity).equals(new Decimal(event.quantity).times(100))) {
    return false;
  }
  return new Decimal(stock.values.price).equals(eventStrike);
}

/**
 * Lift tagged option rows into events and consume the coded stock row each
 * settles against; an unmatched coded stock row stays and warns (AC 10.4,
 * 10.5). A stock row consumes at most one event, and each event is consumed
 * by at most one stock row.
 */
export function liftLifecycleEvents(rows: NormalizedRow[]): LiftResult {
  const events: LifecycleEvent[] = [];
  const eventMeta: { strike: Decimal; underlying: string; consumed: boolean }[] = [];
  const remaining: NormalizedRow[] = [];
  const warnings: LocatedWarning[] = [];

  for (const row of rows) {
    if (row.values.assetType === 'option' && row.lifecycleOutcome !== undefined) {
      const parsed = parseOccSymbol(row.values.symbol);
      if (!parsed.ok) {
        // csv-contract already validated this symbol before tagging the row;
        // unreachable in practice, but keep the row rather than crash.
        remaining.push(row);
        continue;
      }
      events.push({
        rowNumber: row.sourceRow,
        outcome: row.lifecycleOutcome,
        symbol: row.values.symbol,
        quantity: row.values.quantity,
        date: row.values.filledAt,
        fee: row.values.fees,
      });
      eventMeta.push({
        strike: new Decimal(parsed.value.strike),
        underlying: parsed.value.underlying,
        consumed: false,
      });
      continue;
    }

    if (
      row.values.assetType === 'stock' &&
      classifyEventCode(row.values.eventCode ?? '') !== undefined
    ) {
      const matchIndex = eventMeta.findIndex(
        (meta, index) =>
          !meta.consumed && matches(events[index], meta.strike, meta.underlying, row),
      );
      if (matchIndex !== -1) {
        eventMeta[matchIndex].consumed = true;
        events[matchIndex].fee = new Decimal(events[matchIndex].fee)
          .plus(row.values.fees)
          .toString();
        continue;
      }
      warnings.push({
        rowNumber: row.sourceRow,
        kind: 'lifecycle_basis_excludes_premium',
        message: `Row ${row.sourceRow} carries a lifecycle code but matches no option event; its basis excludes the option premium.`,
      });
      remaining.push(row);
      continue;
    }

    remaining.push(row);
  }

  return { rows: remaining, events, warnings };
}

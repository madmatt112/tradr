/**
 * Pure aggregation + heuristic helpers for the tax-summary endpoint.
 *
 * No DB access. No I/O. All math via `Decimal`. The caller (the service in
 * Task 13) injects the logger so OCC-parse failures can be surfaced with the
 * request-scoped fields (requestId / userId).
 *
 * Reference: design.md §Component 4; requirements.md §4.4, §4.5, §4.6, §4.7,
 * §4.11.
 */
import { Decimal } from 'decimal.js';

import type { CandidatePositionRow, RealisedPositionRow } from './expenses.query';

// ---------------------------------------------------------------------------
// Local flag types — mirror the shapes in `TaxSummaryResponseSchema` (Task 2)
// but with native `Date | string` for the timestamp fields so the helpers can
// run before the response is serialised. The service stringifies before
// emission.
// ---------------------------------------------------------------------------

export type WashSaleFlag = {
  positionId: string;
  symbol: string;
  underlying: string | null;
  side: 'long' | 'short';
  openedAt: Date | string;
  /** Null when the loss was realized on a position that is still open. */
  closedAt: Date | string | null;
  /** The instant the loss was realized — what the ±30d window is anchored on. */
  realisedAt: Date | string;
  realisedLoss: string;
  reason: 'repurchase_within_30_days' | 'held_open_in_30d_window';
  counterpartyPositionIds: string[];
};

export type SuperficialLossFlag = WashSaleFlag;

// ---------------------------------------------------------------------------
// Logger contract — minimal surface so callers can pass any pino-style logger.
// ---------------------------------------------------------------------------

type Logger = { warn: (obj: object) => void };

// ---------------------------------------------------------------------------
// 1. Per-currency realised P&L aggregation
// ---------------------------------------------------------------------------

/**
 * Group `rows` by `currency`, sum the signed `realisedPnl` via `Decimal`.
 * Empty input returns an empty `Map`.
 */
export function aggregatePerCurrencyRealisedPnl(rows: RealisedPositionRow[]): Map<string, Decimal> {
  const out = new Map<string, Decimal>();
  for (const row of rows) {
    const current = out.get(row.currency) ?? new Decimal(0);
    out.set(row.currency, current.plus(new Decimal(row.realisedPnl)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. US short-term / long-term hold-period classification (Req 4.4)
// ---------------------------------------------------------------------------

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const THREE_HUNDRED_SIXTY_FIVE_DAYS_MS = 365 * ONE_DAY_MS;
const THIRTY_DAYS_MS = 30 * ONE_DAY_MS;

/**
 * Partition each row by `(closedAt − openedAt) ≤ 365 days` (INCLUSIVE) into
 * `shortTerm`, the strict-greater bucket into `longTerm`. Both maps key by
 * `currency` and accumulate signed `realisedPnl`. Rows with a null `closedAt`
 * cannot have a realised P&L row in the first place — the query (Task 7.2)
 * only emits closed-position rows — but we defensively skip them.
 */
export function classifyUSHoldPeriod(rows: RealisedPositionRow[]): {
  shortTerm: Map<string, Decimal>;
  longTerm: Map<string, Decimal>;
} {
  const shortTerm = new Map<string, Decimal>();
  const longTerm = new Map<string, Decimal>();

  for (const row of rows) {
    if (row.closedAt === null) continue;
    const held = new Date(row.closedAt).getTime() - new Date(row.openedAt).getTime();
    const bucket = held <= THREE_HUNDRED_SIXTY_FIVE_DAYS_MS ? shortTerm : longTerm;
    const current = bucket.get(row.currency) ?? new Decimal(0);
    bucket.set(row.currency, current.plus(new Decimal(row.realisedPnl)));
  }

  return { shortTerm, longTerm };
}

// ---------------------------------------------------------------------------
// 3. Year-end spot conversion with partial-degradation metadata (Req 4.5)
// ---------------------------------------------------------------------------

/**
 * Convert per-currency totals into a single `displayCurrency` aggregate.
 *
 * `rates` is keyed as `` `${currency}->${displayCurrency}` ``. The aggregate
 * EXCLUDES any currency whose rate is missing (Req 3.5, 4.5.4) — those are
 * surfaced via `excludedCurrencies` and `missingPairs`. When `displayCurrency`
 * is `null`, returns `{ aggregate: null, ... }` — there is no display target.
 *
 * The aggregate is returned as a raw `Decimal`; the service rounds to the
 * display currency's minor units before emitting strings.
 */
export function applyYearEndSpotConversion(
  perCurrencyTotals: Map<string, Decimal>,
  displayCurrency: string | null,
  rates: Map<string, Decimal>,
): {
  aggregate: Decimal | null;
  convertedCurrencies: string[];
  excludedCurrencies: string[];
  missingPairs: Array<{ base: string; quote: string }>;
} {
  if (displayCurrency === null) {
    return {
      aggregate: null,
      convertedCurrencies: [],
      excludedCurrencies: [],
      missingPairs: [],
    };
  }

  let aggregate = new Decimal(0);
  const convertedCurrencies: string[] = [];
  const excludedCurrencies: string[] = [];
  const missingPairs: Array<{ base: string; quote: string }> = [];

  for (const [currency, amount] of perCurrencyTotals) {
    if (currency === displayCurrency) {
      aggregate = aggregate.plus(amount);
      continue;
    }
    const rate = rates.get(`${currency}->${displayCurrency}`);
    if (rate !== undefined) {
      aggregate = aggregate.plus(amount.times(rate));
      convertedCurrencies.push(currency);
    } else {
      excludedCurrencies.push(currency);
      missingPairs.push({ base: currency, quote: displayCurrency });
    }
  }

  return { aggregate, convertedCurrencies, excludedCurrencies, missingPairs };
}

// ---------------------------------------------------------------------------
// Internal helpers for the wash-sale / superficial-loss heuristics
// ---------------------------------------------------------------------------

type ParseUnderlying = (symbol: string) => string | null;

type KeyedCandidate = CandidatePositionRow & { matchKey: string };

/**
 * UTC `YYYY-MM-DD` bucket for the same-day-reopen exclusion (Req 1.10 / 4.6).
 */
function utcDateBucket(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().slice(0, 10);
}

/**
 * Partition candidates by `assetType` and compute each one's match key
 * (stock → `symbol`; option → `parseUnderlying(symbol)`). Candidates whose
 * parser returns `null` are skipped + logged (Req 4.11).
 */
function keyCandidates(
  candidates: CandidatePositionRow[],
  parseUnderlying: ParseUnderlying,
  log: Logger,
): { stock: KeyedCandidate[]; option: KeyedCandidate[] } {
  const stock: KeyedCandidate[] = [];
  const option: KeyedCandidate[] = [];
  for (const c of candidates) {
    if (c.assetType === 'stock') {
      stock.push({ ...c, matchKey: c.symbol });
    } else {
      const underlying = parseUnderlying(c.symbol);
      if (underlying === null) {
        log.warn({ positionId: c.positionId, reason: 'occ_parse_failure' });
        continue;
      }
      option.push({ ...c, matchKey: underlying });
    }
  }
  return { stock, option };
}

/**
 * Compute the match key for a losing position. On `option` with a parser-null,
 * logs and returns `null` so the caller skips this loss (cannot match anyone).
 */
function keyLoss(
  loss: RealisedPositionRow,
  parseUnderlying: ParseUnderlying,
  log: Logger,
): string | null {
  if (loss.assetType === 'stock') return loss.symbol;
  const underlying = parseUnderlying(loss.symbol);
  if (underlying === null) {
    log.warn({ positionId: loss.positionId, reason: 'occ_parse_failure' });
    return null;
  }
  return underlying;
}

/**
 * The shared wash-sale / superficial-loss candidate filter, parameterised on
 * the CRA "still-open-at-+30d" rule. Returns `{ matched, anyOpenedInWindow }`
 * so the caller can pick the `reason` enum without re-scanning.
 */
function findMatchingCandidates(
  loss: RealisedPositionRow,
  matchKey: string,
  candidates: KeyedCandidate[],
  opts: { requireStillOpenAt: Date | null },
): { matched: KeyedCandidate[]; anyOpenedInWindow: boolean } {
  // Anchored on the REALIZATION date, not the close date. Under staged exits a
  // position realizes on several dates while `closedAt` is a single, possibly
  // much later, instant — and for a position still open it is null, which used
  // to make the whole loss invisible here.
  const realisedAtMs = new Date(loss.realisedAt).getTime();
  const windowStartMs = realisedAtMs - THIRTY_DAYS_MS;
  const windowEndMs = realisedAtMs + THIRTY_DAYS_MS;
  const lossDayBucket = utcDateBucket(loss.realisedAt);
  const stillOpenAtMs = opts.requireStillOpenAt ? opts.requireStillOpenAt.getTime() : null;

  const matched: KeyedCandidate[] = [];
  let anyOpenedInWindow = false;

  for (const c of candidates) {
    if (c.matchKey !== matchKey) continue;
    if (c.positionId === loss.positionId) continue;
    if (c.side !== loss.side) continue;

    const openedAtMs = c.openedAt ? new Date(c.openedAt).getTime() : null;
    const closedAtMsCandidate = c.closedAt ? new Date(c.closedAt).getTime() : null;

    // Same-day re-open exclusion (UTC-bucketed).
    if (c.openedAt && utcDateBucket(c.openedAt) === lossDayBucket) continue;

    const openedInWindow =
      openedAtMs !== null && openedAtMs >= windowStartMs && openedAtMs <= windowEndMs;

    // Held-open-through-pre-close-window: opened before windowStart AND
    // (still open OR closed after windowStart). Mirrors the SQL in
    // `listCandidatePositionsByYear` and the Req 4.6 text.
    const heldOpenThroughWindow =
      openedAtMs !== null &&
      openedAtMs < windowStartMs &&
      (closedAtMsCandidate === null || closedAtMsCandidate > windowStartMs);

    if (!openedInWindow && !heldOpenThroughWindow) continue;

    // CRA superficial-loss extra rule: still open at loss.closedAt + 30d.
    if (stillOpenAtMs !== null) {
      const stillOpen = closedAtMsCandidate === null || closedAtMsCandidate > stillOpenAtMs;
      if (!stillOpen) continue;
    }

    matched.push(c);
    if (openedInWindow) anyOpenedInWindow = true;
  }

  return { matched, anyOpenedInWindow };
}

// ---------------------------------------------------------------------------
// 4. US wash-sale flag heuristic (Req 4.6)
// ---------------------------------------------------------------------------

/**
 * Emit one `WashSaleFlag` per losing position that has ≥1 matching candidate.
 *
 * Partitions by `assetType` first — a stock-loss never matches an option
 * candidate, even when their match keys coincide (post-review fix #7). The
 * `reason` is `'repurchase_within_30_days'` when ANY matched candidate was
 * opened inside the ±30d window of `loss.closedAt`; otherwise
 * `'held_open_in_30d_window'`. `counterpartyPositionIds` always contains every
 * matched candidate, regardless of which reason was selected (v3-8).
 */
export function findWashSaleFlags(
  losingPositions: RealisedPositionRow[],
  candidates: CandidatePositionRow[],
  parseUnderlying: ParseUnderlying,
  log: Logger,
): WashSaleFlag[] {
  if (losingPositions.length === 0) return [];

  const { stock, option } = keyCandidates(candidates, parseUnderlying, log);
  const flags: WashSaleFlag[] = [];

  for (const loss of losingPositions) {
    // No `closedAt === null` skip: a position can hold a realized loss while
    // still open (Req 9), and skipping those hid them from detection entirely.
    const matchKey = keyLoss(loss, parseUnderlying, log);
    if (matchKey === null) continue;
    const pool = loss.assetType === 'stock' ? stock : option;

    const { matched, anyOpenedInWindow } = findMatchingCandidates(loss, matchKey, pool, {
      requireStillOpenAt: null,
    });
    if (matched.length === 0) continue;

    flags.push({
      positionId: loss.positionId,
      symbol: loss.symbol,
      underlying: loss.assetType === 'option' ? matchKey : null,
      side: loss.side,
      openedAt: loss.openedAt,
      closedAt: loss.closedAt,
      realisedAt: loss.realisedAt,
      realisedLoss: loss.realisedPnl,
      reason: anyOpenedInWindow ? 'repurchase_within_30_days' : 'held_open_in_30d_window',
      counterpartyPositionIds: matched.map((c) => c.positionId),
    });
  }

  return flags;
}

// ---------------------------------------------------------------------------
// 5. CA superficial-loss flag heuristic (Req 4.7)
// ---------------------------------------------------------------------------

/**
 * Same matching contract as `findWashSaleFlags` plus the CRA-specific rule:
 * the candidate must still be open at `loss.closedAt + 30 days`
 * (`candidate.closedAt === null || candidate.closedAt > closedAt + 30d`).
 */
export function findSuperficialLossFlags(
  losingPositions: RealisedPositionRow[],
  candidates: CandidatePositionRow[],
  parseUnderlying: ParseUnderlying,
  log: Logger,
): SuperficialLossFlag[] {
  if (losingPositions.length === 0) return [];

  const { stock, option } = keyCandidates(candidates, parseUnderlying, log);
  const flags: SuperficialLossFlag[] = [];

  for (const loss of losingPositions) {
    const matchKey = keyLoss(loss, parseUnderlying, log);
    if (matchKey === null) continue;
    const pool = loss.assetType === 'stock' ? stock : option;
    // CRA's "still held 30 days after" runs from the realization, same as above.
    const stillOpenAt = new Date(new Date(loss.realisedAt).getTime() + THIRTY_DAYS_MS);

    const { matched, anyOpenedInWindow } = findMatchingCandidates(loss, matchKey, pool, {
      requireStillOpenAt: stillOpenAt,
    });
    if (matched.length === 0) continue;

    flags.push({
      positionId: loss.positionId,
      symbol: loss.symbol,
      underlying: loss.assetType === 'option' ? matchKey : null,
      side: loss.side,
      openedAt: loss.openedAt,
      closedAt: loss.closedAt,
      realisedAt: loss.realisedAt,
      realisedLoss: loss.realisedPnl,
      reason: anyOpenedInWindow ? 'repurchase_within_30_days' : 'held_open_in_30d_window',
      counterpartyPositionIds: matched.map((c) => c.positionId),
    });
  }

  return flags;
}

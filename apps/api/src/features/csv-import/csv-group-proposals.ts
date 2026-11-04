import { Decimal } from 'decimal.js';

import {
  detectStrategyLabel,
  legUnderlying,
  MAX_GROUP_LEGS,
  validateLegSet,
  type GroupProposal,
  type LocatedWarning,
  type StrategyLeg,
} from '@tradr/shared';

import type { ExecFill, Segment } from './csv-segment';

/**
 * Group proposer — pure leaf module (no HTTP, no DB).
 *
 * Proposes {@link GroupProposal}s for the import preview from already-built
 * {@link Segment}s (design Component 10, Requirement 8):
 *
 *  - Pass 1 groups segments whose opening fill shares a non-empty order id,
 *    any asset type included (AC 8.3). A one-segment order id proposes
 *    nothing.
 *  - Pass 2 takes option segments with no order id, skips a `dateOnly`
 *    opening fill (AC 8.5), and buckets the rest by underlying, total entry
 *    quantity and trade date in the import timezone. Within a bucket it
 *    chains consecutive opening fills while the gap to the previous one is
 *    at most five minutes; a chain of two or more is a proposal (AC 8.4). A
 *    stock segment never enters pass 2 (AC 8.6).
 *  - A proposal failing `validateLegSet` or the {@link MAX_GROUP_LEGS} cap is
 *    dropped with a `group_proposal_dropped` warning at its lowest source
 *    row; a date-only skip adds exactly one `group_heuristic_skipped`
 *    warning per import. Neither warning ever quotes the order id (AC 8.11).
 */

const FIVE_MINUTES_MS = 5 * 60 * 1000;

export interface ProposeGroupsResult {
  proposals: GroupProposal[];
  warnings: LocatedWarning[];
}

/** A segment's opening fill: always its first execution (csv-segment.ts). */
function openingFill(segment: Segment): ExecFill {
  return segment.executions[0];
}

function legMeta(segment: Segment): { symbol: string; assetType: 'stock' | 'option' } {
  return { symbol: segment.scope.symbol, assetType: segment.scope.assetType as 'stock' | 'option' };
}

/** Sum of a segment's fills of one lifecycle role, as a {@link Decimal}. */
function sumQuantity(segment: Segment, type: ExecFill['type']): Decimal {
  return segment.executions
    .filter((fill) => fill.type === type)
    .reduce((sum, fill) => sum.plus(new Decimal(fill.quantity)), new Decimal(0));
}

/**
 * Enough of a {@link StrategyLeg} to drive `detectStrategyLabel`, which uses
 * only `symbol`, `side`, `assetType` and `entryQty` — `entryCost`/`entryFees`
 * are unused there, so they are not computed.
 */
function toStrategyLeg(segment: Segment): StrategyLeg {
  return {
    symbol: segment.scope.symbol,
    side: segment.side,
    assetType: segment.scope.assetType as 'stock' | 'option',
    entryQty: sumQuantity(segment, 'entry').toFixed(),
    exitQty: sumQuantity(segment, 'exit').toFixed(),
    entryCost: '0',
    entryFees: '0',
  };
}

/** Builds a proposal from candidate segment indices, or drops it with a warning. */
function buildOrDrop(
  indices: number[],
  segments: Segment[],
  basis: GroupProposal['basis'],
  warnings: LocatedWarning[],
): GroupProposal | null {
  const legRefs = [...indices].sort((a, b) => a - b);
  const lowestRow = Math.min(...legRefs.map((i) => openingFill(segments[i]).sourceRow));

  if (legRefs.length > MAX_GROUP_LEGS) {
    warnings.push({
      rowNumber: lowestRow,
      kind: 'group_proposal_dropped',
      message: `Proposed group of ${legRefs.length} legs exceeds the ${MAX_GROUP_LEGS}-leg limit and was dropped.`,
    });
    return null;
  }

  const fault = validateLegSet(legRefs.map((i) => legMeta(segments[i])));
  if (fault) {
    warnings.push({
      rowNumber: lowestRow,
      kind: 'group_proposal_dropped',
      message: `Proposed group was dropped: ${fault.message}`,
    });
    return null;
  }

  const label = detectStrategyLabel(legRefs.map((i) => toStrategyLeg(segments[i])));
  return { id: `gp-${lowestRow}`, legRefs, label, basis };
}

// ---------------------------------------------------------------------------
// Pass 1 — order id (AC 8.3)
// ---------------------------------------------------------------------------

function proposeByOrderId(segments: Segment[], warnings: LocatedWarning[]): GroupProposal[] {
  const byOrderId = new Map<string, number[]>();
  segments.forEach((segment, index) => {
    const orderId = openingFill(segment).orderId;
    if (!orderId) return;
    const bucket = byOrderId.get(orderId) ?? [];
    bucket.push(index);
    byOrderId.set(orderId, bucket);
  });

  const proposals: GroupProposal[] = [];
  for (const indices of byOrderId.values()) {
    if (indices.length < 2) continue; // a one-segment order id proposes nothing
    const proposal = buildOrDrop(indices, segments, 'order_id', warnings);
    if (proposal) proposals.push(proposal);
  }
  return proposals;
}

// ---------------------------------------------------------------------------
// Pass 2 — heuristic chaining (AC 8.4, 8.6)
// ---------------------------------------------------------------------------

interface Candidate {
  index: number;
  openingAt: number;
  bucketKey: string;
}

/** The candidate's trade date in the import timezone (`en-CA` -> YYYY-MM-DD). */
function tradeDateInTimezone(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(iso));
}

function proposeByHeuristic(
  segments: Segment[],
  timezone: string,
  warnings: LocatedWarning[],
): GroupProposal[] {
  const candidates: Candidate[] = [];
  let anySkipped = false;

  segments.forEach((segment, index) => {
    if (segment.scope.assetType !== 'option') return; // a stock segment never enters pass 2
    const fill = openingFill(segment);
    if (fill.orderId) return; // pass 2 is for segments with no order id only
    if (fill.dateOnly) {
      anySkipped = true;
      return;
    }
    const underlying = legUnderlying(legMeta(segment));
    if (underlying === null) return;

    candidates.push({
      index,
      openingAt: Date.parse(fill.filledAt),
      bucketKey: `${underlying}|${sumQuantity(segment, 'entry').toFixed()}|${tradeDateInTimezone(fill.filledAt, timezone)}`,
    });
  });

  if (anySkipped) {
    warnings.push({
      kind: 'group_heuristic_skipped',
      message:
        'One or more segments were skipped from automatic group proposal because their opening fill has no time.',
    });
  }

  const buckets = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const bucket = buckets.get(candidate.bucketKey) ?? [];
    bucket.push(candidate);
    buckets.set(candidate.bucketKey, bucket);
  }

  const proposals: GroupProposal[] = [];
  for (const bucket of buckets.values()) {
    const sorted = [...bucket].sort((a, b) => a.openingAt - b.openingAt || a.index - b.index);
    let chainStart = 0;
    for (let i = 1; i <= sorted.length; i++) {
      const endOfChain =
        i === sorted.length || sorted[i].openingAt - sorted[i - 1].openingAt > FIVE_MINUTES_MS;
      if (!endOfChain) continue;
      const chain = sorted.slice(chainStart, i);
      if (chain.length >= 2) {
        const proposal = buildOrDrop(
          chain.map((c) => c.index),
          segments,
          'inferred',
          warnings,
        );
        if (proposal) proposals.push(proposal);
      }
      chainStart = i;
    }
  }

  return proposals;
}

// ---------------------------------------------------------------------------

/** Proposes import groups from segmented rows (design Component 10). */
export function proposeGroups(segments: Segment[], timezone: string): ProposeGroupsResult {
  const warnings: LocatedWarning[] = [];
  const proposals = [
    ...proposeByOrderId(segments, warnings),
    ...proposeByHeuristic(segments, timezone, warnings),
  ];
  return { proposals, warnings };
}

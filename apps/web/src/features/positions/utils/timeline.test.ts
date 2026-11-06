// node — pure function, no DOM.
//
// Contract block — one row per success criterion this file covers (task 25).
//
// | Criterion | Pre-condition | Call (seam) | Observable result | Source of expected value |
// |---|---|---|---|---|
// | Merge in date order | one fill, one settlement, one roll leg and one entry-Greeks capture, each on a different date, given to buildTimeline out of chronological order | buildTimeline(position) | the returned entries come back ascending by date: greeks, roll, settlement, fill, matching the kind set given | task 25 Success ("fills, a settlement, a roll and Greeks merge in date order"); dates fixed in this test |
// | Ties keep a stable order | two fills sharing one exact `filledAt` | buildTimeline(position) with the pair in each of the two possible array orders | each call's output preserves that call's input order (fill-a before fill-b, then fill-b before fill-a) | task 25 Success ("ties keep a stable order") |
// | No settlement, no settlement entry | one fill and an empty (or absent) `settlements` list — the unsettled state (AC 8.2) | buildTimeline(position) | the returned entries hold no `kind: 'settlement'` entry; the fill entry still appears | requirements.md AC 8.2 ("its record and timeline entry SHALL go"); task 25 Success |
import { describe, expect, it } from 'vitest';

import type { EntryGreeksDetail, Fill, PositionSettlementDetail, RollChain } from '@tradr/shared';

import { buildTimeline } from './timeline';

function makeFill(overrides: Partial<Fill> = {}): Fill {
  return {
    id: 'fill-1',
    positionId: 'pos-1',
    type: 'entry',
    price: '150.00000000',
    quantity: '1.00000000',
    fees: '0.00000000',
    notes: null,
    filledAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSettlement(
  overrides: Partial<PositionSettlementDetail> = {},
): PositionSettlementDetail {
  return {
    settlementId: 'settlement-1',
    outcome: 'assigned',
    premium: 120,
    quantity: 1,
    settledAt: '2026-03-01T00:00:00.000Z',
    createdAt: '2026-03-01T00:00:00.000Z',
    role: 'leg',
    legPositionId: 'leg-1',
    stockPositionIds: ['stock-1'],
    ...overrides,
  };
}

function makeRollChain(overrides: Partial<RollChain> = {}): RollChain {
  return {
    legs: [
      {
        positionId: 'leg-rolled',
        symbol: 'AAPL  260201C00150000',
        rolledAt: '2026-02-01T00:00:00.000Z',
      },
    ],
    netCredit: 500,
    ...overrides,
  };
}

function makeGreeks(overrides: Partial<EntryGreeksDetail> = {}): EntryGreeksDetail {
  return {
    delta: 0.5,
    gamma: 0.1,
    thetaPerDay: -0.02,
    vegaPerPct: 0.03,
    rhoPerPct: null,
    source: 'black_scholes',
    volatility: 0.3,
    spot: 150,
    rate: 0.04,
    dividendYield: null,
    capturedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildTimeline', () => {
  it('merges a fill, a settlement, a roll leg and an entry-Greeks capture in ascending date order', () => {
    const fill = makeFill({ id: 'fill-1', filledAt: '2026-04-01T00:00:00.000Z' });
    const settlement = makeSettlement({
      settlementId: 'settlement-1',
      settledAt: '2026-03-01T00:00:00.000Z',
    });
    const rollChain = makeRollChain({
      legs: [{ positionId: 'leg-rolled', symbol: 'AAPL', rolledAt: '2026-02-01T00:00:00.000Z' }],
    });
    const entryGreeks = makeGreeks({ capturedAt: '2026-01-01T00:00:00.000Z' });

    const result = buildTimeline({
      fills: [fill],
      settlements: [settlement],
      rollChain,
      entryGreeks,
    });

    expect(result.map((e) => e.kind)).toEqual(['greeks', 'roll', 'settlement', 'fill']);
    expect(result.map((e) => e.date)).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
      '2026-04-01T00:00:00.000Z',
    ]);
  });

  it('keeps ties in the input order, whichever order they are given in', () => {
    const fillA = makeFill({ id: 'fill-a', filledAt: '2026-06-01T00:00:00.000Z' });
    const fillB = makeFill({ id: 'fill-b', filledAt: '2026-06-01T00:00:00.000Z' });

    const forward = buildTimeline({ fills: [fillA, fillB] });
    const reversed = buildTimeline({ fills: [fillB, fillA] });

    expect(forward.map((e) => (e.kind === 'fill' ? e.fill.id : null))).toEqual([
      'fill-a',
      'fill-b',
    ]);
    expect(reversed.map((e) => (e.kind === 'fill' ? e.fill.id : null))).toEqual([
      'fill-b',
      'fill-a',
    ]);
  });

  it('shows no settlement entry when the position carries no settlement', () => {
    const fill = makeFill({ id: 'fill-c', filledAt: '2026-07-01T00:00:00.000Z' });

    const withEmptyList = buildTimeline({ fills: [fill], settlements: [] });
    const withNoKey = buildTimeline({ fills: [fill] });

    for (const result of [withEmptyList, withNoKey]) {
      expect(result.some((e) => e.kind === 'settlement')).toBe(false);
      expect(result).toHaveLength(1);
      expect(result[0].kind).toBe('fill');
    }
  });
});

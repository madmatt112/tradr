// Contract, per success criterion (task 3, "Add the wire shapes"):
//
// - 1.1 list+leg:  pre: a list-item-shaped body.                 call: PositionListItemSchema.safeParse / PositionGroupLegSchema.safeParse (includes `pastExpiryUnsettled`). observed: `data.pastExpiryUnsettled === true`.          source: design C2.
// - 1.1 detail:    pre: a detail-shaped body.                    call: PositionDetailSchema.safeParse (includes `pastExpiryUnsettled`).                                  observed: `data.pastExpiryUnsettled === true`.          source: design C2.
// - 1.3:           pre: a group-entry-shaped body.                call: PositionGroupEntrySchema.safeParse (includes `pastExpiryLegCount`).                               observed: `data.pastExpiryLegCount === 2`.             source: design C2, Req 1.3.
// - 2.1/2.5/2.6:   pre: a settle body carrying only `outcome`.     call: SettleLegInputSchema.safeParse.                                                                     observed: `success === true` for each of the 3 outcomes; `quantity`/`fees`/`settledAt`/`stockRowOrder` are absent from `data`. source: design C3 `SettleLegInput`, Req 2.1/2.5/2.6.
// - Success (settle refusal): pre: an unknown outcome, then an extra key.  call: SettleLegInputSchema.safeParse.                                                                observed: `success === false` for both.               source: task 3 Success line.
// - 5.1:           pre: a complete roll body.                     call: RollLegInputSchema.safeParse.                                                                       observed: `success === true`.                          source: design C6 `RollLegInput`, Req 5.1.
// - Success (roll refusal):   pre: the same body minus `rolledAt`. call: RollLegInputSchema.safeParse.                                                                       observed: `success === false`.                         source: task 3 Success line.
// - 6.1:           pre: a black_scholes capture with all 4 fields. call: CaptureEntryGreeksInputSchema.safeParse.                                                            observed: `success === true`.                          source: design C7, Req 6.1.
// - Success (bs refusal):     pre: the same body minus `volatility`. call: CaptureEntryGreeksInputSchema.safeParse.                                                           observed: `success === false`.                         source: task 3 Success line.
// - 6.2:           pre: a bare `{ source: 'chain' }` body.         call: CaptureEntryGreeksInputSchema.safeParse.                                                            observed: `success === true`.                          source: design C7, Req 6.2.
// - Success (context): pre: a settlement-context body with `suggestedOutcome: null`. call: SettlementContextSchema.safeParse.                                                 observed: `success === true`.                          source: design Data Models, `SettlementContext`.
// - Success (chain):   pre: a roll-chain body, one leg, `netCredit` set.             call: RollChainSchema.safeParse.                                                         observed: `success === true`.                          source: design Data Models, `detail.rollChain`.
// - Success (detail):  pre: a settlement-detail element with `legPositionId`/`stockPositionIds`. call: PositionSettlementDetailSchema.safeParse.                                observed: `success === true`.                          source: design Data Models, `detail.settlements[]`.
// - Success (performance): pre: a performance body with `pastExpiryUnsettledLegs: 0`, then with the key absent. call: PerformanceResponseSchema.safeParse.                    observed: `success === false` then `success === true`. source: design C2, task 3 Success line.
// - (Data Models completeness, beyond the Success line's named checks, per the
//   Test: line's "safeParse on each input and response schema"):
//   SettlementResult, RollResult, and `detail.entryGreeks` (`rhoPerPct` nullable)
//   each get one parse check against the design's exact shape.

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CaptureEntryGreeksInputSchema,
  EntryGreeksDetailSchema,
  PositionSettlementDetailSchema,
  RollChainSchema,
  RollLegInputSchema,
  RollResultSchema,
  SettleLegInputSchema,
  SettlementContextSchema,
  SettlementResultSchema,
} from './option-lifecycle';
import { PerformanceResponseSchema } from './performance';
import { PositionDetailSchema, PositionGroupEntrySchema, PositionGroupLegSchema } from './position';

const baseListItem = {
  id: randomUUID(),
  userId: randomUUID(),
  accountId: randomUUID(),
  symbol: 'AAPL260116C150',
  side: 'short',
  assetType: 'option',
  status: 'open',
  notes: null,
  openedAt: '2026-01-01T00:00:00.000Z',
  closedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  accountName: 'Main',
  accountCurrency: 'USD',
  accountTimezone: 'America/New_York',
  realizedPnl: null,
  returnPercentage: null,
  avgEntryPrice: 2.5,
  avgExitPrice: null,
  totalEntryQuantity: 1,
  totalExitQuantity: 0,
  brokerageName: null,
  grossPnl: null,
  brokerageFees: 0,
  netPnl: null,
  targetPrice: null,
  stopLoss: null,
  targetRR: null,
  actualRR: null,
  openUnits: 1,
  closedUnits: 0,
  openCostBasis: 250,
};

const baseDetail = {
  id: randomUUID(),
  userId: randomUUID(),
  accountId: randomUUID(),
  symbol: 'AAPL260116C150',
  side: 'short',
  assetType: 'option',
  status: 'open',
  notes: null,
  openedAt: '2026-01-01T00:00:00.000Z',
  closedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  accountTimezone: 'America/New_York',
  fills: [],
  avgEntryPrice: 2.5,
  avgExitPrice: null,
  totalEntryQuantity: 1,
  totalExitQuantity: 0,
  realizedPnl: null,
  returnPercentage: null,
  brokerageName: null,
  grossPnl: null,
  brokerageFees: 0,
  netPnl: null,
  targetPrice: null,
  stopLoss: null,
  targetRR: null,
  actualRR: null,
  openUnits: 1,
  closedUnits: 0,
  openCostBasis: 250,
};

const baseGroupEntry = () => ({
  kind: 'group' as const,
  id: randomUUID(),
  userId: randomUUID(),
  accountId: randomUUID(),
  accountName: 'Main',
  accountCurrency: 'USD',
  accountTimezone: 'America/New_York',
  underlying: 'AAPL',
  label: 'BCS',
  detectedLabel: 'BCS',
  labelOverride: null,
  status: 'open' as const,
  openedAt: '2026-01-01T00:00:00.000Z',
  closedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  tags: [],
  classification: null,
  netEntry: 300,
  grossPnl: null,
  netPnl: null,
  brokerageFees: 2.6,
  openCostBasis: 300,
  maxLoss: null,
  maxLossReason: null,
  legs: [
    { ...baseListItem, id: randomUUID(), groupId: randomUUID() },
    { ...baseListItem, id: randomUUID(), groupId: randomUUID() },
  ],
});

const performanceBody = (overrides: Record<string, unknown> = {}) => ({
  resolvedTimezone: 'UTC',
  resolvedWeekStartDay: 0,
  dataQuality: {
    timeframeExcluded: { total: 0, unsupported: 0, mismatch: 0 },
    historyExcluded: { total: 0, closed_at_null: 0 },
  },
  hasAnyAccounts: false,
  hasAnyClosedPositions: false,
  hasAnyClosedPositionsInSupportedCurrency: false,
  defaultCurrency: null,
  currencies: [],
  ...overrides,
});

describe('PositionListItemSchema / PositionGroupLegSchema pastExpiryUnsettled (Req 1.1)', () => {
  it('carries pastExpiryUnsettled on a list item and the group leg it extends', () => {
    const legResult = PositionGroupLegSchema.safeParse({
      ...baseListItem,
      groupId: randomUUID(),
      pastExpiryUnsettled: true,
    });
    expect(legResult.success).toBe(true);
    if (legResult.success) {
      expect(legResult.data.pastExpiryUnsettled).toBe(true);
    }
  });
});

describe('PositionDetailSchema pastExpiryUnsettled (Req 1.1)', () => {
  it('carries pastExpiryUnsettled on the detail read', () => {
    const result = PositionDetailSchema.safeParse({
      ...baseDetail,
      pastExpiryUnsettled: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pastExpiryUnsettled).toBe(true);
    }
  });
});

describe('PositionGroupEntrySchema pastExpiryLegCount (Req 1.3)', () => {
  it('carries its count of flagged legs', () => {
    const result = PositionGroupEntrySchema.safeParse({
      ...baseGroupEntry(),
      pastExpiryLegCount: 2,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pastExpiryLegCount).toBe(2);
    }
  });
});

describe('SettleLegInputSchema (Req 2.1, 2.5, 2.6)', () => {
  it.each(['worthless', 'assigned', 'exercised'] as const)(
    'parses a minimal body with only outcome %s, leaving quantity/fees/settledAt/stockRowOrder absent',
    (outcome) => {
      const result = SettleLegInputSchema.safeParse({ outcome });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.quantity).toBeUndefined();
        expect(result.data.fees).toBeUndefined();
        expect(result.data.settledAt).toBeUndefined();
        expect(result.data.stockRowOrder).toBeUndefined();
      }
    },
  );

  it('refuses an unknown outcome and refuses an extra key', () => {
    expect(SettleLegInputSchema.safeParse({ outcome: 'expired' }).success).toBe(false);
    expect(
      SettleLegInputSchema.safeParse({ outcome: 'worthless', notAField: true }).success,
    ).toBe(false);
  });
});

describe('RollLegInputSchema (Req 5.1)', () => {
  const completeRollBody = {
    newSymbol: 'AAPL260320C160',
    quantity: '1',
    closePrice: '1.50',
    openPrice: '2.00',
    closeFees: '0.65',
    openFees: '0.65',
    rolledAt: '2026-02-01T00:00:00.000Z',
  };

  it('parses a complete roll body', () => {
    expect(RollLegInputSchema.safeParse(completeRollBody).success).toBe(true);
  });

  it('refuses a roll body missing rolledAt', () => {
    const { rolledAt: _rolledAt, ...withoutRolledAt } = completeRollBody;
    void _rolledAt;
    expect(RollLegInputSchema.safeParse(withoutRolledAt).success).toBe(false);
  });
});

describe('CaptureEntryGreeksInputSchema (Req 6.1, 6.2)', () => {
  const completeBlackScholesBody = {
    source: 'black_scholes' as const,
    volatility: 0.35,
    spot: 150,
    rate: 0.05,
    dividendYield: 0.01,
  };

  it('parses a valid black_scholes capture', () => {
    expect(CaptureEntryGreeksInputSchema.safeParse(completeBlackScholesBody).success).toBe(true);
  });

  it('refuses a black_scholes capture without volatility', () => {
    const { volatility: _volatility, ...withoutVolatility } = completeBlackScholesBody;
    void _volatility;
    expect(CaptureEntryGreeksInputSchema.safeParse(withoutVolatility).success).toBe(false);
  });

  it('parses a bare chain capture', () => {
    expect(CaptureEntryGreeksInputSchema.safeParse({ source: 'chain' }).success).toBe(true);
  });
});

describe('SettlementContextSchema (design Data Models)', () => {
  it('parses a settlement context with suggestedOutcome null', () => {
    const result = SettlementContextSchema.safeParse({
      legalOutcomes: ['worthless', 'assigned'],
      expiryInstant: '2026-01-16T21:00:00.000Z',
      premium: 2.5,
      heldRows: [{ positionId: randomUUID(), symbol: 'AAPL', openUnits: 100, openedAt: null }],
      suggestedOutcome: null,
    });
    expect(result.success).toBe(true);
  });
});

describe('RollChainSchema (design Data Models, detail.rollChain)', () => {
  it('parses a chain with legs and one netCredit', () => {
    const result = RollChainSchema.safeParse({
      legs: [{ positionId: randomUUID(), symbol: 'AAPL260116P50', rolledAt: '2026-01-10T00:00:00.000Z' }],
      netCredit: 500,
    });
    expect(result.success).toBe(true);
  });
});

describe('PositionSettlementDetailSchema (design Data Models, detail.settlements[])', () => {
  it('parses a settlement detail element with legPositionId and stockPositionIds', () => {
    const result = PositionSettlementDetailSchema.safeParse({
      settlementId: randomUUID(),
      outcome: 'assigned',
      premium: 2.5,
      quantity: 1,
      settledAt: '2026-01-16T21:00:00.000Z',
      createdAt: '2026-01-16T21:00:01.000Z',
      role: 'leg',
      legPositionId: randomUUID(),
      stockPositionIds: [randomUUID()],
    });
    expect(result.success).toBe(true);
  });
});

describe('PerformanceResponseSchema pastExpiryUnsettledLegs (design C2)', () => {
  it('refuses pastExpiryUnsettledLegs 0 and parses with the key absent', () => {
    expect(
      PerformanceResponseSchema.safeParse(performanceBody({ pastExpiryUnsettledLegs: 0 })).success,
    ).toBe(false);
    expect(PerformanceResponseSchema.safeParse(performanceBody()).success).toBe(true);
  });
});

describe('SettlementResultSchema (design Data Models)', () => {
  it('parses a settlement result', () => {
    const result = SettlementResultSchema.safeParse({
      settlementId: randomUUID(),
      legId: randomUUID(),
      outcome: 'worthless',
      premium: 0,
      quantity: 1,
      settledAt: '2026-01-16T21:00:00.000Z',
      openedPositionIds: [],
      exitedPositionIds: [],
    });
    expect(result.success).toBe(true);
  });
});

describe('RollResultSchema (design Data Models)', () => {
  it('parses a roll result', () => {
    const result = RollResultSchema.safeParse({
      rollId: randomUUID(),
      chainId: randomUUID(),
      fromPositionId: randomUUID(),
      toPositionId: randomUUID(),
      newSymbol: 'AAPL260320C160',
    });
    expect(result.success).toBe(true);
  });
});

describe('EntryGreeksDetailSchema (design Data Models, detail.entryGreeks)', () => {
  it('parses a chain-sourced row with rhoPerPct null', () => {
    const result = EntryGreeksDetailSchema.safeParse({
      delta: 0.5,
      gamma: 0.02,
      thetaPerDay: -0.03,
      vegaPerPct: 0.1,
      rhoPerPct: null,
      source: 'chain',
      volatility: null,
      spot: null,
      rate: null,
      dividendYield: null,
      capturedAt: '2026-01-10T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });
});

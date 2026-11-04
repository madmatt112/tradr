import type { PositionGroupEntry, PositionGroupLeg, PositionListItem } from '@tradr/shared';

/**
 * Deterministic builder for PositionListItem used across web tests.
 *
 * Field set mirrors `PositionListItemSchema` in
 * `packages/shared/src/schemas/position.ts`. Default is a valid
 * `status: 'open'`, `assetType: 'stock'`, USD long stock position.
 *
 * Per-test overrides cover variant cases (closed, short, option, etc.).
 */
export const makePosition = (overrides: Partial<PositionListItem> = {}): PositionListItem => ({
  id: '00000000-0000-4000-a000-000000000001',
  userId: '00000000-0000-4000-a000-000000000100',
  accountId: '00000000-0000-4000-a000-000000000010',
  accountName: 'Test Account',
  accountCurrency: 'USD',
  accountTimezone: 'America/New_York',
  symbol: 'AAPL',
  side: 'long',
  assetType: 'stock',
  status: 'open',
  notes: null,
  totalEntryQuantity: 100,
  totalExitQuantity: 0,
  avgEntryPrice: 150,
  avgExitPrice: null,
  realizedPnl: null,
  returnPercentage: null,
  netPnl: null,
  grossPnl: null,
  brokerageFees: 0,
  brokerageName: null,
  targetPrice: null,
  stopLoss: null,
  targetRR: null,
  actualRR: null,
  openUnits: 100,
  closedUnits: 0,
  // 100 open units at the default $150 avg entry, no fees.
  openCostBasis: 15000,
  openedAt: '2026-05-01T12:00:00.000Z',
  closedAt: null,
  createdAt: '2026-05-01T12:00:00.000Z',
  updatedAt: '2026-05-01T12:00:00.000Z',
  tags: [],
  ...overrides,
});

/**
 * Deterministic builder for PositionGroupEntry used across web tests that
 * need a group row (design C12, Requirement 7).
 *
 * Mirrors `PositionGroupEntrySchema` in `packages/shared/src/schemas/position.ts`.
 * Default is an open two-leg group sharing `makePosition`'s account, each leg
 * open. Pass `legs` to vary count or status; the rest of the group fields
 * follow `overrides` as usual.
 */
export const makePositionGroup = (
  overrides: Partial<PositionGroupEntry> = {},
): PositionGroupEntry => {
  const legs: PositionGroupLeg[] =
    overrides.legs ??
    ([
      {
        ...makePosition({ id: '00000000-0000-4000-a000-000000000201' }),
        groupId: '00000000-0000-4000-a000-000000000200',
      },
      {
        ...makePosition({ id: '00000000-0000-4000-a000-000000000202' }),
        groupId: '00000000-0000-4000-a000-000000000200',
      },
    ] satisfies PositionGroupLeg[]);

  return {
    kind: 'group',
    id: '00000000-0000-4000-a000-000000000200',
    userId: '00000000-0000-4000-a000-000000000100',
    accountId: '00000000-0000-4000-a000-000000000010',
    accountName: 'Test Account',
    accountCurrency: 'USD',
    accountTimezone: 'America/New_York',
    underlying: 'AAPL',
    label: 'BCS',
    detectedLabel: 'BCS',
    labelOverride: null,
    status: 'open',
    openedAt: '2026-05-01T12:00:00.000Z',
    closedAt: null,
    createdAt: '2026-05-01T12:00:00.000Z',
    updatedAt: '2026-05-01T12:00:00.000Z',
    tags: [],
    classification: null,
    netEntry: 0,
    grossPnl: null,
    netPnl: null,
    brokerageFees: 0,
    openCostBasis: 15000,
    maxLoss: null,
    maxLossReason: null,
    legs,
    ...overrides,
  };
};

import type { PositionListItem } from '@tradr/shared';

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
  id: '00000000-0000-0000-0000-000000000001',
  userId: '00000000-0000-0000-0000-000000000100',
  accountId: '00000000-0000-0000-0000-000000000010',
  accountName: 'Test Account',
  accountCurrency: 'USD',
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
  openedAt: '2026-05-01T12:00:00.000Z',
  closedAt: null,
  createdAt: '2026-05-01T12:00:00.000Z',
  updatedAt: '2026-05-01T12:00:00.000Z',
  ...overrides,
});

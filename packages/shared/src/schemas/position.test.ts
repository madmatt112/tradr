import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CloseGroupSchema,
  CreatePositionGroupSchema,
  CreatePositionSchema,
  LinkPositionsSchema,
  PositionListEntrySchema,
  UpdatePositionSchema,
} from './position';

const accountId = '11111111-1111-4111-a111-111111111111';

const validLeg = (overrides: Partial<Record<string, unknown>> = {}) => ({
  symbol: 'AAPL260116C150',
  side: 'long',
  assetType: 'option',
  quantity: '1',
  price: '5.00',
  fees: '1.30',
  ...overrides,
});

const createGroupBody = (legCount: number) => ({
  accountId,
  filledAt: '2026-01-01T00:00:00.000Z',
  legs: Array.from({ length: legCount }, () => validLeg()),
});

const linkBody = (idCount: number) => ({
  positionIds: Array.from({ length: idCount }, () => randomUUID()),
});

const closeBody = (price: string) => ({
  exits: [{ positionId: randomUUID(), price, fees: '0' }],
});

// Shared PositionListItem-shaped fixture (fields from position.ts:182-229).
const ungroupedListItem = {
  id: randomUUID(),
  userId: randomUUID(),
  accountId: randomUUID(),
  symbol: 'AAPL',
  side: 'long',
  assetType: 'stock',
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
  avgEntryPrice: 150,
  avgExitPrice: null,
  totalEntryQuantity: 10,
  totalExitQuantity: 0,
  brokerageName: null,
  grossPnl: null,
  brokerageFees: 0,
  netPnl: null,
  targetPrice: null,
  stopLoss: null,
  targetRR: null,
  actualRR: null,
  openUnits: 10,
  closedUnits: 0,
  openCostBasis: 1500,
};

const groupEntry = () => {
  const groupId = randomUUID();
  return {
    kind: 'group',
    id: groupId,
    userId: randomUUID(),
    accountId: randomUUID(),
    accountName: 'Main',
    accountCurrency: 'USD',
    accountTimezone: 'America/New_York',
    underlying: 'AAPL',
    label: 'BCS',
    detectedLabel: 'BCS',
    labelOverride: null,
    status: 'open',
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
    maxLoss: 301.3,
    maxLossReason: null,
    legs: [
      { ...ungroupedListItem, id: randomUUID(), groupId },
      { ...ungroupedListItem, id: randomUUID(), groupId },
    ],
  };
};

describe('CreatePositionGroupSchema leg count (AC 1.1)', () => {
  it('accepts a create body with 2 legs', () => {
    expect(CreatePositionGroupSchema.safeParse(createGroupBody(2)).success).toBe(true);
  });

  it('accepts a create body with 8 legs', () => {
    expect(CreatePositionGroupSchema.safeParse(createGroupBody(8)).success).toBe(true);
  });

  it('refuses a create body with 1 leg', () => {
    expect(CreatePositionGroupSchema.safeParse(createGroupBody(1)).success).toBe(false);
  });

  it('refuses a create body with 9 legs', () => {
    expect(CreatePositionGroupSchema.safeParse(createGroupBody(9)).success).toBe(false);
  });
});

describe('LinkPositionsSchema id count (AC 1.4)', () => {
  it('refuses a link body with 1 id', () => {
    expect(LinkPositionsSchema.safeParse(linkBody(1)).success).toBe(false);
  });

  it('refuses a link body with 9 ids', () => {
    expect(LinkPositionsSchema.safeParse(linkBody(9)).success).toBe(false);
  });
});

describe('CreatePositionGroupSchema labelOverride (AC 2.4)', () => {
  it('refuses an override of 41 characters', () => {
    const result = CreatePositionGroupSchema.safeParse({
      ...createGroupBody(2),
      labelOverride: 'A'.repeat(41),
    });
    expect(result.success).toBe(false);
  });

  it('reads a padded override trimmed', () => {
    const result = CreatePositionGroupSchema.safeParse({
      ...createGroupBody(2),
      labelOverride: '  Iron Condor  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.labelOverride).toBe('Iron Condor');
    }
  });
});

describe('CloseGroupSchema exit price (AC 4.1)', () => {
  it('accepts a close exit with price 0', () => {
    expect(CloseGroupSchema.safeParse(closeBody('0')).success).toBe(true);
  });

  it('refuses a close exit with a negative price', () => {
    expect(CloseGroupSchema.safeParse(closeBody('-1')).success).toBe(false);
  });
});

describe('PositionListEntrySchema union (AC 6.1)', () => {
  it('parses an ungrouped list item', () => {
    expect(PositionListEntrySchema.safeParse(ungroupedListItem).success).toBe(true);
  });

  it('parses a group entry', () => {
    expect(PositionListEntrySchema.safeParse(groupEntry()).success).toBe(true);
  });
});

describe('CreatePositionSchema option-gated OCC refine', () => {
  it('rejects an option with a non-OCC symbol on path ["symbol"]', () => {
    const result = CreatePositionSchema.safeParse({
      accountId,
      symbol: 'NOTANOPTION',
      side: 'long',
      assetType: 'option',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'symbol');
      expect(issue).toBeDefined();
    }
  });

  it('accepts an option with a valid compact OCC symbol', () => {
    const result = CreatePositionSchema.safeParse({
      accountId,
      symbol: 'AAPL260116C150',
      side: 'long',
      assetType: 'option',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a stock with any symbol (refine skipped)', () => {
    const result = CreatePositionSchema.safeParse({
      accountId,
      symbol: 'NOTANOPTION',
      side: 'long',
      assetType: 'stock',
    });
    expect(result.success).toBe(true);
  });
});

describe('UpdatePositionSchema option-gated OCC refine', () => {
  it('rejects an option with a non-OCC symbol on path ["symbol"]', () => {
    const result = UpdatePositionSchema.safeParse({
      symbol: 'TSLA',
      assetType: 'option',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'symbol');
      expect(issue).toBeDefined();
    }
  });

  it('is skipped when symbol is absent', () => {
    const result = UpdatePositionSchema.safeParse({ assetType: 'option' });
    expect(result.success).toBe(true);
  });

  it('is skipped when assetType is absent, even with a non-OCC symbol present', () => {
    const result = UpdatePositionSchema.safeParse({ symbol: 'TSLA' });
    expect(result.success).toBe(true);
  });

  it('keeps min(1).max(20) on stock symbols', () => {
    expect(UpdatePositionSchema.safeParse({ symbol: '', assetType: 'stock' }).success).toBe(false);
    expect(
      UpdatePositionSchema.safeParse({ symbol: 'A'.repeat(21), assetType: 'stock' }).success,
    ).toBe(false);
    expect(UpdatePositionSchema.safeParse({ symbol: 'AAPL', assetType: 'stock' }).success).toBe(
      true,
    );
  });
});

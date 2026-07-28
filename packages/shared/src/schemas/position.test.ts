import { describe, expect, it } from 'vitest';

import { CreatePositionSchema, UpdatePositionSchema } from './position';

const accountId = '11111111-1111-1111-1111-111111111111';

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

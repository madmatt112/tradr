import { describe, expect, it } from 'vitest';

import { FlexFetchRequestSchema, IbkrConnectionSaveSchema } from './ibkr';

const baseSave = { token: '12345678', queryId: 'q1' };

describe('IbkrConnectionSaveSchema', () => {
  // Req 1.6: blank token or query id is refused.
  it.each(['', '   '])('rejects a blank or whitespace-only token (%j)', (token) => {
    expect(IbkrConnectionSaveSchema.safeParse({ ...baseSave, token }).success).toBe(false);
  });

  it.each(['', '   '])('rejects a blank or whitespace-only queryId (%j)', (queryId) => {
    expect(IbkrConnectionSaveSchema.safeParse({ ...baseSave, queryId }).success).toBe(false);
  });

  // D11: the token floor is 8, not just non-blank.
  it('rejects a 7-character token', () => {
    expect(IbkrConnectionSaveSchema.safeParse({ ...baseSave, token: '1234567' }).success).toBe(
      false,
    );
  });

  it('accepts an 8-character token', () => {
    expect(IbkrConnectionSaveSchema.safeParse({ ...baseSave, token: '12345678' }).success).toBe(
      true,
    );
  });

  it('rejects a token over 512 characters', () => {
    expect(
      IbkrConnectionSaveSchema.safeParse({ ...baseSave, token: '1'.repeat(513) }).success,
    ).toBe(false);
  });

  it('accepts a token of exactly 512 characters', () => {
    expect(
      IbkrConnectionSaveSchema.safeParse({ ...baseSave, token: '1'.repeat(512) }).success,
    ).toBe(true);
  });

  it('rejects a queryId over 64 characters', () => {
    expect(
      IbkrConnectionSaveSchema.safeParse({ ...baseSave, queryId: '1'.repeat(65) }).success,
    ).toBe(false);
  });

  it('accepts a queryId of exactly 64 characters', () => {
    expect(
      IbkrConnectionSaveSchema.safeParse({ ...baseSave, queryId: '1'.repeat(64) }).success,
    ).toBe(true);
  });

  it('trims surrounding whitespace from both fields', () => {
    const result = IbkrConnectionSaveSchema.safeParse({
      token: '  12345678  ',
      queryId: '  q1  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.token).toBe('12345678');
      expect(result.data.queryId).toBe('q1');
    }
  });
});

describe('FlexFetchRequestSchema', () => {
  it('rejects a non-uuid accountId', () => {
    expect(FlexFetchRequestSchema.safeParse({ accountId: 'not-a-uuid' }).success).toBe(false);
  });

  it('accepts a uuid accountId', () => {
    expect(
      FlexFetchRequestSchema.safeParse({ accountId: '123e4567-e89b-12d3-a456-426614174000' })
        .success,
    ).toBe(true);
  });
});

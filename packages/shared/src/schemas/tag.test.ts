import { describe, expect, it } from 'vitest';

import {
  StarterAnswerResultSchema,
  TAG_COLORS,
  TagCategorySchema,
  TagColorSchema,
  TagNameSchema,
  parseTagIdList,
} from './tag';

describe('TagNameSchema', () => {
  it('trims surrounding whitespace', () => {
    const result = TagNameSchema.safeParse('  breakout  ');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe('breakout');
  });

  it('rejects an empty name (0 chars)', () => {
    expect(TagNameSchema.safeParse('').success).toBe(false);
  });

  it('rejects a name of 41 chars', () => {
    expect(TagNameSchema.safeParse('a'.repeat(41)).success).toBe(false);
  });

  it('accepts a 1-char name', () => {
    expect(TagNameSchema.safeParse('a').success).toBe(true);
  });

  it('accepts a 40-char name', () => {
    expect(TagNameSchema.safeParse('a'.repeat(40)).success).toBe(true);
  });

  it('rejects a control character', () => {
    expect(TagNameSchema.safeParse('badname').success).toBe(false);
  });

  it('accepts an emoji name', () => {
    expect(TagNameSchema.safeParse('🚀 to the moon').success).toBe(true);
  });

  it('accepts a right-to-left script name', () => {
    expect(TagNameSchema.safeParse('اختراق').success).toBe(true);
  });
});

describe('TagCategorySchema', () => {
  it.each(['setup', 'emotion', 'mistake', 'general'])('accepts %s', (category) => {
    expect(TagCategorySchema.safeParse(category).success).toBe(true);
  });

  it('rejects an unknown category', () => {
    expect(TagCategorySchema.safeParse('scalp').success).toBe(false);
  });
});

describe('TagColorSchema', () => {
  it.each(TAG_COLORS)('accepts %s', (color) => {
    expect(TagColorSchema.safeParse(color).success).toBe(true);
  });

  it('accepts null', () => {
    expect(TagColorSchema.safeParse(null).success).toBe(true);
  });

  it("rejects a non-token colour ('red')", () => {
    expect(TagColorSchema.safeParse('red').success).toBe(false);
  });
});

describe('parseTagIdList', () => {
  const idA = '11111111-1111-1111-1111-111111111111';
  const idB = '22222222-2222-2222-2222-222222222222';

  it('returns [] for undefined', () => {
    expect(parseTagIdList(undefined)).toEqual([]);
  });

  it('returns [] for garbage', () => {
    expect(parseTagIdList('not,a,uuid')).toEqual([]);
  });

  it('returns a single id', () => {
    expect(parseTagIdList(idA)).toEqual([idA]);
  });

  it('sorts two ids regardless of input order', () => {
    expect(parseTagIdList(`${idB},${idA}`)).toEqual([idA, idB]);
    expect(parseTagIdList(`${idA},${idB}`)).toEqual([idA, idB]);
  });

  it('collapses duplicates', () => {
    expect(parseTagIdList(`${idA},${idA}`)).toEqual([idA]);
  });

  it('keeps only the uuid in a mixed list', () => {
    expect(parseTagIdList(`abc,${idA}`)).toEqual([idA]);
  });
});

describe('StarterAnswerResultSchema', () => {
  it('parses a decline with no created tags', () => {
    const result = StarterAnswerResultSchema.safeParse({ answer: 'decline', created: [] });
    expect(result.success).toBe(true);
  });
});

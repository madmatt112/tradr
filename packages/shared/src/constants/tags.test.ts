import { describe, expect, it } from 'vitest';

import { TagCategorySchema } from '../schemas/tag';

import { STARTER_TAGS, TAG_CATEGORY_PREFIX, TAG_LIMITS } from './tags';

describe('STARTER_TAGS', () => {
  it('has sixteen entries', () => {
    expect(STARTER_TAGS).toHaveLength(16);
  });

  it('has case-insensitively unique names', () => {
    const lower = STARTER_TAGS.map((t) => t.name.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });

  it('uses only valid categories', () => {
    for (const tag of STARTER_TAGS) {
      expect(TagCategorySchema.safeParse(tag.category).success).toBe(true);
    }
  });
});

describe('TAG_LIMITS', () => {
  it('equals { perUser: 200, perPosition: 20 }', () => {
    expect(TAG_LIMITS).toEqual({ perUser: 200, perPosition: 20 });
  });
});

describe('TAG_CATEGORY_PREFIX', () => {
  it('maps each category to its letter (S, E, M, G)', () => {
    expect(TAG_CATEGORY_PREFIX).toEqual({ setup: 'S', emotion: 'E', mistake: 'M', general: 'G' });
  });
});

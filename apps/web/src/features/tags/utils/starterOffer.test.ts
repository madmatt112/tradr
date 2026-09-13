import { describe, expect, it } from 'vitest';

import { STARTER_TAGS, type TagCategory } from '@tradr/shared';

import { groupTagsByCategory, starterOfferState } from './starterOffer';

const answered = { starterTagsAnsweredAt: '2026-01-01T00:00:00.000Z' };
const allSixteen = STARTER_TAGS.map((tag, i) => ({ id: String(i), name: tag.name }));

// The six reachable rows of the REQ-5 truth table (requirements.md). A user
// with zero tags necessarily has every starter tag missing, so (no tags, none
// missing) cannot occur.
describe('starterOfferState', () => {
  it('no tags + unanswered → offer', () => {
    expect(starterOfferState({ tags: [], onboarding: {} })).toBe('offer');
  });

  it('no tags + answered → add-starter', () => {
    expect(starterOfferState({ tags: [], onboarding: answered })).toBe('add-starter');
  });

  it('tags + unanswered + a starter missing → add-starter', () => {
    expect(starterOfferState({ tags: [{ name: 'breakout' }], onboarding: {} })).toBe('add-starter');
  });

  it('tags + unanswered + all sixteen present (case-insensitively) → none', () => {
    // e.g. `Breakout` must match the constant `breakout`.
    const tags = STARTER_TAGS.map((tag) => ({
      name: tag.name.charAt(0).toUpperCase() + tag.name.slice(1),
    }));
    expect(starterOfferState({ tags, onboarding: {} })).toBe('none');
  });

  it('tags + answered + a starter missing → add-starter', () => {
    expect(starterOfferState({ tags: [{ name: 'my own tag' }], onboarding: answered })).toBe(
      'add-starter',
    );
  });

  it('tags + answered + none missing → none', () => {
    expect(starterOfferState({ tags: allSixteen, onboarding: answered })).toBe('none');
  });
});

describe('groupTagsByCategory', () => {
  it('groups in TAG_CATEGORIES order and omits empty categories', () => {
    const groups = groupTagsByCategory(STARTER_TAGS);
    // STARTER_TAGS has no `general` tag, so that group is omitted; the rest
    // follow the TAG_CATEGORIES order (setup, emotion, mistake).
    expect(groups.map((group) => group.category)).toEqual(['setup', 'emotion', 'mistake']);
  });

  it('keeps only the tags of each category', () => {
    const tags: { category: TagCategory; name: string }[] = [
      { category: 'emotion', name: 'calm' },
      { category: 'setup', name: 'breakout' },
      { category: 'setup', name: 'pullback' },
    ];
    const groups = groupTagsByCategory(tags);
    expect(groups.map((group) => group.category)).toEqual(['setup', 'emotion']);
    expect(groups[0].tags).toHaveLength(2);
    expect(groups[1].tags).toHaveLength(1);
  });
});

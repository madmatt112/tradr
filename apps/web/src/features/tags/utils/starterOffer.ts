import { STARTER_TAGS, TAG_CATEGORIES, type TagCategory } from '@tradr/shared';

// The starter offer state (design Component 14; REQ-5 truth table). One pure
// decision the picker (REQ-4.4) and the Settings tab (REQ-5.5/5.6) both read,
// so the prominent offer is presented at most once per user.
export type StarterOfferState = 'offer' | 'add-starter' | 'none';

/**
 * Decide which starter surface, if any, a caller should show. `offer` (the
 * prominent once-only card) iff the user has no tags and has not answered;
 * else `add-starter` (the secondary action) iff any starter tag is missing
 * from the vocabulary, compared case-insensitively; else `none`. The caller
 * supplies the tags and the already-cached onboarding answer — this reads no
 * data itself (REQ-4.4/5.5).
 */
export function starterOfferState(input: {
  tags: readonly { name: string }[];
  onboarding: { starterTagsAnsweredAt?: string } | undefined;
}): StarterOfferState {
  const { tags, onboarding } = input;
  if (tags.length === 0 && onboarding?.starterTagsAnsweredAt === undefined) {
    return 'offer';
  }
  const have = new Set(tags.map((tag) => tag.name.toLowerCase()));
  const missing = STARTER_TAGS.some((starter) => !have.has(starter.name.toLowerCase()));
  return missing ? 'add-starter' : 'none';
}

/**
 * Group tags by category in the `TAG_CATEGORIES` display order (REQ-2.5),
 * omitting any category with no tags. Generic over the tag shape so both the
 * starter constants and fetched `Tag` rows can be grouped.
 */
export function groupTagsByCategory<T extends { category: TagCategory }>(
  tags: readonly T[],
): { category: TagCategory; tags: T[] }[] {
  return TAG_CATEGORIES.map((category) => ({
    category,
    tags: tags.filter((tag) => tag.category === category),
  })).filter((group) => group.tags.length > 0);
}

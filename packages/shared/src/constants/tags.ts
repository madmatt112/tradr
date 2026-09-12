import type { TagCategory } from '../schemas/tag';

// Per-user and per-position tag caps (REQ-2.2). Enforced by the service as a
// 409, never by a wire schema.
export const TAG_LIMITS = { perUser: 200, perPosition: 20 } as const;

// Group headings shown in the tag list and picker; the display order itself
// lives on TAG_CATEGORIES (REQ-2.5).
export const TAG_CATEGORY_LABELS: Record<TagCategory, string> = {
  setup: 'Setups',
  emotion: 'Emotions',
  mistake: 'Mistakes',
  general: 'General',
};

// The chip's visible single-letter category prefix.
export const TAG_CATEGORY_PREFIX: Record<TagCategory, string> = {
  setup: 'S',
  emotion: 'E',
  mistake: 'M',
  general: 'G',
};

// The sixteen starter tags offered on first run (REQ-6.1), in the order the
// design lists them. No `color` — starter tags are created with `color: null`.
export const STARTER_TAGS: readonly { name: string; category: TagCategory }[] = [
  { name: 'chased entry', category: 'mistake' },
  { name: 'moved stop', category: 'mistake' },
  { name: 'over-sized', category: 'mistake' },
  { name: 'no plan', category: 'mistake' },
  { name: 'early exit', category: 'mistake' },
  { name: 'late exit', category: 'mistake' },
  { name: 'wrong direction', category: 'mistake' },
  { name: 'ignored signal', category: 'mistake' },
  { name: 'breakout', category: 'setup' },
  { name: 'pullback', category: 'setup' },
  { name: 'reversal', category: 'setup' },
  { name: 'earnings', category: 'setup' },
  { name: 'calm', category: 'emotion' },
  { name: 'anxious', category: 'emotion' },
  { name: 'FOMO', category: 'emotion' },
  { name: 'frustrated', category: 'emotion' },
];

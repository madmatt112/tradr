import { z } from 'zod';

// Tag categories, in the REQ-2.5 display order. `TagCategorySchema` is the wire
// enum both apps validate against.
export const TAG_CATEGORIES = ['setup', 'emotion', 'mistake', 'general'] as const;

export const TagCategorySchema = z.enum(TAG_CATEGORIES);

// The six categorical colour tokens (`--color-tag-1` … `--color-tag-6`). A tag
// may carry no colour, so the wire schema is nullable. `TagColor` is the
// non-null union derived from the const array (the `expense-categories.ts`
// precedent), NOT `z.infer` of the nullable schema, so a caller can build a
// `Record<TagColor, string>` of palette classes.
export const TAG_COLORS = ['tag-1', 'tag-2', 'tag-3', 'tag-4', 'tag-5', 'tag-6'] as const;

export type TagColor = (typeof TAG_COLORS)[number];

export const TagColorSchema = z.enum(TAG_COLORS).nullable();

export const TAG_NAME_MAX_LENGTH = 40;

// Trimmed, 1–40 chars, and free of Unicode control characters. The refine
// rejects any `\p{Cc}` code point (Unicode category "control"); emoji and RTL
// script pass (REQ-1.1).
export const TagNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(TAG_NAME_MAX_LENGTH)
  .refine((name) => !/\p{Cc}/u.test(name), {
    message: 'Tag name must not contain control characters',
  });

export const CreateTagSchema = z.object({
  name: TagNameSchema,
  category: TagCategorySchema,
  // `color` defaults to null server-side when omitted.
  color: TagColorSchema.optional(),
});

// At least one key must be present — a body naming nothing has no effect.
export const UpdateTagSchema = CreateTagSchema.partial().refine(
  (patch) => Object.keys(patch).length > 0,
  { message: 'Provide at least one of name, category or color' },
);

// The tag shape on list/detail responses and the `PUT` result.
export const TagSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  category: TagCategorySchema,
  color: TagColorSchema,
});

// The `GET /api/tags` row (REQ-1.3).
export const TagWithCountSchema = TagSchema.extend({
  positionCount: z.number().int().nonnegative(),
});

// No Zod maximum: duplicates collapse and the per-position cap is the service's
// 409, never a 400 (REQ-2.2).
export const SetPositionTagsSchema = z.object({
  tagIds: z.array(z.string().uuid()),
});

export const StarterAnswerSchema = z.object({
  answer: z.enum(['accept', 'decline']),
});

// The body of a successful starter answer (tasks Decision 1): the answer plus
// the tags an `accept` created (empty on `decline`).
export const StarterAnswerResultSchema = z.object({
  answer: z.enum(['accept', 'decline']),
  created: z.array(TagSchema),
});

const uuid = z.string().uuid();

// Parse a comma-separated tag-id value into a stable list: trim each element,
// keep only the ones `z.string().uuid()` accepts, de-duplicate, and sort
// lexicographically as strings; `[]` when nothing survives. One primitive
// serves the API filter and the web route value, so "which elements survive" is
// defined once (REQ-3.2/3.6).
export function parseTagIdList(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (uuid.safeParse(trimmed).success) seen.add(trimmed);
  }
  return Array.from(seen).sort();
}

export const TagIdListParamSchema = z.string().optional().transform(parseTagIdList);

export type Tag = z.infer<typeof TagSchema>;
export type TagWithCount = z.infer<typeof TagWithCountSchema>;
export type TagCategory = z.infer<typeof TagCategorySchema>;
export type CreateTagInput = z.infer<typeof CreateTagSchema>;
export type UpdateTagInput = z.infer<typeof UpdateTagSchema>;
export type SetPositionTagsInput = z.infer<typeof SetPositionTagsSchema>;
export type StarterAnswer = z.infer<typeof StarterAnswerSchema>;
export type StarterAnswerResult = z.infer<typeof StarterAnswerResultSchema>;

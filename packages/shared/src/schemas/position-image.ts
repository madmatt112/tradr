import { z } from 'zod';

import { MAX_IMAGE_BYTES_DEFAULT } from './advisor';

// Position screenshots reuse the advisor's per-image byte cap (the memory-safety
// floor, advisor.ts:88-107): the cap is applied to the ENCODED `dataBase64`
// length, so an oversized upload is rejected at validation time BEFORE any
// base64 decode into memory. No new environment variable is introduced
// (requirements D3); one image per request fits the shipped 20m nginx ceiling.
export const POSITION_IMAGE_MAX_BYTES = MAX_IMAGE_BYTES_DEFAULT;

// A position holds at most this many screenshots. The count is re-checked under
// the position's row lock on upload (REQ-2.5); this constant is the wire cap
// both apps import.
export const POSITION_IMAGE_MAX_COUNT = 10;

export const PositionImageFormatSchema = z.enum(['png', 'jpeg', 'webp']);

// Upload request body. `dataBase64` is capped at the encoded byte cap before any
// decode, mirroring the advisor's `makeStreamRequestSchema` idiom
// (advisor.ts:123-128); an over-cap value carries the `IMAGE_TOO_LARGE` message
// so the route can surface a 400 `IMAGE_TOO_LARGE` (REQ-2.1).
export const UploadPositionImageSchema = z.object({
  format: PositionImageFormatSchema,
  dataBase64: z.string().min(1).max(POSITION_IMAGE_MAX_BYTES, { message: 'IMAGE_TOO_LARGE' }),
});

// The record shape the detail response and the 201 body carry. `unavailable` is
// a literal `true` (never `false`): it is present only for a record whose object
// was migrated to `unrecoverable`, and absent otherwise, matching the query
// mapping that maps a non-pointer part to `undefined`.
export const PositionImageSchema = z.object({
  id: z.string().uuid(),
  format: PositionImageFormatSchema,
  createdAt: z.string(),
  unavailable: z.literal(true).optional(),
});

export type UploadPositionImage = z.infer<typeof UploadPositionImageSchema>;
export type PositionImage = z.infer<typeof PositionImageSchema>;

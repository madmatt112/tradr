import { z } from 'zod';

// Wire-side validation contract for the advisor feature.
//
// Per design.md §Component 10 (REQ-10.1). Pure types and
// `assembleCanonicalMessages` live elsewhere (api-only); this file holds
// only the cross-app Zod schemas and their inferred type aliases.

export const ProviderIdSchema = z.enum(['claude', 'openai', 'gemini', 'openrouter']);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const RoleSchema = z.enum(['user', 'assistant']);
export type Role = z.infer<typeof RoleSchema>;

export const ToolCallPartSchema = z.object({
  type: z.literal('tool_call'),
  id: z.string(),
  name: z.string(),
  arguments: z.unknown(),
});
export type ToolCallPart = z.infer<typeof ToolCallPartSchema>;

export const ToolResultPartSchema = z.object({
  type: z.literal('tool_result'),
  toolCallId: z.string(),
  status: z.enum(['ok', 'error']),
  content: z.unknown(),
});
export type ToolResultPart = z.infer<typeof ToolResultPartSchema>;

export const MessageContentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image'),
    format: z.enum(['png', 'jpeg', 'webp']),
    dataBase64: z.string().min(1),
  }),
  ToolCallPartSchema,
  ToolResultPartSchema,
]);
export type MessageContentPart = z.infer<typeof MessageContentPartSchema>;

const ImageFormatSchema = z.enum(['png', 'jpeg', 'webp']);

// REQ-2.2: the persisted `content_parts` shape and `loadStreamContext`'s raw
// return. A genuine SUPERSET of `CanonicalPart` (= `MessageContentPart`): the
// full narrow union PLUS two image-storage variants that keep the `type:'image'`
// discriminant so they stay discriminable/renderable. The inline arm carries no
// `storage` field, so marker ABSENCE means legacy inline (forward-only, REQ-2.2).
//
// `MessageContentPartSchema` is the FIRST union member, so every `CanonicalPart`
// value parses through as-is (`CanonicalPart ⊆ StoredContentPart`) — a later
// `CanonicalPart[] → StoredContentPart[]` param widening is back-compatible.
export const StoredContentPartSchema = z.union([
  MessageContentPartSchema,
  z.object({
    type: z.literal('image'),
    format: ImageFormatSchema,
    storage: z.object({ kind: z.literal('object'), key: z.string().min(1) }),
  }),
  z.object({
    type: z.literal('image'),
    format: ImageFormatSchema,
    storage: z.object({ kind: z.literal('unrecoverable') }),
  }),
]);
export type StoredContentPart = z.infer<typeof StoredContentPartSchema>;

// REQ-2.2/2.4: the client response shape. Same inline variants as `CanonicalPart`
// plus the two image-storage markers with the object KEY DROPPED (REQ-2.4 — no
// IDOR leak): pointer → `storage:'object'`, unrecoverable → `storage:'unrecoverable'`.
// Marker absence still means legacy inline. This backs `MessageSchema.contentParts`.
export const ResponseMessageContentPartSchema = z.union([
  MessageContentPartSchema,
  z.object({
    type: z.literal('image'),
    format: ImageFormatSchema,
    storage: z.literal('object'),
  }),
  z.object({
    type: z.literal('image'),
    format: ImageFormatSchema,
    storage: z.literal('unrecoverable'),
  }),
]);
export type ResponseMessageContentPart = z.infer<typeof ResponseMessageContentPartSchema>;

// REQ-4: always-on per-image byte cap (the memory-safety floor).
//
// The default per-image cap and the per-message image count. The cap is applied
// to the ENCODED `dataBase64` length (what Zod sees), so an oversized upload is
// rejected at validation time BEFORE any base64 decode into memory (REQ-4.2 — no
// OOM), on any deployment, fronted by the project nginx or not (REQ-4.1).
//
// Encoded↔decoded: base64 inflates ~33%, so decoded ≈ cap × 3/4. At the default
// 4,500,000 encoded that is ≈ 3.375 MB of image per part.
//
// Directional relationship to the nginx ceiling MAX_UPLOAD_SIZE (shipped default
// `20m` = 20,971,520 — .env.example:73), REQ-4.4 — both inequalities hold at the
// default so nginx never 413s a legitimate multi-image message and a single image
// always fits:
//   ADVISOR_MAX_IMAGES_PER_MESSAGE × cap + text.max(50_000) + JSON/framing overhead
//       ≤ MAX_UPLOAD_SIZE   →   4 × 4,500,000 + 50,000 ≈ 18,050,000 < 20,971,520
//   cap ≤ MAX_UPLOAD_SIZE   →   4,500,000 ≤ 20,971,520
// The binding total-request-body guard is the stream route's bodyLimit (a later
// task); this cap bounds one image only.
export const MAX_IMAGE_BYTES_DEFAULT = 4_500_000;
export const ADVISOR_MAX_IMAGES_PER_MESSAGE = 4;

/**
 * Wire/upload request schema for the advisor stream route (REQ-4).
 *
 * `maxImageBytes` is operator-overridable (the API route passes the configured
 * value; a later task wires it to `ADVISOR_IMAGE_MAX_BYTES`), defaulting to
 * `MAX_IMAGE_BYTES_DEFAULT`.
 *
 * The per-image cap lives on a dedicated capped image-part schema built HERE for
 * the `attachments` array — deliberately NOT on the shared `MessageContentPartSchema`
 * union, which backs `MessageSchema.contentParts` and the persisted/read path:
 * capping that union would reject legacy oversized inline rows on read and break
 * REQ-2.2's forward-only guarantee. The cap is a wire/upload constraint only.
 */
export function makeStreamRequestSchema(maxImageBytes: number = MAX_IMAGE_BYTES_DEFAULT) {
  const cappedImagePart = z.object({
    type: z.literal('image'),
    format: z.enum(['png', 'jpeg', 'webp']),
    dataBase64: z.string().min(1).max(maxImageBytes, { message: 'IMAGE_TOO_LARGE' }),
  });
  return z.object({
    clientMessageId: z.string().uuid(), // REQ-3.12 v3 validation
    text: z.string().min(1).max(50_000),
    attachments: z.array(cappedImagePart).max(ADVISOR_MAX_IMAGES_PER_MESSAGE).optional(),
    personaId: z.string().min(1).max(100).optional(),
    providerOverride: z
      .object({ providerId: ProviderIdSchema, model: z.string().min(1) })
      .optional(),
  });
}

// The per-image `.max()` plus the `.max(ADVISOR_MAX_IMAGES_PER_MESSAGE)` count
// already bound the attachment total to Σ ≤ maxImageBytes × count, so a combined
// attachments `.superRefine` sum-cap would be mathematically redundant and is
// intentionally omitted; the request-body floor (route bodyLimit, later task) is
// the binding total-request-size guard.
export const StreamRequestSchema = makeStreamRequestSchema();
export type StreamRequestInput = z.infer<typeof StreamRequestSchema>;

export const ConversationRenameSchema = z.object({
  // REQ-2.5: title length 1–200 chars; whitespace-only is rejected.
  title: z
    .string()
    .max(200)
    .refine((s) => s.trim().length >= 1, { message: 'Required' }),
});
export type ConversationRenameInput = z.infer<typeof ConversationRenameSchema>;

export const ConversationSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  title: z.string(),
  personaId: z.string().nullable(),
  providerId: ProviderIdSchema,
  model: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const ConversationListItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  providerId: ProviderIdSchema,
  model: z.string(),
  updatedAt: z.string(),
});
export type ConversationListItem = z.infer<typeof ConversationListItemSchema>;

export const MessageSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  role: RoleSchema,
  // REQ-2.2/2.4: the client-facing response shape — inline (legacy) plus the
  // key-less image-storage markers. Never carries the object key (no IDOR leak).
  contentParts: z.array(ResponseMessageContentPartSchema),
  promptTokens: z.number().int().nullable(),
  completionTokens: z.number().int().nullable(),
  clientMessageId: z.string().uuid().nullable(),
  createdAt: z.string(),
});
export type Message = z.infer<typeof MessageSchema>;

export const PersonaSchema = z.object({
  id: z.string(),
  userId: z.string().uuid().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  systemPrompt: z.string(),
  isBuiltin: z.boolean(),
  isDefault: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Persona = z.infer<typeof PersonaSchema>;

export const PersonaInputSchema = z.object({
  // REQ-7.8: name 1–80, description 0–500, systemPrompt 1–5000.
  // Whitespace-only strings are rejected for required fields (name, systemPrompt).
  name: z
    .string()
    .max(80)
    .refine((s) => s.trim().length >= 1, { message: 'Required' }),
  description: z.string().max(500).optional(),
  systemPrompt: z
    .string()
    .max(5_000)
    .refine((s) => s.trim().length >= 1, { message: 'Required' }),
});
export type PersonaInput = z.infer<typeof PersonaInputSchema>;

export const ProviderKeyListItemSchema = z.object({
  id: z.string().uuid(),
  providerId: ProviderIdSchema,
  defaultModel: z.string(),
  keyHintTail: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type ProviderKeyListItem = z.infer<typeof ProviderKeyListItemSchema>;

export const ProviderKeyInputSchema = z.object({
  apiKey: z.string().min(8),
  // Optional on save: before the first key exists the client has no model list
  // to pick from (REQ-6.4) — when omitted, the server selects the provider's
  // deterministic default from the validation probe's listModels response.
  defaultModel: z.string().min(1).max(64).optional(),
});
export type ProviderKeyInput = z.infer<typeof ProviderKeyInputSchema>;

// PATCH /provider-keys/:providerId — change the default model for an
// already-configured key without re-supplying the key material.
export const ProviderKeyPatchSchema = z.object({
  defaultModel: z.string().min(1).max(64),
});
export type ProviderKeyPatch = z.infer<typeof ProviderKeyPatchSchema>;

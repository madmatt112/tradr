// Pure advisor types shared across apps.
//
// Per design.md §Component 10 (REQ-9.1 v4, REQ-10.1). This file holds the
// cross-app TypeScript types that are NOT directly inferrable as Zod schemas
// (the canonical assembly format and the provider-model descriptor). The
// `assembleCanonicalMessages` function is intentionally NOT exported here — it
// is API-only and lives in `apps/api/src/features/advisor/assemble.ts`.

import type { MessageContentPart } from '../../schemas/advisor';

/**
 * A single part of a canonical message body. Structurally identical to the
 * wire-side `MessageContentPart` (text or image), reused here so the canonical
 * format and the validation schema cannot drift.
 */
export type CanonicalPart = MessageContentPart;

/**
 * Persisted (`content_parts` / `loadStreamContext` raw) and client-response
 * content-part supersets (REQ-2.2). Re-exported here so the canonical processing
 * type and the storage/response types share one import site; the Zod schemas are
 * the source of truth in `schemas/advisor.ts`. `CanonicalPart ⊆ StoredContentPart`.
 */
export type { StoredContentPart, ResponseMessageContentPart } from '../../schemas/advisor';

/**
 * Provider-agnostic message shape consumed by `ProviderAdapter.translate` and
 * `ProviderAdapter.prepareForTokenCount`. A `system` message carries a plain
 * string; `user` / `assistant` messages carry an ordered list of parts.
 */
export type CanonicalMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; parts: CanonicalPart[] }
  | { role: 'assistant'; parts: CanonicalPart[] };

/**
 * Descriptor for a model exposed by a provider's `listModels` response.
 */
export interface ProviderModel {
  id: string;
  displayName: string;
  contextWindow: number;
  vision: boolean;
  /**
   * Whether the model supports tool use (function calling). Populated per-model
   * by each adapter, fail-closed (`false`) on unrecognized ids — see
   * design.md §Component 2.
   */
  toolUse: boolean;
}

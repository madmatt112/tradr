// Tool type system for the advisor agentic loop (design §Component 1, REQ-1).
//
// This module defines the shapes a tool author must satisfy and the runtime
// context a tool handler receives. The registry (registry.ts) is keyed by
// `ToolDefinition.name`; the dispatcher (task 5) re-checks `requires`,
// `safeParse`s `inputSchema`, and invokes `handler`.

import type { z } from 'zod';

import type { UnusualWhalesClient } from '../lib/unusual-whales.client';

export type { UnusualWhalesClient };

/**
 * Tool category (REQ-1.1). `trade-data` tools touch the user's own trade
 * history and are subject to consent (REQ-1.7) and the per-turn egress cap
 * (REQ-9.5). `market-data` tools call Unusual Whales via `ToolContext.uw`.
 */
export type ToolCategory = 'market-data' | 'trade-data';

/**
 * Precondition a tool requires before it may be declared/dispatched (REQ-1.7).
 * Re-checked against the current iteration's snapshot on every provider
 * round-trip; an unsatisfied requirement yields `TOOL_NOT_PERMITTED`.
 */
export type ToolRequires = 'unusual-whales-key' | 'trade-data-consent' | 'none';

/**
 * The Unusual Whales client (REQ-1.4, REQ-6.4) — re-exported from the concrete
 * implementation (task 8, `features/advisor/lib/unusual-whales.client.ts`) so
 * `ctx.uw` carries the real method surface (`getOptionsFlow(symbol, limit?)`,
 * `getOptionContracts(symbol, expiry)`) market-data handlers forward to. The
 * `import type` re-export above keeps this free of a runtime circular import.
 */

/**
 * Runtime context passed to every tool handler. Built per call by the
 * dispatcher: `uw` is present only for `market-data` tools (REQ-1.4), already
 * bound to this user's key + meter + cache.
 */
export interface ToolContext {
  userId: string;
  /** Null for a conversation that has not yet been persisted. */
  conversationId: string | null;
  /** Aborts when the client disconnects; handlers must honor it (REQ-3.4). */
  signal: AbortSignal;
  /** market-data handlers only (REQ-1.4). */
  uw?: UnusualWhalesClient;
}

/**
 * Outcome of a tool invocation. On `error`, `code` is a stable taxonomy code
 * from `tools/error-codes.ts` (a `tool_result`-bucket `ToolResultCode`, REQ-15.1)
 * so the dispatcher can classify continue-vs-withdraw and the model can adapt.
 * Typed as `string` here to avoid coupling the shape to the code union; the
 * dispatcher narrows it via `bucketOf`.
 */
export type ToolResult =
  | { status: 'ok'; content: unknown }
  | { status: 'error'; code: string; message: string };

/**
 * A single tool the model may be offered. Registered in `toolRegistry` by
 * `name`.
 *
 * HARD CONSTRAINT — flat-object inputSchema (design §Component 2, REQ-1.6):
 * `inputSchema` MUST be a flat `z.object({...})` of scalar fields (string /
 * number / boolean / enum). NO nested objects, arrays of objects, unions, or
 * reused sub-schemas. The provider JSON Schema is derived (task 5) via the
 * `zod-to-json-schema` package:
 * `zodToJsonSchema(inputSchema, { target: 'jsonSchema7', $refStrategy: 'none' })`,
 * yielding a flat draft-07 schema; nesting/reuse
 * makes the converter emit `$ref`/`$defs`, which Anthropic `input_schema` and OpenAI
 * strict `function.parameters` handle inconsistently. Flat schemas guarantee
 * no `$ref`/`$defs` is emitted, so the declared and validated contracts cannot
 * drift across providers.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  requires: ToolRequires;
  /** v3 Zod schema; MUST satisfy the flat-object constraint above. */
  inputSchema: z.ZodType;
  /**
   * Static worst-case egress bound in tokens (trade-data tools only), used for
   * the deterministic pre-call cap (REQ-9.5). Omitted for market-data tools.
   */
  maxEstTokens?: number;
  handler(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

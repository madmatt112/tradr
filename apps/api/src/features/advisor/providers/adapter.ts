// Provider adapter interface. Per design.md §Component 2 ("adapter.ts").
//
// This file pins the contract implemented by the Claude (claude.ts) and OpenAI
// (openai.ts) adapters and consumed by the registry (registry.ts) and the
// streaming orchestration (streaming.ts). Provider-native message and
// token-count shapes are intentionally opaque here — they live inside each
// adapter implementation.
//
// Canonical, cross-app types (`CanonicalMessage`, `CanonicalPart`,
// `ProviderModel`) are owned by `@tradr/shared` (Task 2) and re-exported below
// so adapter authors import everything from one place.

import type { CanonicalMessage, ProviderModel } from '@tradr/shared';

export type { CanonicalMessage, CanonicalPart, ProviderModel } from '@tradr/shared';

/**
 * The supported provider backends. Must stay in lockstep with
 * `ProviderIdSchema` in `@tradr/shared`. Gemini and OpenRouter (v6) ride the
 * OpenAI-compatible adapter with their own base URLs and model metadata.
 */
export type ProviderId = 'claude' | 'openai' | 'gemini' | 'openrouter';

/**
 * Provider-native, already-translated message payload. Each adapter narrows
 * this to its SDK's own shape internally; the orchestrator treats it as opaque.
 */
export type ProviderNativeMessages = unknown;

/**
 * Provider-agnostic declaration of a tool offered to the model. Each adapter
 * translates this into its SDK's own tool shape (Anthropic `tools[]` /
 * OpenAI `tools[{type:'function'}]`) inside `streamChat`. Per design.md
 * §Component 2, `inputJsonSchema` must be a flat object schema (no `$ref` /
 * `$defs`) so both provider tool APIs accept it unchanged.
 */
export interface ProviderToolDecl {
  name: string;
  description: string;
  inputJsonSchema: Record<string, unknown>;
}

/**
 * Provider-native input for a token-count call. Opaque to the orchestrator;
 * produced by `prepareForTokenCount` and consumed by the cap-check path.
 */
export type TokenCountInput = unknown;

/** A single event emitted while streaming a completion from a provider. */
export type ProviderStreamEvent =
  | { type: 'token'; delta: string }
  | { type: 'usage'; promptTokens: number | null; completionTokens: number | null }
  | { type: 'tool_call'; id: string; name: string; arguments: unknown }
  | { type: 'done' };

/** Arguments for `streamChat`. */
export interface ProviderStreamArgs {
  apiKey: string;
  modelId: string;
  messages: ProviderNativeMessages;
  signal: AbortSignal;
  /**
   * Tools offered to the model for this call. Omitted/undefined means a
   * conversation-only (no-tools) call. Each adapter translates these into its
   * SDK's native tool shape; no provider-specific translation happens here.
   */
  tools?: ProviderToolDecl[];
}

/**
 * Stateless adapter for a single LLM provider. Implementations are constructed
 * once at bootstrap with a shared `ListModelsCache` and registered by `id`.
 */
export interface ProviderAdapter {
  id: ProviderId;
  listModels(apiKey: string): Promise<ProviderModel[]>;
  translate(list: CanonicalMessage[], modelId: string): ProviderNativeMessages;
  prepareForTokenCount(list: CanonicalMessage[], modelId: string): TokenCountInput;
  streamChat(args: ProviderStreamArgs): AsyncIterable<ProviderStreamEvent>;
}

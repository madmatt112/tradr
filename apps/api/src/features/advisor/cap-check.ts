// Cap-check: prompt-token estimation. Per design.md §Component 5 (REQ-9.1).
//
// Owns: provider-native tokenisation, the 5-second Anthropic timeout, the
// auth-error short-circuit, the fallback heuristic, and encoder resolution.
//
// tiktoken is loaded via a LAZY dynamic import() inside estimateTokens — NEVER at
// module top. This keeps the WASM payload out of any bundle/start path that does
// not actually run the OpenAI cap-check (REQ-12.1 bundle gate).

import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';

import { logger } from '@/lib/logger';

import { ProviderKeyRejectedError } from './advisor.errors';
import type { CanonicalMessage, ProviderAdapter, ProviderToolDecl } from './providers/adapter';

const COUNT_TOKENS_TIMEOUT_MS = 5_000;

/** High-detail OpenAI image token cost (REQ-9.1). MVP pins high-detail. */
const OPENAI_IMAGE_TOKENS = 765;

/** Per-image token cost for the conservative fallback heuristic (REQ-9.1). */
const FALLBACK_IMAGE_TOKENS = 1500;

/**
 * Ordered prefix → encoder list (REQ-9.1 v3/v4). First match wins. Lives here so
 * the precedence rule has exactly one home (openai.ts references this).
 *
 * Unknown models return null — the caller MUST fall back to the heuristic. Do
 * NOT silently default to cl100k_base (tiktoken's own default would).
 */
const ENCODER_PREFIXES: readonly (readonly [string, 'o200k_base' | 'cl100k_base'])[] = [
  ['gpt-4o', 'o200k_base'],
  ['gpt-4', 'cl100k_base'],
  ['gpt-3.5', 'cl100k_base'],
];

/**
 * Resolve an OpenAI model id to its tiktoken encoder name via the ordered prefix
 * list. Returns null for unknown models — the caller falls back to the heuristic
 * rather than silently using cl100k_base.
 */
export function resolveEncoder(modelId: string): 'o200k_base' | 'cl100k_base' | null {
  return ENCODER_PREFIXES.find(([prefix]) => modelId.startsWith(prefix))?.[1] ?? null;
}

export type TokenSource = 'tiktoken' | 'countTokens' | 'fallback';

export interface EstimateTokensResult {
  tokens: number;
  source: TokenSource;
  upstreamStatus?: number;
}

export interface EstimateTokensArgs {
  adapter: ProviderAdapter;
  list: CanonicalMessage[];
  modelId: string;
  apiKey: string;
  imageCount: number;
  /**
   * Tool declarations offered to the model this turn (from `buildDeclarations`).
   * Their serialized JSON is folded into the estimate (§Component 8 step 1) so
   * the trigger accounts for the declaration payload, not just messages. Omitted
   * / empty means a conversation-only call — no declaration cost is added.
   */
  toolDeclarations?: ProviderToolDecl[];
  /** Test-only override of the Anthropic countTokens timeout. Defaults to 5 s. */
  countTokensTimeoutMs?: number;
}

/**
 * Serialize the tool-declaration array into a flat JSON string for token
 * counting (§Component 8 step 1). Empty / absent → '' (no cost). This is the
 * single place the declaration JSON is rendered for estimation; each provider
 * path folds it in the way that matches its native count (tiktoken-encode it,
 * append to the Claude `system`, or char-estimate it in the fallback).
 */
function serializeDeclarations(decls: ProviderToolDecl[] | undefined): string {
  return decls && decls.length > 0 ? JSON.stringify(decls) : '';
}

/** HTTP status extracted from an SDK / network error, or null when unknown. */
function statusOf(err: unknown): number | null {
  return typeof err === 'object' &&
    err !== null &&
    typeof (err as { status?: unknown }).status === 'number'
    ? (err as { status: number }).status
    : null;
}

/** Serialize an arbitrary value to a length-bearing string for char counting. */
function serializedLength(value: unknown): number {
  return (typeof value === 'string' ? value : JSON.stringify(value ?? {})).length;
}

/**
 * Conservative character-based fallback (REQ-9.1 fallback path).
 *
 * Counts text parts plus tool parts (§Component 8, v3 §1b): a `tool_call`'s
 * serialized `arguments` and a `tool_result`'s serialized `content`. Without
 * this the fallback would undercount exactly the tool-heavy turns REQ-11.2 says
 * drive summarization. Images are counted via the flat `imageCount`. The
 * serialized tool-declaration JSON (§Component 8 step 1) is counted as raw
 * characters alongside message text.
 */
function fallbackTokens(
  list: CanonicalMessage[],
  imageCount: number,
  declarationsJson: string,
): number {
  let chars = declarationsJson.length;
  for (const message of list) {
    if (message.role === 'system') {
      chars += message.content.length;
      continue;
    }
    for (const part of message.parts) {
      if (part.type === 'text') chars += part.text.length;
      else if (part.type === 'tool_call')
        chars += part.name.length + serializedLength(part.arguments);
      else if (part.type === 'tool_result') chars += serializedLength(part.content);
    }
  }
  return Math.ceil(chars / 3) + FALLBACK_IMAGE_TOKENS * imageCount;
}

/**
 * Estimate the conversation's total prompt-token count.
 *
 * OpenAI-dialect (openai, gemini, openrouter): resolve the encoder,
 *   tiktoken-encode the flat string, add image tokens. Unknown model
 *   (resolveEncoder → null) → fallback heuristic. Always local — never a
 *   network call with the user's key.
 * Claude: race countTokens against a 5 s timeout. 401/403 → ProviderKeyRejectedError;
 *   5xx or timeout → fallback heuristic.
 */
export async function estimateTokens(args: EstimateTokensArgs): Promise<EstimateTokensResult> {
  const result = await estimate(args);

  logger.info('advisor cap-check', {
    modelId: args.modelId,
    providerId: args.adapter.id,
    source: result.source,
    tokens: result.tokens,
  });

  return result;
}

async function estimate(args: EstimateTokensArgs): Promise<EstimateTokensResult> {
  const { adapter, list, modelId, apiKey, imageCount } = args;
  const declarationsJson = serializeDeclarations(args.toolDeclarations);

  // Every non-Claude adapter speaks the OpenAI dialect (openai + the gemini /
  // openrouter compat subclasses, REQ-6.3 v6): flat-string prepareForTokenCount
  // counted locally — tiktoken when the encoder is known, heuristic otherwise.
  // Only Claude uses the provider-native (network) countTokens below.
  if (adapter.id !== 'claude') {
    const encoder = resolveEncoder(modelId);
    if (encoder === null) {
      return {
        tokens: fallbackTokens(list, imageCount, declarationsJson),
        source: 'fallback',
      };
    }
    // Lazy WASM load — only when an OpenAI cap-check actually runs.
    const { get_encoding } = await import('tiktoken');
    const flat = adapter.prepareForTokenCount(list, modelId) as string;
    // Tokenise the declaration JSON the same way as message text: append it to
    // the flat string so tiktoken counts it exactly (§Component 8 step 1).
    const flatWithDecls = declarationsJson ? `${flat}\n\n${declarationsJson}` : flat;
    const enc = get_encoding(encoder);
    let textTokens: number;
    try {
      textTokens = enc.encode(flatWithDecls).length;
    } finally {
      enc.free();
    }
    return {
      tokens: textTokens + imageCount * OPENAI_IMAGE_TOKENS,
      source: 'tiktoken',
    };
  }

  // Claude: provider-native countTokens with a 5 s timeout.
  const { system, messages } = adapter.prepareForTokenCount(list, modelId) as {
    system: string;
    messages: MessageParam[];
  };
  // Fold the declaration JSON into the counted input by appending it to the
  // system string, so countTokens prices it natively (§Component 8 step 1).
  const systemWithDecls = declarationsJson ? `${system}\n\n${declarationsJson}` : system;

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('countTokens timeout')),
      args.countTokensTimeoutMs ?? COUNT_TOKENS_TIMEOUT_MS,
    );
  });

  try {
    const counted = (await Promise.race([
      client.messages.countTokens({ model: modelId, system: systemWithDecls, messages }),
      timeout,
    ])) as { input_tokens: number };
    return { tokens: counted.input_tokens, source: 'countTokens' };
  } catch (err) {
    const status = statusOf(err);
    if (status === 401 || status === 403) {
      // Do NOT fall back on auth errors — surface PROVIDER_KEY_REJECTED so the
      // chat call is never attempted (REQ-9.1 auth-error short-circuit, REQ-6.7).
      throw new ProviderKeyRejectedError(status);
    }
    // 5xx or timeout → conservative fallback (the chat call is still allowed).
    logger.warn('advisor cap-check fell back to heuristic', {
      modelId,
      providerId: adapter.id,
      status,
    });
    return {
      tokens: fallbackTokens(list, imageCount, declarationsJson),
      source: 'fallback',
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

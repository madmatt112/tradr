// OpenAI provider adapter. Per design.md §Component 2 ("openai.ts").
//
// Stateless singleton constructed once at bootstrap with the shared
// ListModelsCache. Translates canonical messages into OpenAI's
// ChatCompletionMessageParam shape, streams completions as ProviderStreamEvents,
// and lists models (cached).
//
// The SDK client `timeout` is pinned to 600_000 ms (10 min) per design v4-5: the
// app-level timers (connect 15 s, inactivity 60 s, wall-clock 480 s) always fire
// first, so the SDK timeout is functionally disabled and never owns a failure
// code. Do NOT lower it.

import OpenAI from 'openai';
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat/completions/completions';

import { mapProviderError } from '../advisor.errors';

import type {
  CanonicalMessage,
  CanonicalPart,
  ProviderAdapter,
  ProviderId,
  ProviderModel,
  ProviderStreamArgs,
  ProviderStreamEvent,
  ProviderToolDecl,
} from './adapter';
import { selectPreferredModel } from './default-model';
import type { ListModelsCache } from './list-models-cache';

const SDK_TIMEOUT_MS = 600_000;

/**
 * REQ-6.4 initial default-model preference list. Maintained here (adapter
 * code) and updated when newer models ship. Exact ids win over prefix matches
 * so `gpt-4o` never resolves to `gpt-4o-mini`.
 */
const DEFAULT_MODEL_PREFERENCE = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'];

/** Nominal default saved when listModels is empty (probe timeout / outage). */
const NOMINAL_DEFAULT_MODEL = 'gpt-4o';

/**
 * Select the initial `defaultModel` for a first key-save (REQ-6.4): preference
 * list first, else the lexicographically-highest vision-capable `gpt-4*` id,
 * else the nominal default.
 */
export function selectDefaultOpenAIModel(models: ProviderModel[]): string {
  return selectPreferredModel(
    models,
    DEFAULT_MODEL_PREFERENCE,
    (m) => m.vision && m.id.toLowerCase().startsWith('gpt-4'),
    NOMINAL_DEFAULT_MODEL,
  );
}

/**
 * Hardcoded context windows / vision flags keyed by model-id prefix, used per
 * REQ-9.5 ONLY because the OpenAI `models.list()` payload advertises neither a
 * context window nor a vision capability. Do NOT widen this map (design
 * restriction): it is a fallback, not the source of truth.
 */
const FALLBACK_PREFIXES: { prefix: string; contextWindow: number; vision: boolean }[] = [
  { prefix: 'gpt-4o-mini', contextWindow: 128_000, vision: true },
  { prefix: 'gpt-4o', contextWindow: 128_000, vision: true },
  { prefix: 'gpt-4-turbo', contextWindow: 128_000, vision: true },
];

/**
 * Conservative tool-use (function calling) prefix fallback (REQ-2.1, §Component 2).
 * Read like `vision`: `true` for recognized function-calling families
 * (gpt-4o / gpt-4.1 / gpt-4-turbo), else `false`. The OpenAI list payload
 * advertises no tool-use capability flag, so there is no SDK source of truth —
 * this prefix set is the only signal. Fail-closed: an unrecognized id is
 * conversation-only until this list is updated, never fail-open (which would 500
 * on first tools request).
 */
const TOOL_USE_PREFIXES = ['gpt-4o', 'gpt-4.1', 'gpt-4-turbo'];

/**
 * Conservative context window (REQ-9.5) for a model whose context window is
 * advertised by neither the SDK nor the fallback map. A low floor fires the cap
 * early rather than letting an unknown model silently overflow upstream. Unknown
 * models are NOT assumed to support vision. Exported for the OpenAI-compatible
 * subclasses (gemini.ts, openrouter.ts).
 */
export const CONSERVATIVE_CONTEXT_WINDOW = 8_000;

const MEDIA_TYPE: Record<'png' | 'jpeg' | 'webp', string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

function partToContentPart(part: CanonicalPart): ChatCompletionContentPart {
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }
  if (part.type === 'image') {
    return {
      type: 'image_url',
      image_url: { url: `data:${MEDIA_TYPE[part.format]};base64,${part.dataBase64}` },
    };
  }
  // tool_call / tool_result are fanned out separately, not via this mapper.
  throw new Error(`partToContentPart: unexpected part type '${part.type}'`);
}

/**
 * Render a single part as flat text for token counting (prepareForTokenCount).
 * Tool parts serialize their payload so a tool-heavy turn estimates materially
 * higher than text-only (§Component 8); images collapse to a placeholder (the
 * real per-image cost is added separately by the cap-check via imageCount).
 */
function partToFlatText(part: CanonicalPart): string {
  if (part.type === 'text') return part.text;
  if (part.type === 'image') return '[image]';
  if (part.type === 'tool_call') {
    return `${part.name}(${JSON.stringify(part.arguments ?? {})})`;
  }
  // tool_result
  return toolResultContent(part.content);
}

/**
 * Map a provider-agnostic tool declaration → OpenAI `tools[]` entry. NON-STRICT
 * function calling (§Component 2): `function.parameters` is the flat draft-07
 * schema verbatim (optional fields preserved); we do NOT set `strict:true` nor
 * force `additionalProperties:false` / all-required.
 */
function toolDeclToOpenAI(decl: ProviderToolDecl): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: decl.name,
      description: decl.description,
      parameters: decl.inputJsonSchema,
    },
  };
}

/** Render a tool_result part's content as the `role:'tool'` message string. */
function toolResultContent(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

/**
 * Fan a single canonical assistant message's ordered parts out into OpenAI's
 * native sequence (REQ-2.4, REQ-2.5, §Component 2): `text` parts collapse onto
 * the assistant message's `content`; `tool_call` parts become `tool_calls` on
 * that same assistant message; each `tool_result` part becomes one
 * `role:'tool'` message carrying `tool_call_id`. A `tool_result` with
 * `status:'error'` (REQ-15.5) maps to a `role:'tool'` message whose content is
 * the error code + message — the model sees the failure as a tool outcome it can
 * adapt to.
 */
function fanOutAssistant(parts: CanonicalPart[], out: ChatCompletionMessageParam[]): void {
  let text = '';
  const toolCalls: ChatCompletionMessageToolCall[] = [];
  const toolMessages: ChatCompletionMessageParam[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      text += part.text;
    } else if (part.type === 'tool_call') {
      toolCalls.push({
        id: part.id,
        type: 'function',
        function: { name: part.name, arguments: JSON.stringify(part.arguments ?? {}) },
      });
    } else if (part.type === 'tool_result') {
      toolMessages.push({
        role: 'tool',
        tool_call_id: part.toolCallId,
        content: toolResultContent(part.content),
      });
    }
  }

  // One assistant message carries the turn's text + tool_calls; the matching
  // tool-result messages follow it so OpenAI's tool_call_id linkage holds.
  if (toolCalls.length > 0) {
    out.push({ role: 'assistant', content: text || null, tool_calls: toolCalls });
  } else {
    out.push({ role: 'assistant', content: text });
  }
  out.push(...toolMessages);
}

/**
 * OpenAI adapter — ALSO the base class for every OpenAI-compatible backend
 * (REQ-6.3 v6): `GeminiAdapter` (gemini.ts) and `OpenRouterAdapter`
 * (openrouter.ts) subclass it with their provider's base URL and their own
 * `toProviderModel` metadata mapping. The chat-completions translate /
 * token-count / streaming paths are dialect-level and inherited unchanged.
 */
export class OpenAIAdapter implements ProviderAdapter {
  readonly id: ProviderId = 'openai';

  /**
   * Base URL for the OpenAI-compatible endpoint. `undefined` = the SDK default
   * (api.openai.com, or the OPENAI_BASE_URL env var the SDK reads itself).
   * Subclasses pin their provider's compat endpoint via the constructor.
   */
  protected readonly baseURL: string | undefined;

  constructor(
    protected readonly cache: ListModelsCache,
    baseURL?: string,
  ) {
    this.baseURL = baseURL;
  }

  protected client(apiKey: string): OpenAI {
    return new OpenAI({
      apiKey,
      timeout: SDK_TIMEOUT_MS,
      ...(this.baseURL ? { baseURL: this.baseURL } : {}),
    });
  }

  /**
   * Map one raw `models.list()` entry to a ProviderModel, or `null` to omit it
   * from the list. Overridden per compat backend — each provider advertises
   * (or omits) capability metadata differently.
   *
   * OpenAI precedence (REQ-9.5): the list payload advertises no context window
   * or vision flag, so fall through to the prefix fallback map where it
   * matches, otherwise a conservative low floor with vision off. toolUse
   * (REQ-2.1): `true` only for recognized function-calling families;
   * fail-closed (`false`) on unrecognized ids, matching the `vision` default.
   */
  protected toProviderModel(m: OpenAI.Model): ProviderModel | null {
    const fallback = FALLBACK_PREFIXES.find((f) => m.id.startsWith(f.prefix));
    const toolUse = TOOL_USE_PREFIXES.some((p) => m.id.startsWith(p));
    return {
      id: m.id,
      displayName: m.id,
      contextWindow: fallback?.contextWindow ?? CONSERVATIVE_CONTEXT_WINDOW,
      vision: fallback?.vision ?? false,
      toolUse,
    };
  }

  async listModels(apiKey: string): Promise<ProviderModel[]> {
    return this.cache.get(this.id, apiKey, async () => {
      const page = await this.client(apiKey).models.list();
      const models: ProviderModel[] = [];
      for await (const m of page) {
        const mapped = this.toProviderModel(m);
        if (mapped) models.push(mapped);
      }
      return models;
    });
  }

  /**
   * Translate canonical messages → ChatCompletionMessageParam[] (system first).
   * A `user` message maps 1:1. An `assistant` message is fanned out (REQ-2.4,
   * REQ-2.5): its ordered `text`/`tool_call`/`tool_result` parts become one
   * assistant message (text + `tool_calls`) followed by one `role:'tool'`
   * message per result (see `fanOutAssistant`).
   */
  translate(list: CanonicalMessage[]): ChatCompletionMessageParam[] {
    const messages: ChatCompletionMessageParam[] = [];
    for (const message of list) {
      if (message.role === 'system') {
        messages.unshift({ role: 'system', content: message.content });
        continue;
      }
      if (message.role === 'assistant') {
        fanOutAssistant(message.parts, messages);
        continue;
      }
      messages.push({ role: 'user', content: message.parts.map(partToContentPart) });
    }
    return messages;
  }

  /**
   * Flat textual rendering of the conversation for tiktoken counting. Encoder
   * resolution lives in cap-check.ts (resolveEncoder); this adapter only
   * produces the string and never resolves the encoder.
   *
   * Tool parts are serialized into the flat string (§Component 8, v3 §1b): a
   * `tool_call`'s name + JSON arguments and a `tool_result`'s content. This is a
   * flat-string approximation — message-framing overhead (the `tool_calls` /
   * `role:'tool'` structure) is intentionally NOT modeled (accepted: the 0.75
   * trigger has a 0.20 margin to the 0.95 residual hard stop, and the estimator
   * is already a flat-string approximation for text/image).
   */
  prepareForTokenCount(list: CanonicalMessage[]): string {
    return list
      .map((message) => {
        if (message.role === 'system') {
          return `system: ${message.content}`;
        }
        const text = message.parts.map(partToFlatText).join('\n');
        return `${message.role}: ${text}`;
      })
      .join('\n\n');
  }

  async *streamChat(args: ProviderStreamArgs): AsyncIterable<ProviderStreamEvent> {
    const messages = args.messages as ChatCompletionMessageParam[];
    const tools = args.tools?.map(toolDeclToOpenAI);
    let stream;
    try {
      stream = await this.client(args.apiKey).chat.completions.create(
        {
          model: args.modelId,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(tools && tools.length > 0 ? { tools } : {}),
        },
        { signal: args.signal },
      );
    } catch (err) {
      throw mapProviderError(err);
    }

    // Delta accumulation (REQ-2.7): OpenAI streams a tool call's
    // `function.arguments` as fragments across chunks, keyed by
    // `delta.tool_calls[i].index`. The opening fragment carries `id`/`name`; the
    // rest carry only argument text. We accumulate per index and emit one
    // complete `tool_call` event when the choice closes (`finish_reason ===
    // 'tool_calls'`) or the stream ends.
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
    const flushToolCalls = function* (): Generator<ProviderStreamEvent> {
      for (const [, c] of toolCalls) {
        const args_ = c.args === '' ? {} : (JSON.parse(c.args) as unknown);
        yield { type: 'tool_call', id: c.id, name: c.name, arguments: args_ };
      }
      toolCalls.clear();
    };

    try {
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const delta = choice?.delta?.content;
        if (delta) {
          yield { type: 'token', delta };
        }
        if (choice?.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const existing = toolCalls.get(tc.index);
            if (existing) {
              existing.args += tc.function?.arguments ?? '';
            } else {
              toolCalls.set(tc.index, {
                id: tc.id ?? '',
                name: tc.function?.name ?? '',
                args: tc.function?.arguments ?? '',
              });
            }
          }
        }
        if (choice?.finish_reason === 'tool_calls') {
          yield* flushToolCalls();
        }
        if (chunk.usage) {
          yield {
            type: 'usage',
            promptTokens: chunk.usage.prompt_tokens ?? null,
            completionTokens: chunk.usage.completion_tokens ?? null,
          };
        }
      }
    } catch (err) {
      throw mapProviderError(err);
    }
    // Emit any tool calls still open at stream close (no explicit
    // `finish_reason:'tool_calls'` chunk was observed).
    yield* flushToolCalls();
    yield { type: 'done' };
  }
}

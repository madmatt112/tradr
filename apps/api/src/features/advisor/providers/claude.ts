// Anthropic (Claude) provider adapter. Per design.md §Component 2 ("claude.ts").
//
// Stateless singleton constructed once at bootstrap with the shared
// ListModelsCache. Translates canonical messages into Anthropic's MessageParam
// shape, streams completions as ProviderStreamEvents, and lists models (cached).
//
// The SDK client `timeout` is pinned to 600_000 ms (10 min) per design v4-5: the
// app-level timers (connect 15 s, inactivity 60 s, wall-clock 480 s) always fire
// first, so the SDK timeout is functionally disabled and never owns a failure
// code. Do NOT lower it.

import Anthropic from '@anthropic-ai/sdk';
import type {
  Base64ImageSource,
  MessageParam,
  ContentBlockParam,
  Tool,
} from '@anthropic-ai/sdk/resources/messages';

import type {
  CanonicalMessage,
  CanonicalPart,
  ProviderAdapter,
  ProviderModel,
  ProviderStreamArgs,
  ProviderStreamEvent,
  ProviderToolDecl,
} from './adapter';
import { selectPreferredModel } from './default-model';
import type { ListModelsCache } from './list-models-cache';

const SDK_TIMEOUT_MS = 600_000;

/**
 * REQ-6.4 initial default-model preference list — Opus versions newest-first,
 * then Sonnet. Maintained here (adapter code) and updated when newer models
 * ship. Matched case-insensitively as an id prefix so dated ids
 * (`claude-opus-4-8-20260210`) resolve.
 */
const DEFAULT_MODEL_PREFERENCE = [
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-sonnet-5',
  'claude-sonnet-4-7',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
];

/** Nominal default saved when listModels is empty (probe timeout / outage). */
const NOMINAL_DEFAULT_MODEL = 'claude-opus-4-8';

/**
 * Select the initial `defaultModel` for a first key-save (REQ-6.4): preference
 * list first, else the lexicographically-highest vision-capable id, else the
 * nominal default.
 */
export function selectDefaultClaudeModel(models: ProviderModel[]): string {
  return selectPreferredModel(
    models,
    DEFAULT_MODEL_PREFERENCE,
    (m) => m.vision,
    NOMINAL_DEFAULT_MODEL,
  );
}

/**
 * Hardcoded context windows / vision flags used per REQ-9.5 ONLY when the SDK
 * does not advertise a context window for a listed model. Do NOT widen this map
 * (design restriction): it is a fallback, not the source of truth.
 */
const FALLBACK_MODELS: Record<string, { contextWindow: number; vision: boolean }> = {
  'claude-opus-4-7': { contextWindow: 1_000_000, vision: true },
  'claude-opus-4-6': { contextWindow: 200_000, vision: true },
  'claude-sonnet-4-7': { contextWindow: 200_000, vision: true },
  'claude-sonnet-4-6': { contextWindow: 200_000, vision: true },
};

/**
 * Conservative tool-use (function calling) prefix fallback (REQ-2.1, §Component 2).
 * Read like `vision`: SDK capability metadata where advertised, else this prefix
 * fallback, else `false`. Fail-closed — an unrecognized id is conversation-only
 * until this list is updated, never fail-open (which would 500 on first tools
 * request). The Claude 3+/4+ families all support tool use.
 */
const TOOL_USE_PREFIXES = ['claude-opus-4', 'claude-sonnet-4', 'claude-haiku-4', 'claude-3'];

/**
 * Conservative context window (REQ-9.5) for a listed model whose context window
 * is advertised by neither the SDK nor the fallback map. A low floor fires the
 * cap early rather than letting small models silently overflow upstream.
 */
const CONSERVATIVE_CONTEXT_WINDOW = 8_000;

/** Anthropic-native shape produced by `translate` / `prepareForTokenCount`. */
interface AnthropicPayload {
  system: string;
  messages: MessageParam[];
}

const MEDIA_TYPE: Record<'png' | 'jpeg' | 'webp', Base64ImageSource['media_type']> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/** Map a text/image part to an Anthropic content block. */
function partToContentBlock(part: CanonicalPart): ContentBlockParam {
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }
  if (part.type === 'image') {
    return {
      type: 'image',
      source: { type: 'base64', media_type: MEDIA_TYPE[part.format], data: part.dataBase64 },
    };
  }
  // tool_call / tool_result are fanned out separately, not via this mapper.
  throw new Error(`partToContentBlock: unexpected part type '${part.type}'`);
}

/** Map a provider-agnostic tool declaration → Anthropic `tools[]` entry. */
function toolDeclToAnthropic(decl: ProviderToolDecl): Tool {
  return {
    name: decl.name,
    description: decl.description,
    input_schema: decl.inputJsonSchema as Tool.InputSchema,
  };
}

/**
 * Fan a single canonical assistant message's ordered parts out into the
 * provider-native alternating sequence (REQ-2.4, REQ-2.5, §Component 2): walk the
 * parts in order; flush accumulated `text`/`tool_use` blocks as an `assistant`
 * message at each tool-call→tool-result boundary, then emit the matching
 * `tool_result` blocks as a `user` message. Strict role alternation holds — never
 * two adjacent `user` messages. A `tool_result` part with `status:'error'` maps
 * to `is_error: true` (content = the error code + message).
 */
function fanOutAssistant(parts: CanonicalPart[], out: MessageParam[]): void {
  let assistantBlocks: ContentBlockParam[] = [];
  let resultBlocks: ContentBlockParam[] = [];

  const flushAssistant = () => {
    if (assistantBlocks.length > 0) {
      out.push({ role: 'assistant', content: assistantBlocks });
      assistantBlocks = [];
    }
  };
  const flushResults = () => {
    if (resultBlocks.length > 0) {
      out.push({ role: 'user', content: resultBlocks });
      resultBlocks = [];
    }
  };

  for (const part of parts) {
    if (part.type === 'tool_result') {
      // A tool_result closes the preceding assistant block group: flush the
      // assistant message first so the result rides on the following user message.
      flushAssistant();
      resultBlocks.push({
        type: 'tool_result',
        tool_use_id: part.toolCallId,
        is_error: part.status === 'error' ? true : undefined,
        content: toolResultContent(part.content),
      });
      continue;
    }
    // text / tool_call / image belong on the assistant message. A new assistant
    // block group begins after any pending tool_result user message is flushed.
    flushResults();
    if (part.type === 'tool_call') {
      assistantBlocks.push({
        type: 'tool_use',
        id: part.id,
        name: part.name,
        input: part.arguments,
      });
    } else {
      assistantBlocks.push(partToContentBlock(part));
    }
  }
  flushResults();
  flushAssistant();
}

/** Render a tool_result part's content as an Anthropic text block string. */
function toolResultContent(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly id = 'claude' as const;

  constructor(private readonly cache: ListModelsCache) {}

  private client(apiKey: string): Anthropic {
    return new Anthropic({ apiKey, timeout: SDK_TIMEOUT_MS });
  }

  async listModels(apiKey: string): Promise<ProviderModel[]> {
    return this.cache.get('claude', apiKey, async () => {
      const page = await this.client(apiKey).models.list();
      const models: ProviderModel[] = [];
      for await (const m of page) {
        const fallback = FALLBACK_MODELS[m.id];
        // Precedence (REQ-9.5): SDK-advertised value → hardcoded fallback map →
        // conservative low default. The fallback map is consulted per-model only
        // when the SDK does not advertise the field — it never blanket-overrides.
        const contextWindow =
          m.max_input_tokens ?? fallback?.contextWindow ?? CONSERVATIVE_CONTEXT_WINDOW;
        const vision = m.capabilities?.image_input?.supported ?? fallback?.vision ?? false;
        // toolUse (REQ-2.1): SDK capability metadata where advertised → conservative
        // prefix fallback → false. Fail-closed on unrecognized ids.
        const toolUse =
          (m.capabilities as { tool_use?: { supported?: boolean } } | undefined)?.tool_use
            ?.supported ?? TOOL_USE_PREFIXES.some((p) => m.id.startsWith(p));
        models.push({
          id: m.id,
          displayName: m.display_name,
          contextWindow,
          vision,
          toolUse,
        });
      }
      return models;
    });
  }

  /**
   * Translate canonical messages → Anthropic MessageParam[] + system string.
   * A `user` message maps 1:1. An `assistant` message is fanned out (REQ-2.4):
   * its ordered `text`/`tool_call`/`tool_result` parts become alternating
   * `assistant`/`user` provider messages (see `fanOutAssistant`).
   */
  translate(list: CanonicalMessage[]): AnthropicPayload {
    let system = '';
    const messages: MessageParam[] = [];
    for (const message of list) {
      if (message.role === 'system') {
        system = message.content;
        continue;
      }
      if (message.role === 'assistant') {
        fanOutAssistant(message.parts, messages);
        continue;
      }
      messages.push({
        role: 'user',
        content: message.parts.map(partToContentBlock),
      });
    }
    return { system, messages };
  }

  /**
   * Routes through the fan-out `translate` (§Component 8, v3 §1b), so the
   * countTokens input carries the real provider shape — `tool_use` blocks and
   * `tool_result` user messages — and tool-heavy turns are counted at their true
   * size, not undercounted to text-only. No separate tool-part handling needed.
   */
  prepareForTokenCount(list: CanonicalMessage[]): AnthropicPayload {
    return this.translate(list);
  }

  async *streamChat(args: ProviderStreamArgs): AsyncIterable<ProviderStreamEvent> {
    const { system, messages } = args.messages as AnthropicPayload;
    const tools = args.tools?.map(toolDeclToAnthropic);
    const stream = this.client(args.apiKey).messages.stream(
      {
        model: args.modelId,
        system,
        messages,
        max_tokens: 4096,
        ...(tools && tools.length > 0 ? { tools } : {}),
      },
      { signal: args.signal },
    );

    let promptTokens: number | null = null;
    // Delta accumulation (REQ-2.7): a `content_block_start type:'tool_use'` opens
    // a tool-use block at `index`; its `input_json_delta.partial_json` fragments
    // are concatenated until `content_block_stop`, then emitted as one complete
    // `tool_call` event with parsed JSON arguments.
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();

    for await (const event of stream) {
      if (event.type === 'message_start') {
        promptTokens = event.message.usage.input_tokens;
      } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        toolBlocks.set(event.index, {
          id: event.content_block.id,
          name: event.content_block.name,
          json: '',
        });
      } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'token', delta: event.delta.text };
      } else if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
        const block = toolBlocks.get(event.index);
        if (block) block.json += event.delta.partial_json;
      } else if (event.type === 'content_block_stop') {
        const block = toolBlocks.get(event.index);
        if (block) {
          toolBlocks.delete(event.index);
          // Anthropic sends `partial_json:""` for a no-argument tool; treat empty
          // accumulation as `{}`.
          const args_ = block.json === '' ? {} : (JSON.parse(block.json) as unknown);
          yield { type: 'tool_call', id: block.id, name: block.name, arguments: args_ };
        }
      } else if (event.type === 'message_delta') {
        yield {
          type: 'usage',
          promptTokens,
          completionTokens: event.usage.output_tokens ?? null,
        };
      } else if (event.type === 'message_stop') {
        yield { type: 'done' };
      }
    }
  }
}

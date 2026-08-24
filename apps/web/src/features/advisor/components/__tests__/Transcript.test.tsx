// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '@tradr/shared/schemas/advisor';

// eslint-disable-next-line import-x/order -- import-x/order miscounts groups in this file because the component import is intentionally placed after vi.mock() (hoisting).
import type {
  BillingMode,
  PendingUserMessage,
  StreamState,
  ToolActivity,
} from '../../stores/stream.store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// useConversation (Task 32) is mocked: the detail query feeds persisted-message
// fixtures. The stream store is mocked so the selector reads a controllable
// per-conversation slice without driving the real Zustand store.
let conversationMessages: Message[] = [];
vi.mock('../../hooks/useConversations', () => ({
  useConversation: () => ({ data: { messages: conversationMessages } }),
}));

let streamSlice: StreamState = { kind: 'idle' };
let toolSlice: ToolActivity[] = [];
let billingModeSlice: BillingMode | undefined;
let userMessageSlice: PendingUserMessage | undefined;
// The component calls useStreamStore(useShallow(selector)); apply the selector
// to a state object exposing the single conversation's slice + tool activity +
// billing-mode disclosure + pending user message (matching the real store's
// initial shape).
vi.mock('../../stores/stream.store', () => ({
  useStreamStore: (
    selector: (s: {
      byConversation: Record<string, StreamState>;
      toolsByConversation: Record<string, ToolActivity[]>;
      billingModeByConversation: Record<string, BillingMode>;
      userMessageByConversation: Record<string, PendingUserMessage>;
    }) => unknown,
  ) =>
    selector({
      byConversation: { [CID]: streamSlice },
      toolsByConversation: { [CID]: toolSlice },
      billingModeByConversation: billingModeSlice ? { [CID]: billingModeSlice } : {},
      userMessageByConversation: userMessageSlice ? { [CID]: userMessageSlice } : {},
    }),
}));
vi.mock('zustand/shallow', () => ({
  useShallow: <T,>(selector: T) => selector,
}));

import { Transcript } from '../Transcript';

const CID = 'conv-1';

function textMessage(
  over: Partial<Message> & { id: string; role: Message['role']; text: string },
): Message {
  return {
    id: over.id,
    conversationId: CID,
    role: over.role,
    contentParts: [{ type: 'text', text: over.text }],
    promptTokens: null,
    completionTokens: null,
    clientMessageId: null,
    createdAt: new Date().toISOString(),
  };
}

function partsMessage(id: string, contentParts: Message['contentParts']): Message {
  return {
    id,
    conversationId: CID,
    role: 'assistant',
    contentParts,
    promptTokens: null,
    completionTokens: null,
    clientMessageId: null,
    createdAt: new Date().toISOString(),
  };
}

// User uploads carry the image parts (attachments), so image render is exercised
// on user messages.
function userPartsMessage(id: string, contentParts: Message['contentParts']): Message {
  return {
    id,
    conversationId: CID,
    role: 'user',
    contentParts,
    promptTokens: null,
    completionTokens: null,
    clientMessageId: null,
    createdAt: new Date().toISOString(),
  };
}

let mounted: { container: HTMLElement; root: Root } | null = null;
function mount(ui: React.ReactElement): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted = { container, root };
  act(() => root.render(ui));
}

beforeEach(() => {
  conversationMessages = [];
  streamSlice = { kind: 'idle' };
  toolSlice = [];
  billingModeSlice = undefined;
  userMessageSlice = undefined;
});

afterEach(() => {
  if (mounted) {
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
});

describe('Transcript chat bubbles', () => {
  it('puts you on the left and the advisor on the right, moving the bubble not the text', () => {
    conversationMessages = [
      textMessage({ id: 'u1', role: 'user', text: 'question' }),
      textMessage({ id: 'a1', role: 'assistant', text: 'answer' }),
    ];
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);

    const userBubble = document.querySelector('[data-role="user"]')!;
    const assistantBubble = document.querySelector('[data-role="assistant"]')!;

    // The row (bubble → stack → row) is what carries the side. The bubble
    // itself never sets text-alignment, so wrapped lines stay left-read on
    // both sides.
    expect(userBubble.parentElement!.parentElement!.className).toContain('justify-start');
    expect(assistantBubble.parentElement!.parentElement!.className).toContain('justify-end');
    expect(userBubble.className).not.toContain('text-right');
    expect(assistantBubble.className).not.toContain('text-right');

    // Distinct fills, so the speakers are told apart by colour as well as
    // side. The desk re-skin keeps both NEUTRAL: the user speaks on the
    // secondary surface (amber never encodes data), the advisor on a hairline
    // card — neither ever wears the accent.
    expect(userBubble.className).toContain('bg-secondary');
    expect(assistantBubble.className).toContain('bg-card');
    expect(userBubble.className).not.toContain('bg-primary');
    expect(assistantBubble.className).not.toContain('bg-primary');
  });

  it("summarises an answer's tool calls as a cites row, one chip per distinct tool", () => {
    conversationMessages = [
      partsMessage('a1', [
        { type: 'text', text: 'answer' },
        { type: 'tool_call', id: 'c1', name: 'get_positions', arguments: {} },
        { type: 'tool_result', toolCallId: 'c1', status: 'ok', content: {} },
        // The same tool called twice collapses to one chip.
        { type: 'tool_call', id: 'c2', name: 'get_positions', arguments: {} },
        { type: 'tool_result', toolCallId: 'c2', status: 'ok', content: {} },
      ]),
    ];
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);

    const row = document.querySelector('[data-testid="cites-row"]')!;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain('used:');
    // Underscores humanised; duplicates collapsed.
    expect(row.textContent?.match(/get positions/g)).toHaveLength(1);
  });

  it('renders no cites row for an answer that called no tools', () => {
    conversationMessages = [textMessage({ id: 'a1', role: 'assistant', text: 'answer' })];
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);
    expect(document.querySelector('[data-testid="cites-row"]')).toBeNull();
  });

  it('labels each bubble with its speaker, on that speaker’s side', () => {
    conversationMessages = [
      textMessage({ id: 'u1', role: 'user', text: 'question' }),
      textMessage({ id: 'a1', role: 'assistant', text: 'answer' }),
    ];
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);

    const userLabel = document.querySelector('[data-role="user"]')!.previousElementSibling!;
    const assistantLabel =
      document.querySelector('[data-role="assistant"]')!.previousElementSibling!;

    expect(userLabel.textContent).toBe('Me');
    expect(assistantLabel.textContent).toBe('Advisor');
    // Each nametag hugs the edge its bubble sits on.
    expect(userLabel.className).toContain('text-left');
    expect(assistantLabel.className).toContain('text-right');
  });

  it('constrains bubbles so wide content scrolls inside instead of stretching them', () => {
    conversationMessages = [textMessage({ id: 'a1', role: 'assistant', text: 'answer' })];
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);

    const bubble = document.querySelector('[data-role="assistant"]')!;
    // Without min-w-0 a flex item refuses to shrink below its content, and a
    // wide table or code block would push the whole transcript sideways. The
    // width cap lives on the stack, which wraps the nametag and the bubble.
    expect(bubble.className).toContain('min-w-0');
    expect(bubble.parentElement!.className).toContain('min-w-0');
    expect(bubble.parentElement!.className).toContain('max-w-[85%]');
  });

  it('bubbles and labels the in-flight stream entry like a persisted reply', () => {
    conversationMessages = [];
    streamSlice = { kind: 'streaming', text: 'thinking' };
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);

    const entry = document.querySelector('[data-testid="stream-entry"]')!;
    expect(entry.className).toContain('bg-card');
    expect(entry.previousElementSibling!.textContent).toBe('Advisor');
    expect(entry.parentElement!.parentElement!.className).toContain('justify-end');
  });
});

describe('Transcript', () => {
  it('renders user messages as plain text, not Markdown', () => {
    conversationMessages = [textMessage({ id: 'u1', role: 'user', text: '**not bold**' })];
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);

    const userEl = document.querySelector('[data-role="user"]')!;
    // The literal asterisks survive; no <strong> is produced for user text.
    expect(userEl.textContent).toBe('**not bold**');
    expect(userEl.querySelector('strong')).toBeNull();
  });

  it('renders assistant messages as Markdown', () => {
    conversationMessages = [textMessage({ id: 'a1', role: 'assistant', text: 'hello **world**' })];
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);

    const assistantEl = document.querySelector('[data-role="assistant"]')!;
    const strong = assistantEl.querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe('world');
  });

  it('sanitises inline HTML in assistant Markdown (no live markup)', () => {
    conversationMessages = [
      textMessage({ id: 'a2', role: 'assistant', text: 'safe <img src=x onerror=alert(1)> text' }),
    ];
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);

    const assistantEl = document.querySelector('[data-role="assistant"]')!;
    // rehype-sanitize (no rehype-raw) strips the raw <img>; it must not become
    // a live element in the DOM.
    expect(assistantEl.querySelector('img')).toBeNull();
    expect(assistantEl.textContent).toContain('safe');
    expect(assistantEl.textContent).toContain('text');
  });

  it('shows the error placeholder + retry button and fires onRetry', () => {
    streamSlice = { kind: 'error', text: 'partial answer', errorCode: 'STREAM_TIMEOUT' };
    const onRetry = vi.fn();
    mount(<Transcript conversationId={CID} onRetry={onRetry} />);

    expect(document.body.textContent).toContain('Response interrupted — retry?');
    // The partial streamed text stays visible alongside the retry control.
    expect(document.body.textContent).toContain('partial answer');

    const retry = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Retry',
    )!;
    act(() => retry.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders an assistant turn parts in order: text, tool_call, tool_result', () => {
    conversationMessages = [
      partsMessage('a1', [
        { type: 'text', text: 'before' },
        {
          type: 'tool_call',
          id: 'c1',
          name: 'market_data_stock_quote',
          arguments: { symbol: 'AAPL' },
        },
        {
          type: 'tool_result',
          toolCallId: 'c1',
          status: 'ok',
          content: { symbol: 'AAPL', last: 1 },
        },
        { type: 'text', text: 'after' },
      ]),
    ];
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);

    const assistant = document.querySelector('[data-role="assistant"]')!;
    const order = assistant.textContent ?? '';
    expect(order.indexOf('before')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('before')).toBeLessThan(order.indexOf('Called market_data_stock_quote'));
    expect(order.indexOf('Called market_data_stock_quote')).toBeLessThan(order.indexOf('after'));
    // market_data_* result → MarketDataCard.
    expect(assistant.querySelector('[data-testid="market-data-card"]')).not.toBeNull();
    expect(order).toContain('Market data — AAPL');
  });

  it('renders a tool-only assistant turn as cards on reload, not an empty bubble', () => {
    conversationMessages = [
      partsMessage('a1', [
        { type: 'tool_call', id: 'c1', name: 'trade_data_open_positions', arguments: {} },
        {
          type: 'tool_result',
          toolCallId: 'c1',
          status: 'ok',
          content: { count: 3, positions: [] },
        },
      ]),
    ];
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);

    const assistant = document.querySelector('[data-role="assistant"]')!;
    expect(assistant.querySelector('[data-testid="trade-data-card"]')).not.toBeNull();
    expect(assistant.textContent).toContain('Your trade data — 3 record(s)');
    // Not an empty bubble.
    expect(assistant.textContent?.trim().length).toBeGreaterThan(0);
  });

  it('falls back to GenericToolCard for an unknown tool name', () => {
    conversationMessages = [
      partsMessage('a1', [
        { type: 'tool_call', id: 'c1', name: 'mystery_tool', arguments: {} },
        { type: 'tool_result', toolCallId: 'c1', status: 'ok', content: { whatever: true } },
      ]),
    ];
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);

    const assistant = document.querySelector('[data-role="assistant"]')!;
    expect(assistant.querySelector('[data-testid="generic-tool-card"]')).not.toBeNull();
    expect(assistant.querySelector('[data-testid="market-data-card"]')).toBeNull();
  });

  it('does not crash on an unexpected/circular tool_result shape', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    conversationMessages = [
      partsMessage('a1', [
        { type: 'tool_result', toolCallId: 'c1', status: 'ok', content: circular },
      ]),
    ];
    expect(() => mount(<Transcript conversationId={CID} onRetry={vi.fn()} />)).not.toThrow();
    expect(document.querySelector('[data-testid="generic-tool-card"]')).not.toBeNull();
  });

  it('renders an error tool_result with clear, non-alarming copy', () => {
    conversationMessages = [
      partsMessage('a1', [
        { type: 'tool_call', id: 'c1', name: 'market_data_stock_quote', arguments: {} },
        {
          type: 'tool_result',
          toolCallId: 'c1',
          status: 'error',
          content: { code: 'MARKET_DATA_UNAVAILABLE', message: 'boom' },
        },
      ]),
    ];
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);

    const assistant = document.querySelector('[data-role="assistant"]')!;
    expect(assistant.textContent).toContain('Market data is temporarily unavailable.');
    // Raw upstream detail is not leaked.
    expect(assistant.textContent).not.toContain('boom');
  });

  it('shows an inline "Calling {tool}…" affordance from streamed tool activity', () => {
    streamSlice = { kind: 'streaming', text: '' };
    toolSlice = [
      { id: 'c1', name: 'market_data_stock_quote', argumentsPreview: '{}', status: 'pending' },
    ];
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);

    expect(document.body.textContent).toContain('Calling market_data_stock_quote…');
  });

  it('renders an inline image part as a data: URL', () => {
    conversationMessages = [
      userPartsMessage('u1', [{ type: 'image', format: 'png', dataBase64: 'AAAA' }]),
    ];
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);

    const img = document.querySelector('[data-role="user"] img')!;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(img.getAttribute('crossorigin')).toBeNull();
  });

  it('renders an object-pointer image via the proxy, keyed by conversation/message/index, no crossOrigin same-origin', () => {
    delete window.__TRADR_CONFIG__;
    conversationMessages = [
      userPartsMessage('u1', [
        { type: 'text', text: 'chart' },
        { type: 'image', format: 'png', storage: 'object' },
      ]),
    ];
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);

    const img = document.querySelector('[data-role="user"] img')!;
    // Index 1 = the image's position in the full contentParts array (matches the
    // server-side proxy index). The object key is NEVER in the URL.
    expect(img.getAttribute('src')).toBe('/api/advisor/conversations/conv-1/messages/u1/images/1');
    expect(img.getAttribute('crossorigin')).toBeNull();
  });

  it('sets crossOrigin=use-credentials on the proxy image only when the API is cross-origin', () => {
    window.__TRADR_CONFIG__ = { apiBaseUrl: 'https://api.example.com' };
    conversationMessages = [
      userPartsMessage('u1', [{ type: 'image', format: 'jpeg', storage: 'object' }]),
    ];
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);

    const img = document.querySelector('[data-role="user"] img')!;
    expect(img.getAttribute('src')).toBe(
      'https://api.example.com/advisor/conversations/conv-1/messages/u1/images/0',
    );
    expect(img.getAttribute('crossorigin')).toBe('use-credentials');
    delete window.__TRADR_CONFIG__;
  });

  it('renders an unrecoverable image as a non-crashing placeholder, never a broken <img>', () => {
    conversationMessages = [
      userPartsMessage('u1', [{ type: 'image', format: 'png', storage: 'unrecoverable' }]),
    ];
    expect(() => mount(<Transcript conversationId={CID} onRetry={vi.fn()} />)).not.toThrow();

    const user = document.querySelector('[data-role="user"]')!;
    expect(user.querySelector('img')).toBeNull();
    const placeholder = user.querySelector('[data-testid="image-unavailable"]')!;
    expect(placeholder).not.toBeNull();
    expect(placeholder.textContent).toContain('Image no longer available');
  });

  it('renders a conversation mixing all three image states with no broken img or exception', () => {
    delete window.__TRADR_CONFIG__;
    conversationMessages = [
      userPartsMessage('u1', [
        { type: 'text', text: 'here are three' },
        { type: 'image', format: 'png', dataBase64: 'BBBB' },
        { type: 'image', format: 'webp', storage: 'object' },
        { type: 'image', format: 'png', storage: 'unrecoverable' },
      ]),
    ];
    expect(() => mount(<Transcript conversationId={CID} onRetry={vi.fn()} />)).not.toThrow();

    const user = document.querySelector('[data-role="user"]')!;
    const imgs = user.querySelectorAll('img');
    // Exactly two <img> (inline + proxy); the unrecoverable part is a placeholder.
    expect(imgs.length).toBe(2);
    // Inline (index 1) → data: URL; format png with payload BBBB.
    expect(imgs[0]!.getAttribute('src')).toBe('data:image/png;base64,BBBB');
    // Proxy image is at index 2 in contentParts.
    expect(imgs[1]!.getAttribute('src')).toBe(
      '/api/advisor/conversations/conv-1/messages/u1/images/2',
    );
    expect(user.querySelector('[data-testid="image-unavailable"]')).not.toBeNull();
    // No <img> ever points at an undefined/bytes-less source.
    for (const img of Array.from(imgs)) {
      expect(img.getAttribute('src')).toBeTruthy();
      expect(img.getAttribute('src')).not.toContain('undefined');
    }
  });

  it('hands off from the streamed entry to the persisted message by messageId', () => {
    // done slice references a messageId not yet in the cache → live text shown.
    streamSlice = { kind: 'done', text: 'streamed reply', messageId: 'a9' };
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);
    expect(document.querySelector('[data-testid="stream-entry"]')).not.toBeNull();
    expect(document.body.textContent).toContain('streamed reply');

    // Once the persisted message with that id arrives, the live entry is gone.
    act(() => mounted!.root.unmount());
    mounted = null;
    conversationMessages = [textMessage({ id: 'a9', role: 'assistant', text: 'persisted reply' })];
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);
    expect(document.querySelector('[data-testid="stream-entry"]')).toBeNull();
    expect(document.body.textContent).toContain('persisted reply');
  });
});

describe('Transcript — in-flight turn', () => {
  const sent: PendingUserMessage = {
    clientMessageId: 'cm-1',
    text: 'what is my win rate?',
    attachments: [],
  };
  const activity = () => document.querySelector('[data-testid="stream-activity"]');

  it('shows the sent message and a thinking indicator before any frame arrives', () => {
    streamSlice = { kind: 'pending' };
    userMessageSlice = sent;
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);

    const pending = document.querySelector('[data-testid="pending-user-message"]')!;
    expect(pending.textContent).toBe('what is my win rate?');
    // Same side and label as a persisted user message.
    expect(pending.parentElement!.parentElement!.className).toContain('justify-start');
    expect(pending.previousElementSibling!.textContent).toBe('Me');
    expect(document.querySelector('[data-testid="stream-entry"]')).not.toBeNull();
    expect(activity()!.textContent).toContain('Thinking…');
  });

  it('labels the indicator by what the advisor is doing: tools → Working, tokens → Responding', () => {
    streamSlice = { kind: 'pending' };
    userMessageSlice = sent;
    toolSlice = [
      { id: 'tc-1', name: 'trade_data_stats', argumentsPreview: '{}', status: 'pending' },
    ];
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);
    expect(activity()!.textContent).toContain('Working…');

    act(() => mounted!.root.unmount());
    mounted = null;
    streamSlice = { kind: 'streaming', text: 'Your win rate' };
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);
    expect(document.body.textContent).toContain('Your win rate');
    expect(activity()!.textContent).toContain('Responding…');
  });

  it('renders submitted image attachments inline on the pending message', () => {
    streamSlice = { kind: 'pending' };
    userMessageSlice = {
      ...sent,
      attachments: [{ format: 'png', dataBase64: 'iVBORw0KGgo=' }],
    };
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);

    const img = document.querySelector('[data-testid="pending-user-message"] img')!;
    expect(img.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  it('offers a retry with no-response copy when the turn failed before any output', () => {
    streamSlice = { kind: 'error', text: '', errorCode: 'INSUFFICIENT_CREDITS' };
    userMessageSlice = sent;
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);

    expect(document.querySelector('[data-testid="pending-user-message"]')).not.toBeNull();
    expect(document.body.textContent).toContain('No response — retry?');
    expect(activity()).toBeNull();
  });

  it('hides the indicator once the turn is done, before the persisted copy lands', () => {
    streamSlice = { kind: 'done', text: 'final', messageId: 'a9' };
    userMessageSlice = sent;
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);

    expect(document.querySelector('[data-testid="stream-entry"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="pending-user-message"]')).not.toBeNull();
    expect(activity()).toBeNull();
  });

  it('drops the pending pair together once the persisted turn is in the cache', () => {
    streamSlice = { kind: 'done', text: 'final', messageId: 'a9' };
    userMessageSlice = sent;
    conversationMessages = [
      textMessage({ id: 'u9', role: 'user', text: 'what is my win rate?' }),
      textMessage({ id: 'a9', role: 'assistant', text: 'final' }),
    ];
    mount(<Transcript conversationId={CID} onRetry={vi.fn()} />);

    expect(document.querySelector('[data-testid="pending-user-message"]')).toBeNull();
    expect(document.querySelector('[data-testid="stream-entry"]')).toBeNull();
    // Exactly one copy of each side of the turn.
    expect(document.querySelectorAll('[data-role="user"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-role="assistant"]')).toHaveLength(1);
  });
});
